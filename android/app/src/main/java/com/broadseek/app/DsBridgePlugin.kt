package com.broadseek.app

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSource
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * BroadSeek 原生 HTTP 桥。
 *
 * 由于 chat.deepseek.com 的 WAF 会拦截 WebView 内的跨域预检（CORS），
 * 所有请求都不能直接用 WebView fetch，必须走原生网络栈。
 *
 * 提供两个方法：
 *  - request(method, url, headers, body): 普通 JSON 请求，返回完整响应体
 *  - startSse(method, url, headers, body): SSE 流式请求，逐行解析并通过 DsEvent 无线程安全地回传 JS
 *  - stopSse(requestKey): 取消进行中的 SSE 请求
 */
@CapacitorPlugin(name = "DsBridge")
class DsBridgePlugin : Plugin() {
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // 无限读超时：SSE 长连接
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    // 进行中的 SSE 请求，key 由 JS 侧传入以支持取消
    private val activeSse = ConcurrentHashMap<String, Call>()

    companion object {
        private const val TAG = "DsBridge"
    }

    /**
     * 插件加载时注册 Activity 生命周期监听：
     * 应用回前台/退后台时通过 appState 事件通知 JS（对齐 @capacitor/app 的 appStateChange），
     * 供聊天页「回到前台异步同步会话数据 + 恢复其他端仍在生成的 WIP 消息流」使用。
     */
    override fun load() {
        super.load()
        val app = bridge?.activity?.application ?: return
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                if (activity === bridge?.activity) notifyListeners("appState", JSObject().put("isActive", true))
            }

            override fun onActivityPaused(activity: Activity) {
                if (activity === bridge?.activity) notifyListeners("appState", JSObject().put("isActive", false))
            }

            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityDestroyed(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        })
    }

    private fun buildRequest(method: String, url: String, headers: Map<String, String>?, body: String?): Request {
        val builder = Request.Builder().url(url)
        headers?.forEach { (k, v) -> builder.header(k, v) }
        val m = method.uppercase()
        if (body != null) {
            // OkHttp 要求 POST/PUT/PATCH 必须带 body：先设 body 再设 method
            val mediaType = "application/json; charset=utf-8".toMediaType()
            val reqBody: RequestBody = body.toRequestBody(mediaType)
            builder.method(m, reqBody)
        } else {
            // GET/HEAD/DELETE 不允许带 body
            builder.method(m, null)
        }
        return builder.build()
    }

    private fun headersToMap(call: PluginCall): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        call.getObject("headers")?.keys()?.forEach { k ->
            call.getObject("headers")?.optString(k)?.let { v -> out[k] = v }
        }
        return out
    }

    /**
     * 普通 JSON 请求。返回 { status, data, headers }。
     * data 尝试按 JSON 解析，失败则返回原始字符串。
     */
    @PluginMethod
    fun request(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("missing url")
        val method = call.getString("method") ?: "GET"
        val body = call.getString("body")
        val headers = headersToMap(call)

        val req = buildRequest(method, url, headers, body)
        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(httpCall: Call, exc: java.io.IOException) {
                call.reject("network error: ${exc.message}", "NETWORK", exc)
            }

            override fun onResponse(httpCall: Call, response: Response) {
                try {
                    val respBody = response.body?.string() ?: ""
                    val result = JSObject()
                    result.put("status", response.code)
                    // 优先 JSON，非 JSON 保底原始字符串
                    val parsed = runCatching { JSONObject(respBody) }.getOrNull()
                    if (parsed != null) {
                        result.put("data", JSObject(parsed.toString()))
                    } else {
                        result.put("data", respBody)
                    }
                    val h = JSObject()
                    response.headers.forEach { (k, v) -> h.put(k, v) }
                    result.put("headers", h)
                    call.resolve(result)
                } catch (e: Exception) {
                    call.reject("parse error: ${e.message}", "PARSE", e)
                } finally {
                    response.close()
                }
            }
        })
    }

    /**
     * 二进制请求（图片等）。返回 { status, data: base64, mimeType, headers }。
     * 用于走 OkHttp 带伪装头（Referer/UA）加载文件服务图片，绕过 WebView 跨域/WAF 拦截。
     */
    @PluginMethod
    fun requestBinary(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("missing url")
        val method = call.getString("method") ?: "GET"
        val body = call.getString("body")
        val headers = headersToMap(call)

        val req = buildRequest(method, url, headers, body)
        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(httpCall: Call, exc: java.io.IOException) {
                call.reject("network error: ${exc.message}", "NETWORK", exc)
            }

            override fun onResponse(httpCall: Call, response: Response) {
                try {
                    val bytes = response.body?.bytes()
                    val result = JSObject()
                    result.put("status", response.code)
                    if (bytes != null) {
                        result.put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                    }
                    result.put("mimeType", response.header("content-type") ?: "application/octet-stream")
                    val h = JSObject()
                    response.headers.forEach { (k, v) -> h.put(k, v) }
                    result.put("headers", h)
                    call.resolve(result)
                } catch (e: Exception) {
                    call.reject("binary error: ${e.message}", "PARSE", e)
                } finally {
                    response.close()
                }
            }
        })
    }

    /**
     * SSE 流式请求。逐行解析 "data: {...}"，每条通过 notifyListeners("sseEvent", ...) 回传。
     * 流结束或出错时回传 { type: "end" } / { type: "error", message }。
     */
    @PluginMethod
    fun startSse(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("missing url")
        val method = call.getString("method") ?: "POST"
        val body = call.getString("body")
        val headers = headersToMap(call)
        val key = call.getString("key") ?: (url + System.nanoTime())

        val req = buildRequest(method, url, headers, body)
        val httpCall = client.newCall(req)
        activeSse[key] = httpCall

        httpCall.enqueue(object : Callback {
            override fun onFailure(httpCall: Call, exc: java.io.IOException) {
                activeSse.remove(key)
                val ev = JSObject()
                ev.put("type", "error")
                ev.put("key", key)
                ev.put("message", exc.message ?: "network error")
                notifyListeners("sseEvent", ev)
                call.reject("network error: ${exc.message}", "NETWORK", exc)
            }

            override fun onResponse(httpCall: Call, response: Response) {
                try {
                    if (!response.isSuccessful) {
                        val errBody = response.body?.string() ?: ""
                        val ev = JSObject()
                        ev.put("type", "error")
                        ev.put("key", key)
                        ev.put("status", response.code)
                        ev.put("message", "HTTP ${response.code}: $errBody")
                        notifyListeners("sseEvent", ev)
                        call.reject("HTTP ${response.code}", "HTTP")
                        activeSse.remove(key)
                        return
                    }
                    val ctype = response.header("content-type") ?: ""
                    if (ctype.contains("text/event-stream")) {
                        parseSse(response.body?.source(), key, call)
                    } else {
                        // 非 SSE 响应（如 resume_stream 命中"消息已完整"返回 JSON 封套）：
                        // 整包作为单条 data 事件回传，由 JS 侧统一解析；正常流式不受影响
                        val body = response.body?.string() ?: ""
                        if (body.isNotEmpty()) {
                            val ev = JSObject()
                            ev.put("type", "data")
                            ev.put("key", key)
                            ev.put("payload", body)
                            notifyListeners("sseEvent", ev)
                        }
                        finishSse(key, call)
                    }
                } catch (e: Exception) {
                    val ev = JSObject()
                    ev.put("type", "error")
                    ev.put("key", key)
                    ev.put("message", e.message ?: "sse parse error")
                    notifyListeners("sseEvent", ev)
                    call.reject("sse error: ${e.message}", "SSE", e)
                    activeSse.remove(key)
                }
            }
        })
    }

    private fun parseSse(source: BufferedSource?, key: String, call: PluginCall) {
        if (source == null) {
            finishSse(key, call)
            return
        }
        try {
            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                val trimmed = line.trim()
                if (trimmed.startsWith("data:")) {
                    val payload = trimmed.substring(5).trim()
                    if (payload.isEmpty() || payload == "[DONE]") continue
                    val ev = JSObject()
                    ev.put("type", "data")
                    ev.put("key", key)
                    ev.put("payload", payload)
                    notifyListeners("sseEvent", ev)
                }
            }
        } catch (e: Exception) {
            // 连接中断（用户取消/超时）视为正常结束
        }
        finishSse(key, call)
    }

    private fun finishSse(key: String, call: PluginCall) {
        activeSse.remove(key)
        val ev = JSObject()
        ev.put("type", "end")
        ev.put("key", key)
        notifyListeners("sseEvent", ev)
        call.resolve()
    }

    /** 取消进行中的 SSE 请求 */
    @PluginMethod
    fun stopSse(call: PluginCall) {
        val key = call.getString("key") ?: return call.resolve()
        activeSse.remove(key)?.cancel()
        call.resolve()
    }
}