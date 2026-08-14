// DeepSeek Web API 客户端
// 端点对齐 raw-api-reference.md，信封统一解包

import type { ChatMessage, ChatSession, NormalizedMessage } from './types';
import { makePowHeader } from './pow';
import type { PowChallenge } from './pow';
import { DsBridge, type DsSseEvent } from './nativeBridge';
import type { PluginListenerHandle } from '@capacitor/core';

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
    query?: Record<string, string | number | undefined>;
    powHeader?: string;
    headers?: Record<string, string>;
    skipPlatform?: boolean;
  } = {},
): Promise<T> {
  const { method = 'GET', body, query, powHeader, headers: extraHeaders, skipPlatform } = options;
  const url = new URL(BASE + path, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
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

// 读取会话全部消息（一次返回整棵树，无分页）
export function fetchHistory(sessionId: string) {
  return request<{ chat_session: ChatSession; chat_messages: ChatMessage[]; cache_valid: boolean }>(
    '/chat/history_messages',
    { query: { chat_session_id: sessionId } },
  );
}

// 切换会话当前消息（分支位置书签）
export function updateCurrentMessage(sessionId: string, messageId: number) {
  return request<null>('/chat_session/update_current_message', {
    method: 'POST',
    body: { chat_session_id: sessionId, message_id: messageId },
  });
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

export async function sendCompletion(
  body: CompletionBody,
  onEvent: (obj: Record<string, any>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const powHeader = await withPow('/api/v0/chat/completion');
  const headers: Record<string, string> = {
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
): Promise<void> {
  const powHeader = await withPow('/api/v0/chat/edit_message');
  const headers: Record<string, string> = {
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
      try {
        onEvent(JSON.parse(payload));
      } catch {
        /* 忽略坏帧 */
      }
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
        try {
          onEvent(JSON.parse(ev.payload));
        } catch {
          /* 忽略坏帧 */
        }
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
  const thinkingContent = m.thinking_content;
  return {
    id: m.message_id,
    parent_id: m.parent_id,
    role: m.role,
    content: m.content ?? '',
    thinking:
      thinkingContent && thinkingContent.length > 0
        ? { content: thinkingContent, elapsed_secs: m.thinking_elapsed_secs }
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
