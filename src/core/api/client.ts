// DeepSeek Web API 客户端
// 端点对齐 raw-api-reference.md，信封统一解包

import type { ChatFile, ChatFragmentType, ChatMessage, ChatSession, NormalizedMessage } from './types';
import { makePowHeader } from './pow';
import type { PowChallenge } from './pow';
import { DsBridge, type DsSseEvent } from './nativeBridge';
import type { PluginListenerHandle } from '@capacitor/core';
import { deleteHistoryCache, getHistoryCache, setHistoryCache, type HistoryCacheEntry } from './historyCache';

// 是否运行在 Capacitor 原生环境（区别于浏览器）
export function isNativeRuntime(): boolean {
  const c = (globalThis as any).Capacitor;
  return !!c && typeof c.isNativePlatform === 'function' && c.isNativePlatform();
}

// dev 走 Vite 代理（/api/v0 → https://chat.deepseek.com）绕开 CORS；
// 生产（Capacitor/Web 部署）用绝对地址，届时依赖原生 HTTP 桥或后端代理。
export const BASE = import.meta.env.DEV
  ? '/api/v0'
  : 'https://chat.deepseek.com/api/v0';

// fetch_files 等端点要求「Web 端 UA + x-client-* 头」才返回带 signed_path 的完整文件实体；
// 默认 request() 用 Android UA（对齐原生），这些端点需显式覆盖为 Web UA。
const WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

// 文件（图片）服务域名：signed_path 本身已含 "/file?file_id=...&state=..."，
// 只需拼上该域并通过 ty=p 指定图片形态（对齐 web 端 bundle 的 ct()）。
const FILE_IMAGE_HOST = 'https://files.deepseeksvc.com';

// 由消息文件描述符的 signed_path 拼出可访问的图片 URL。
// - 已是完整 http(s) URL → 原样返回
// - 否则 → 拼上域名与 ty=p；注意 signed_path 内已带 URL 编码（%2F/%2B），直接拼接不可二次编码
// dev 下走 Vite /file-svc 代理（服务端补 Referer 绕过 WAF 的跨域来源校验）；
// 生产（原生/线上部署）用文件服务绝对地址。
// 找不到返回 null。
export function buildFileUrl(signedPath: string | null | undefined): string | null {
  if (!signedPath) return null;
  if (/^https?:\/\//.test(signedPath)) return signedPath;
  const origin = import.meta.env.DEV ? '/file-svc' : FILE_IMAGE_HOST;
  const base = `${origin}/api${signedPath}`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ty=p`;
}

// 原生图片内存缓存：同一 URL（signed_path 含 state 签名）只走一次 OkHttp 拉取，
// 避免重渲染/切换分支时同一图片反复拉取转 base64。上限防内存膨胀。
const imageCache = new Map<string, string>();
const IMAGE_CACHE_MAX = 200;

// 原生环境（Capacitor WebView）加载文件服务图片：WebView 直接 <img> 跨域会被 WAF 拦，
// 改为走原生 OkHttp（DsBridge.requestBinary）带伪装头拉取，返回 base64 data URL；
// 非原生环境（浏览器 dev 走代理 / 线上）直接返回 URL 交给 <img>。
export async function loadFileImage(signedPath: string | null | undefined): Promise<string | null> {
  const url = buildFileUrl(signedPath);
  if (!url) return null;
  if (!isNativeRuntime()) return url;
  const hit = imageCache.get(url);
  if (hit) return hit;
  try {
    const resp = await DsBridge.requestBinary({
      method: 'GET',
      url,
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
        Referer: 'https://chat.deepseek.com/',
        Origin: 'https://chat.deepseek.com',
      },
    });
    if (resp.status !== 200 || !resp.data) return null;
    const dataUrl = `data:${resp.mimeType || 'image/webp'};base64,${resp.data}`;
    if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.clear(); // 简单防膨胀
    imageCache.set(url, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

// ── 信封 ──
export interface Envelope {
  code: number;
  msg: string;
  data: {
    biz_code: number;
    biz_msg: string;
    biz_data: any;
  } | null;
}

export class ApiError extends Error {
  code: number;
  bizCode: number;
  constructor(message: string, code = -1, bizCode = -1) {
    super(message);
    this.code = code;
    this.bizCode = bizCode;
  }
}

let _token: string | null = null;
export function setToken(t: string | null) {
  _token = t;
}
export function getToken() {
  return _token;
}

async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | undefined | string[]>;
    powHeader?: string;
    headers?: Record<string, string>;
    skipPlatform?: boolean;
  } = {},
): Promise<T> {
  const { method = 'GET', body, query, powHeader, headers: extraHeaders, skipPlatform } = options;
  const url = new URL(BASE + path, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      // 数组值 → 重复同名参数（如 fetch_files 的 file_ids=..&file_ids=..）
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
    'X-App-Version': '2025.04.25',
    'X-Client-Locale': 'zh_CN',
    Origin: 'https://chat.deepseek.com',
    Referer: 'https://chat.deepseek.com/',
  };
  // X-Client-Platform: web 会让 fetch_page 返回精简会话（缺 pinned 等字段），
  // 需要完整会话字段的端点用 skipPlatform 跳过该头。
  if (!skipPlatform) headers['X-Client-Platform'] = 'web';
  if (extraHeaders) Object.assign(headers, extraHeaders);
  if (_token) headers['Authorization'] = `Bearer ${_token}`;
  if (powHeader) headers['X-Ds-Pow-Response'] = powHeader;

  let text: string;
  if (isNativeRuntime()) {
    // 原生环境：走 OkHttp 原生桥，绕过 chat.deepseek.com 的 CORS/WAF 拦截
    const resp = await DsBridge.request({
      method,
      url: url.toString(),
      headers,
      body: body !== undefined ? JSON.stringify(body) : null,
    });
    if (typeof resp.data === 'string') {
      text = resp.data;
    } else {
      // 原生桥已解析为 JSObject，重新序列化以走统一的信封解析
      text = JSON.stringify(resp.data);
    }
  } else {
    let raw: Response;
    try {
      raw = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(`网络请求失败: ${e instanceof Error ? e.message : e}`, -1);
    }
    text = await raw.text();
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiError(`响应非 JSON (HTTP ${text})`);
  }

  const env = json as Envelope;
  if (env.code !== 0) {
    throw new ApiError(env.msg || `系统错误 ${env.code}`, env.code);
  }
  const biz = env.data;
  if (biz && biz.biz_code !== 0) {
    throw new ApiError(biz.biz_msg || `业务错误 ${biz.biz_code}`, env.code, biz.biz_code);
  }
  return biz?.biz_data as T;
}

// ── 端点 ──

// 会话列表（游标分页）
// 分页游标为 before_seq_id：取「seq_id 小于该值」的更早会话。
// （实测 lte_cursor.updated_at / lte_cursor.pinned 等参数被服务端忽略，
//  始终返回第一页；只有 before_seq_id 能正确前进。）
export function fetchSessionsPage(opts: { count?: number; beforeSeqId?: number } = {}) {
  const { count = 50, beforeSeqId } = opts;
  return request<{ chat_sessions: ChatSession[]; has_more: boolean }>(
    '/chat_session/fetch_page',
    {
      skipPlatform: true,
      query: {
        count,
        ...(beforeSeqId !== undefined ? { before_seq_id: beforeSeqId } : {}),
      },
    },
  );
}

// 拉取全部会话（before_seq_id 游标分页循环 + 去重 + 防环）
export async function fetchAllSessions(opts: { count?: number } = {}): Promise<ChatSession[]> {
  const { count = 100 } = opts;
  const sessions: ChatSession[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<number | null>();
  seenCursors.add(null);
  let beforeSeqId: number | null = null;

  for (let i = 0; i < 100; i++) {
    const data = await fetchSessionsPage({
      count,
      ...(beforeSeqId != null ? { beforeSeqId } : {}),
    });
    const list = data.chat_sessions;
    let added = 0;
    for (const s of list) {
      if (!s.id || seenIds.has(s.id)) continue;
      seenIds.add(s.id);
      sessions.push(s);
      added++;
    }

    if (!data.has_more || list.length === 0) break;
    if (added === 0) break;
    const last = list[list.length - 1];
    if (last.seq_id == null || seenCursors.has(last.seq_id)) break;
    seenCursors.add(last.seq_id);
    beforeSeqId = last.seq_id;
  }

  return sessions;
}

// 读取会话全部消息（带本地缓存增量协议）
//
// 对齐官方 web 2.3.0（从官方 bundle 逆向）：
//  - 本地已有缓存时携带 cache_version(=session.version) + cache_reset_at
//  - 版本命中：服务端返回空 chat_messages（≈400B，cache_valid=true），
//    直接复用本地缓存，避免全量拉取 3MB + JSON.parse
//  - 版本过期：服务端返回全量消息，按 message_id 合并（响应优先）后替换缓存
//  - cache_control 缺省/MERGE → 合并；REPLACE → 直接使用响应
//  - 空会话(version===0)或会话已删除(biz_code=1) → 清理本地缓存
export interface HistoryResult {
  chat_session: ChatSession;
  chat_messages: ChatMessage[];
  cache_valid: boolean;
  fromCache: boolean; // 本次结果是否来自本地缓存命中（未做大响应传输）
}

/** 按 message_id 去重（保留首次出现；调用方把「响应在前、缓存在后」传入即可让响应优先） */
function dedupeByMessageId(list: ChatMessage[]): ChatMessage[] {
  const seen = new Set<number>();
  const out: ChatMessage[] = [];
  for (const m of list) {
    if (seen.has(m.message_id)) continue;
    seen.add(m.message_id);
    out.push(m);
  }
  return out;
}

// history_messages 原始响应（供 requestHistoryRaw 返回，避免重复声明）
interface HistoryRawData {
  chat_session: ChatSession;
  chat_messages: ChatMessage[];
  cache_valid: boolean;
  cache_control?: string;
  cache_reset_at?: number;
}

// 按「本地是否有可用缓存」决定是否携带缓存参数请求 history_messages
async function requestHistoryRaw(
  sessionId: string,
  cached: HistoryCacheEntry | null,
): Promise<HistoryRawData> {
  const query: Record<string, string | number | undefined> = { chat_session_id: sessionId };
  // 仅当缓存同时持有 version 与 cacheResetAt 才携带缓存参数（对齐官方）
  if (cached && cached.version != null && cached.cacheResetAt != null) {
    query.cache_version = cached.version;
    query.cache_reset_at = cached.cacheResetAt;
  }
  return request<HistoryRawData>('/chat/history_messages', { query });
}

export async function fetchHistory(sessionId: string): Promise<HistoryResult> {
  let cached = await getHistoryCache(sessionId);
  let data: HistoryRawData;
  try {
    data = await requestHistoryRaw(sessionId, cached);
  } catch (e) {
    // 会话已删除（INVALID_SESSION_ID）：清理本地缓存，避免复活旧数据
    if (e instanceof ApiError && e.bizCode === 1) void deleteHistoryCache(sessionId);
    throw e;
  }

  // 空会话 / 会话不可用：官方直接清缓存
  if (!data.chat_session || data.chat_session.version === 0) {
    void deleteHistoryCache(sessionId);
    return { ...data, fromCache: false };
  }

  // 命中"空缓存"→ 疑似历史污染：之前带 x-client-version 头时期曾把空消息树
  // 写入本地缓存（响应格式被版本头改变导致解析为空），版本命中后一直复用空缓存。
  // 删除缓存并强制全量重拉一次（不带缓存参数），用真实消息重建缓存。
  if (data.cache_valid && cached && cached.data.chat_messages.length === 0 && data.chat_messages.length === 0) {
    await deleteHistoryCache(sessionId);
    cached = null;
    try {
      data = await requestHistoryRaw(sessionId, null);
    } catch (e) {
      if (e instanceof ApiError && e.bizCode === 1) void deleteHistoryCache(sessionId);
      throw e;
    }
  }

  // 合并：REPLACE 直接用响应；否则(MERGE/缺省)响应 + 本地缓存按 message_id 去重（响应优先）
  const merged =
    data.cache_control === 'REPLACE'
      ? data.chat_messages
      : dedupeByMessageId([...data.chat_messages, ...(cached?.data.chat_messages ?? [])]);

  const shouldCache = (data.cache_control !== 'MERGE' || data.chat_messages.length !== 0) && merged.length !== 0;
  if (shouldCache) {
    void setHistoryCache({
      key: sessionId,
      version: data.chat_session.version,
      cacheResetAt:
        data.cache_control === 'REPLACE'
          ? data.cache_reset_at!
          : (cached?.cacheResetAt ?? Math.floor(data.chat_session.updated_at)),
      data: { chat_session: data.chat_session, chat_messages: merged },
      timestamp: Date.now(),
    });
  }

  return {
    chat_session: data.chat_session,
    chat_messages: merged,
    cache_valid: data.cache_valid,
    fromCache: data.chat_messages.length === 0 && cached !== null,
  };
}

// 按 file_id 取回完整文件实体：history_messages 里的文件是裁剪版（缺 signed_path），
// 图片预览需要完整实体里的 signed_path 来拼可访问 URL。
// 带 8s 超时：文件富化是后台渐进增强，挂起也不能影响消息展示。
export async function fetchFilesInfo(fileIds: string[]): Promise<ChatFile[]> {
  if (!fileIds.length) return [];
  const timeout = new Promise<{ files?: ChatFile[] }>((resolve) => {
    window.setTimeout(() => resolve({ files: [] }), 8000);
  });
  try {
    const data = await Promise.race([
      request<{ files?: ChatFile[] }>('/file/fetch_files', {
        method: 'GET',
        // fetch_files 的 file_ids 是重复参数（file_ids=..&file_ids=..），不能用逗号合并（会 400）
        query: { file_ids: fileIds },
        // fetch_files 需要「Web UA + 完整 x-client-* 头」才返回带 signed_path/is_image 的完整实体：
        // 实测 Android UA 或缺少 x-client-* 时 signed_path 缺失（仅 id/status/file_name 等基础字段）。
        // 默认 request() 的 UA 是 Android，这里显式覆盖为 Web UA。
        headers: {
          'User-Agent': WEB_USER_AGENT,
          'x-client-version': '2.3.0',
          'x-client-bundle-id': 'com.deepseek.chat',
          'x-client-platform': 'web',
          'x-client-locale': 'zh_CN',
        },
      }),
      timeout,
    ]);
    return data.files ?? [];
  } catch {
    return [];
  }
}

// 用 /file/fetch_files 把消息里缺失 signed_path 的文件补全为完整实体（带 signed_path/is_image 等）。
// 加载某会话的历史消息后调用；返回新的 chat_messages（未缺文件的直接原样返回）。
export async function enrichMessageFiles(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const ids = new Set<string>();
  for (const m of messages) {
    for (const f of m.files ?? []) {
      if (!(f as any).signed_path && !(f as any).url && (f as any).id) ids.add(String((f as any).id));
    }
  }
  if (!ids.size) return messages;
  const infos = await fetchFilesInfo([...ids]);
  const byId = new Map(infos.map((i) => [String(i.id), i]));
  return messages.map((m) => ({
    ...m,
    files: (m.files ?? []).map((f) => {
      const full = byId.get(String((f as any).id));
      return full && !(f as any).signed_path ? { ...f, ...full } : f;
    }),
  }));
}

// 删除会话
export function deleteSession(sessionId: string) {
  return request<null>('/chat_session/delete', {
    method: 'POST',
    body: { chat_session_id: sessionId },
  });
}

// 重命名
export function renameSession(sessionId: string, title: string) {
  return request<null>('/chat_session/update_title', {
    method: 'POST',
    body: { chat_session_id: sessionId, title },
  });
}

// 创建分享（message_ids 必须是一条完整链，每父一子）
export function createShare(sessionId: string, messageIds: number[]) {
  return request<{ share_id: string }>('/share/create', {
    method: 'POST',
    body: { chat_session_id: sessionId, message_ids: messageIds },
  });
}

// fork 分享 → 新会话
export function forkShare(shareId: string) {
  return request<{ chat_session_id: string }>('/share/fork', {
    method: 'POST',
    body: { share_id: shareId },
  });
}

// 获取 PoW challenge
async function fetchPowChallenge(targetPath: string): Promise<PowChallenge> {
  const data = await request<{ challenge: PowChallenge }>('/chat/create_pow_challenge', {
    method: 'POST',
    body: { target_path: targetPath },
  });
  return data.challenge;
}

async function withPow(path: string) {
  const challenge = await fetchPowChallenge(path);
  return makePowHeader(challenge);
}

// 发消息 / 新建分支（SSE 流式）
export interface CompletionBody {
  chat_session_id: string;
  parent_message_id: number | null;
  model_type?: string;
  prompt: string;
  ref_file_ids?: string[];
  thinking_enabled?: boolean;
  search_enabled?: boolean;
  preempt?: boolean;
}

// 视觉会话（会话含图片消息）校验客户端身份，缺 x-client-* 头时 completion/edit 会被拒
//（与 regenerate 的 ban 机制一致）。带这些头 → 流切成 fragments 格式，
// 需配合 FragmentTracker 解析（见 InputBar/MessageView）。普通文本会话保持无这些头 → delta。
export interface StreamOpts {
  vision?: boolean;
}

export async function sendCompletion(
  body: CompletionBody,
  onEvent: (obj: Record<string, any>) => void,
  signal?: AbortSignal,
  opts?: StreamOpts,
): Promise<void> {
  const powHeader = await withPow('/api/v0/chat/completion');
  // 视觉会话走 sseHeaders（解锁 + fragments 格式）；普通会话保持无 x-client 头 → delta 流
  const headers: Record<string, string> = opts?.vision
    ? sseHeaders(powHeader)
    : {
        'Content-Type': 'application/json',
        'User-Agent': navigator.userAgent,
        'X-App-Version': '2025.04.25',
        'X-Ds-Pow-Response': powHeader,
        Authorization: `Bearer ${_token}`,
      };
  // completion 必填字段：缺失任一会被服务端以 HTTP 422 拒绝，这里补全默认值（调用方可覆盖）
  const fullBody = {
    model_type: 'default',
    ref_file_ids: [] as string[],
    thinking_enabled: true,
    search_enabled: true,
    preempt: false,
    ...body,
  };
  await streamSse(`${BASE}/chat/completion`, headers, fullBody, onEvent, signal);
}

// 编辑消息重发（SSE 流式，与 completion 相同格式）
export interface EditMessageBody {
  chat_session_id: string;
  message_id: number;
  prompt: string;
  search_enabled?: boolean;
  thinking_enabled?: boolean;
}

export async function editMessage(
  body: EditMessageBody,
  onEvent: (obj: Record<string, any>) => void,
  signal?: AbortSignal,
  opts?: StreamOpts,
): Promise<void> {
  const powHeader = await withPow('/api/v0/chat/edit_message');
  // 与 sendCompletion 一致：视觉会话走 sseHeaders（fragments），普通会话保持 delta
  const headers: Record<string, string> = opts?.vision
    ? sseHeaders(powHeader)
    : {
        'Content-Type': 'application/json',
        'User-Agent': navigator.userAgent,
        'X-App-Version': '2025.04.25',
        'X-Ds-Pow-Response': powHeader,
        Authorization: `Bearer ${_token}`,
      };
  const fullBody = {
    thinking_enabled: true,
    search_enabled: true,
    ...body,
  };
  await streamSse(`${BASE}/chat/edit_message`, headers, fullBody, onEvent, signal);
}

// 编辑消息的 completion 降级路径（绕过服务端 edit_limit 分支数限制）
//
// 背景（逆向结论，2026-08 实测验证）：
//  服务端对 /chat/edit_message 端点施加分支数限制：同一父消息下子分支数 ≥6 时，
//  edit_message 返回 SSE 错误事件 {type:"error", finish_reason:"edit_limit",
//  content:"Edit limit reached. Message not sent."}，请求被拒绝。
//  但 /chat/completion 端点不做该检查（实测满载父下可无限创建分支）。
//
//  从官方客户端源码看（2.1.0 / 2.3.6 一致），ChatEditMessageRequest 本就是
//  ChatCompletionRequest 密封类的子类型之一：编辑的请求体是
//  {chat_session_id, message_id, prompt, ref_file_ids, thinking_enabled,
//   search_enabled, client_stream_id, action}，而普通发消息（ChatFullCompletionRequest）
//  用 parent_message_id 指定新分支的父。两者在"于某父消息下创建新 USER+AI 分支"上等价，
//  只是服务端只对 edit_message 端点做分支数校验。
//
//  因此"编辑重发"在满载时可降级为：completion(parent_message_id = 被编辑用户消息的父消息 id)。
//  效果与 edit_message 一致（原消息保留，新分支挂在父下），且不受 edit_limit 限制。
//
//  注意：
//  - 这是绕过服务端限制的降级路径，是否启用应作为用户设置项（默认关闭），
//    等设置页上线后再接线；当前仅暴露接口供后续调用。
//  - completion 的 parent 必须是 AI 消息或 null（服务端对 USER 角色返回
//    "invalid message role"），调用方需传被编辑用户消息的父消息 id。
export interface EditFallbackBody {
  chat_session_id: string;
  /** 被编辑用户消息的父消息 id（必须为 AI 消息或 null 语义） */
  parent_message_id: number | null;
  prompt: string;
  search_enabled?: boolean;
  thinking_enabled?: boolean;
}

export async function editMessageFallback(
  body: EditFallbackBody,
  onEvent: (obj: Record<string, any>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { chat_session_id, parent_message_id, prompt, search_enabled, thinking_enabled } = body;
  await sendCompletion(
    {
      chat_session_id,
      parent_message_id,
      prompt,
      search_enabled,
      thinking_enabled,
    },
    onEvent,
    signal,
  );
}


// 重新生成 AI 回复（SSE 流式）
// 官方 web 端点 /chat/regenerate：child_message_id 为被重新生成的 AI 消息 id，
// 服务器在其父提问下创建新的兄弟回复（与 completion 的 parent 语义不同，
// completion 的 parent 必须是 AI 消息或 null，传 USER 消息会报 invalid message role）。
// PoW 场景为 completion_like，target_path 沿用 /api/v0/chat/completion。
export interface RegenerateBody {
  chat_session_id: string;
  child_message_id: number;
  thinking_enabled?: boolean;
  search_enabled?: boolean;
  user_options?: null;
}

export async function regenerateMessage(
  body: RegenerateBody,
  onEvent: (obj: Record<string, any>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const powHeader = await withPow('/api/v0/chat/completion');
  const headers = sseHeaders(powHeader);
  const fullBody = {
    thinking_enabled: true,
    search_enabled: true,
    user_options: null,
    ...body,
  };
  await streamSse(`${BASE}/chat/regenerate`, headers, fullBody, onEvent, signal);
}

// 视觉会话（含图片）专用请求头：带客户端标识 x-client-*（对齐官方 web 端 2.3.0）。
// 服务端对带图片附件的会话（vision 模型）会校验客户端身份，缺这些头时
// /chat/regenerate 会被以 "ban regenerate" 拒绝，completion / edit_message 也会被拒。
// 代价：这些头会让流切成 fragments 格式，需配合 FragmentTracker 解析
//（视觉会话的 regenerate / completion / edit_message 都走此头 → fragments；
//  普通文本会话保持无这些头 → delta，见 sendCompletion / editMessage 的 vision 分支）。
function sseHeaders(powHeader: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': navigator.userAgent,
    'X-App-Version': '2025.04.25',
    'X-Ds-Pow-Response': powHeader,
    Authorization: `Bearer ${_token}`,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-platform': isNativeRuntime() ? 'android' : 'web',
    'x-client-version': '2.3.0',
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  };
}

// ── SSE 流式读取（原生桥 / fetch 双后端）──
async function streamSse(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  onEvent: (obj: Record<string, any>) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (isNativeRuntime()) {
    await nativeStreamSse(url, headers, body, onEvent, signal);
    return;
  }
  await fetchStreamSse(url, headers, body, onEvent, signal);
}

// 浏览器（dev）：用 fetch ReadableStream 逐行解析 SSE
async function fetchStreamSse(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  onEvent: (obj: Record<string, any>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new ApiError(`completion HTTP ${resp.status}`);
  }
  const ctype = resp.headers.get('content-type') ?? '';
  // 服务端可能直接返回非 SSE 的 JSON 封套（如 regenerate 被拒：{code:0,data:{biz_code:4}}），
  // 此时逐行解析会静默吞掉错误。读到完整文本后统一走封套校验。
  if (!ctype.includes('event-stream')) {
    const text = await resp.text();
    throwApiEnvelopeError(text);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev: any;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue; /* 忽略坏帧 */
      }
      // 服务端以 SSE 事件返回业务拒绝：{type:"error", content, finish_reason}
      if (ev && ev.type === 'error') {
        throw new ApiError(ev.content || '请求被拒绝', -1, typeof ev.biz_code === 'number' ? ev.biz_code : -1);
      }
      onEvent(ev);
    }
  }
}

// 校验业务封套：code/biz_code 非 0 时抛 ApiError；正常则忽略（非 SSE 请求无 data: 前缀）
function throwApiEnvelopeError(text: string) {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  if (json && typeof json === 'object') {
    const env = json as Envelope;
    if (env.code !== 0) {
      throw new ApiError(env.msg || `系统错误 ${env.code}`, env.code);
    }
    const biz = env.data;
    if (biz && biz.biz_code !== 0) {
      throw new ApiError(biz.biz_msg || `业务错误 ${biz.biz_code}`, env.code, biz.biz_code);
    }
  }
}

// 原生（Android）：走 DsBridge 插件，SSE 事件由原生逐行回传
// 每个流分配唯一 key，全局监听器按 key 分发到对应回调
let sseSeq = 0;
let sseListenerPromise: Promise<PluginListenerHandle> | null = null;
const sseHandlers = new Map<string, (ev: DsSseEvent) => void>();

// 惰性建立全局监听器（并发安全：只建一次，多个流共享）
function getSseListener(): Promise<PluginListenerHandle> {
  if (!sseListenerPromise) {
    sseListenerPromise = DsBridge.addListener('sseEvent', (ev) => {
      const handler = sseHandlers.get(ev.key ?? '');
      if (handler) handler(ev);
    });
  }
  return sseListenerPromise;
}

async function nativeStreamSse(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  onEvent: (obj: Record<string, any>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const key = `sse-${++sseSeq}`;
  await getSseListener();

  await new Promise<void>((resolve, reject) => {
    const handler = (ev: DsSseEvent) => {
      if (ev.type === 'data' && ev.payload) {
        let obj: any;
        try {
          obj = JSON.parse(ev.payload);
        } catch {
          return; /* 忽略坏帧 */
        }
        // 服务端以 SSE 事件返回业务拒绝：{type:"error", content, finish_reason}
        if (obj && obj.type === 'error') {
          sseHandlers.delete(key);
          reject(new ApiError(obj.content || '请求被拒绝', -1, typeof obj.biz_code === 'number' ? obj.biz_code : -1));
          return;
        }
        onEvent(obj);
      } else if (ev.type === 'end') {
        sseHandlers.delete(key);
        resolve();
      } else if (ev.type === 'error') {
        sseHandlers.delete(key);
        reject(new ApiError(ev.message || 'SSE 请求失败', -1, ev.status ?? -1));
      }
    };
    sseHandlers.set(key, handler);
    // 支持取消：AbortSignal 触发时通知原生停止
    if (signal) {
      if (signal.aborted) {
        sseHandlers.delete(key);
        DsBridge.stopSse({ key });
        reject(new ApiError('已取消'));
        return;
      }
      signal.addEventListener('abort', () => {
        sseHandlers.delete(key);
        DsBridge.stopSse({ key });
      }, { once: true });
    }
    DsBridge.startSse({ url, method: 'POST', headers, body: JSON.stringify(body), key }).catch((e) => {
      sseHandlers.delete(key);
      reject(e instanceof Error ? e : new ApiError(String(e)));
    });
  });
}

// ── 消息规范化（history → 结构化）──
export function normalizeMessage(m: ChatMessage): NormalizedMessage {
  // 官方 Android 格式（fragments）兼容：历史版本曾全局携带 x-client-version 头，
  // 服务端因此返回 fragments 结构（无 content/thinking_content），并被写入本地缓存。
  // content/thinking 缺失时从 fragments 拼装，保证此类缓存能正常渲染。
  const hasContent = (m.content ?? '').length > 0;
  const fragments = m.fragments ?? [];
  const joinFrag = (types: ChatFragmentType[]) =>
    fragments
      .filter((f) => types.includes(f.type))
      .map((f) => f.content ?? '')
      .join('');
  const content = hasContent ? m.content : joinFrag(['REQUEST', 'RESPONSE']);
  const thinkingFrag = fragments.find((f) => f.type === 'THINK');
  const thinkingContent = hasContent ? m.thinking_content : (thinkingFrag?.content ?? '');
  const elapsedSecs = hasContent ? m.thinking_elapsed_secs : (thinkingFrag?.elapsed_secs ?? null);
  return {
    id: m.message_id,
    parent_id: m.parent_id,
    role: m.role,
    content: content ?? '',
    thinking:
      thinkingContent && thinkingContent.length > 0
        ? { content: thinkingContent, elapsed_secs: elapsedSecs }
        : null,
    model: m.model ?? '',
    status: m.status ?? 'FINISHED',
    token_usage: m.accumulated_token_usage ?? null,
    thinking_enabled: m.thinking_enabled,
    search_enabled: m.search_enabled,
    ban_edit: m.ban_edit,
    ban_regenerate: m.ban_regenerate,
    files: m.files ?? [],
    feedback: m.feedback,
    search_results: m.search_results,
    tips: m.tips ?? [],
    inserted_at: m.inserted_at,
  };
}
