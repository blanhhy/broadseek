import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSession } from '../core/api/types';
import { createShare, deleteSession, forkShare, fetchHistory, normalizeMessage, renameSession } from '../core/api/client';
import { activePathOf, buildIndex } from '../core/api/tree';

interface Props {
  sessions: ChatSession[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onSessionsChange: () => void;
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

export default function ConversationList({ sessions, currentId, onOpen, onSessionsChange }: Props) {
  const [keyword, setKeyword] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!menu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menu]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    let list = sessions;
    if (kw) list = list.filter((s) => (s.title ?? '').toLowerCase().includes(kw));
    return [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updated_at - a.updated_at;
    });
  }, [sessions, keyword]);

  const grouped = useMemo(() => {
    const map = new Map<string, ChatSession[]>();
    for (const s of filtered) {
      const g = groupLabel(s);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(s);
    }
    return [...map.entries()];
  }, [filtered]);

  const handleFork = async (s: ChatSession) => {
    if (!s.current_message_id) {
      setMsg('该会话没有当前位置，无法复制');
      return;
    }
    setBusyId(s.id);
    setMsg(null);
    setMenu(null);
    try {
      const data = await fetchHistory(s.id);
      const messages = data.chat_messages.map(normalizeMessage);
      const idx = buildIndex(messages);
      const active = activePathOf(idx, data.chat_session.current_message_id);
      const share = await createShare(s.id, active);
      const fork = await forkShare(share.share_id);
      setMsg(`已复制 → 新会话 ${fork.chat_session_id.slice(0, 8)}`);
      onSessionsChange();
    } catch (e: any) {
      setMsg(`复制失败: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (s: ChatSession) => {
    setBusyId(s.id);
    setMenu(null);
    try {
      await deleteSession(s.id);
      onSessionsChange();
    } catch (e: any) {
      setMsg(`删除失败: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleRename = (s: ChatSession) => {
    const title = prompt('重命名对话', s.title || '');
    if (title !== null && title.trim() && title !== s.title) {
      renameSession(s.id, title.trim()).then(() => onSessionsChange());
    }
    setMenu(null);
  };

  const openMenu = (e: React.MouseEvent, s: ChatSession) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ id: s.id, x: e.clientX, y: e.clientY });
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
                onContextMenu={(e) => openMenu(e, s)}
              >
                <div className="conv-item-title">
                  {s.title || '未命名对话'}
                </div>
                <div className="conv-item-meta">
                  <span>{fmtTime(s.updated_at)}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {menu && (() => {
        const s = sessions.find((x) => x.id === menu.id);
        if (!s) return null;
        return (
          <div
            ref={menuRef}
            className="conv-context-menu"
            style={{ left: menu.x, top: menu.y }}
          >
            <button className="conv-menu-item" onClick={() => handleRename(s)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
              <span>重命名</span>
            </button>
            <button
              className="conv-menu-item"
              disabled={busyId === s.id}
              onClick={() => handleFork(s)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
              <span>{busyId === s.id ? '复制中…' : '复制'}</span>
            </button>
            <div className="conv-menu-divider" />
            <button className="conv-menu-item conv-menu-item-danger" onClick={() => handleDelete(s)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
              </svg>
              <span>删除</span>
            </button>
          </div>
        );
      })()}
    </div>
  );
}
