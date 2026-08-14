import { useMemo, useState } from 'react';
import type { ChatSession } from '../core/api/types';
import { createShare, forkShare, fetchHistory, normalizeMessage } from '../core/api/client';
import { activePathOf, buildIndex } from '../core/api/tree';

interface Props {
  sessions: ChatSession[];
  currentId: string | null;
  onOpen: (id: string) => void;
}

// 按时间分组标签
function groupLabel(s: ChatSession): string {
  const t = new Date(s.updated_at * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ts = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const dayMs = 86400000;
  if (s.pinned) return '置顶';
  if (ts >= today) return '今天';
  if (ts >= today - dayMs) return '昨天';
  if (ts >= today - 7 * dayMs) return '7 天内';
  if (ts >= today - 30 * dayMs) return '30 天内';
  return '更早';
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function ConversationList({ sessions, currentId, onOpen }: Props) {
  const [keyword, setKeyword] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    let list = sessions;
    if (kw) list = list.filter((s) => (s.title ?? '').toLowerCase().includes(kw));
    return [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updated_at - a.updated_at;
    });
  }, [sessions, keyword]);

  // 分组
  const grouped = useMemo(() => {
    const map = new Map<string, ChatSession[]>();
    for (const s of filtered) {
      const g = groupLabel(s);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(s);
    }
    return [...map.entries()];
  }, [filtered]);

  // 复制（fork 当前会话的全路径）
  const handleFork = async (s: ChatSession) => {
    if (!s.current_message_id) {
      setMsg('该会话没有当前位置，无法复制');
      return;
    }
    setBusyId(s.id);
    setMsg(null);
    try {
      const data = await fetchHistory(s.id);
      const messages = data.chat_messages.map(normalizeMessage);
      const idx = buildIndex(messages);
      const active = activePathOf(idx, data.chat_session.current_message_id);
      const share = await createShare(s.id, active);
      const fork = await forkShare(share.share_id);
      setMsg(`已复制 → 新会话 ${fork.chat_session_id.slice(0, 8)}`);
    } catch (e: any) {
      setMsg(`复制失败: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="conv-list">
      <div className="drawer-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="9" cy="9" r="8" /><path d="M21 21l-4-4" strokeLinecap="round" />
        </svg>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索对话内容..."
        />
      </div>

      {msg && <div className="toast-msg">{msg}</div>}

      <div className="conv-scroll">
        {grouped.length === 0 && (
          <div className="conv-empty">暂无对话</div>
        )}
        {grouped.map(([g, list]) => (
          <div key={g} className="conv-group">
            <div className="conv-group-label">{g}</div>
            {list.map((s) => (
              <div
                key={s.id}
                className={`conv-item ${s.id === currentId ? 'active' : ''}`}
                onClick={() => onOpen(s.id)}
              >
                <div className="conv-item-title">
                  {s.title || '未命名对话'}
                </div>
                <div className="conv-item-meta">
                  <span>{fmtTime(s.updated_at)}</span>
                  <button
                    className="fork-btn"
                    disabled={busyId === s.id}
                    onClick={(e) => { e.stopPropagation(); handleFork(s); }}
                    title="对话 Fork"
                  >
                    {busyId === s.id ? '…' : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
