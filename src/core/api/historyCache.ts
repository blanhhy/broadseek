// history_messages 的 IndexedDB 本地缓存（对齐官方 web 2.3.0）
//
// 官方把整棵消息树结构化克隆进 IndexedDB（"history-message" store）：
//  - 请求 history_messages 时携带 cache_version(=session.version) + cache_reset_at
//  - 版本命中时服务端只回空消息（≈400B，cache_valid=true），本地直接复用缓存，
//    避免每次打开长会话都全量拉取 3MB 并 JSON.parse（约占打开耗时的一半）
//  - 版本过期时服务端回全量，本地按 message_id 合并后整体替换缓存
//
// 用 IndexedDB 而非 localStorage：结构化克隆绕开大字符串 JSON.parse/stringify。

import type { ChatMessage, ChatSession } from './types';

export interface HistoryCacheData {
  chat_session: ChatSession;
  chat_messages: ChatMessage[];
}

export interface HistoryCacheEntry {
  key: string; // chat_session_id
  version: number; // chat_session.version，作为 cache_version 请求参数
  cacheResetAt: number; // 缓存建立时的时间锚点（秒，取整），作为 cache_reset_at 请求参数
  data: HistoryCacheData;
  timestamp: number;
  frontendVersion?: string; // 缓存结构版本，由模块内部填充；不匹配即淘汰
}

const DB_NAME = 'ds-history-cache';
const STORE_NAME = 'history-message';
// 缓存结构版本：数据形状变化时递增，旧缓存自动失效
const FRONTEND_VERSION = 'fv-1';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.reject(new Error('IndexedDB unavailable'));
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  return dbPromise;
}

/** 读缓存；结构版本不匹配时淘汰并视为未命中 */
export async function getHistoryCache(key: string): Promise<HistoryCacheEntry | null> {
  try {
    const db = await openDb();
    const entry = await new Promise<HistoryCacheEntry | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result as HistoryCacheEntry | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!entry) return null;
    if (entry.frontendVersion !== FRONTEND_VERSION) {
      void deleteHistoryCache(key);
      return null;
    }
    return entry;
  } catch {
    return null; // 缓存不可用视为未命中，不影响主流程
  }
}

/** 写缓存（覆盖同 key） */
export async function setHistoryCache(entry: HistoryCacheEntry): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ ...entry, frontendVersion: FRONTEND_VERSION });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

/** 删缓存（会话已删除 / 结构版本升级时使用） */
export async function deleteHistoryCache(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}
