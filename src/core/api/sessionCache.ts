// 会话列表的本地缓存（localStorage）
//
// 官方 web 客户端会话列表无持久缓存（秒开靠内存 store + 网络快）；
// 我们按用户需求做「本地优先、异步同步」：启动先渲染缓存秒开，
// 后台拉取最新列表后覆盖。数据量小（数百条 ≈ 几十 KB），同步 JSON 即可。
// 按 token 隔离，避免多账号串数据。

import type { ChatSession } from './types';

const PREFIX = 'ds_sessions_cache:';

export interface SessionListCache {
  sessions: ChatSession[];
  savedAt: number;
}

export function loadSessionListCache(token: string | null): SessionListCache | null {
  if (!token) return null;
  try {
    const raw = localStorage.getItem(PREFIX + token);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionListCache;
    if (!parsed || !Array.isArray(parsed.sessions)) return null;
    return parsed;
  } catch {
    return null; // 解析失败/不可用视为未命中
  }
}

export function saveSessionListCache(token: string | null, sessions: ChatSession[]) {
  if (!token) return;
  try {
    const payload: SessionListCache = { sessions, savedAt: Date.now() };
    localStorage.setItem(PREFIX + token, JSON.stringify(payload));
  } catch {
    /* 存储失败（隐私模式/配额满）不影响主流程 */
  }
}
