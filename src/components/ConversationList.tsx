import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Haptics } from '@capacitor/haptics';
import type { ChatSession } from '../core/api/types';
import { createShare, deleteSession, forkShare, fetchHistory, normalizeMessage, renameSession } from '../core/api/client';
import { activePathOf, buildIndex } from '../core/api/tree';

interface Props {
  sessions: ChatSession[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onSessionsChange: () => void;
  onRefresh: () => void | Promise<void>; // 下拉刷新：立即重新拉取会话列表
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

export default function ConversationList({ sessions, currentId, onOpen, onSessionsChange, onRefresh }: Props) {
  const [keyword, setKeyword] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  // 下拉刷新：pull.dist 为拖拽距离（px），refreshing 为请求中
  const [pull, setPull] = useState({ dist: 0, refreshing: false });
  const refreshingRef = useRef(false);
  // 居中 Toast（替代原先常驻侧栏顶部的横幅）：自动显现约 1s 后消失
  const [toast, setToast] = useState<string | null>(null);
  const [toastClosing, setToastClosing] = useState(false);
  const toastTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, [toastTimer, closeTimer]);
  const showToast = (text: string) => {
    setToastClosing(false);
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToastClosing(true);
      closeTimer.current = window.setTimeout(() => {
        setToast(null);
        setToastClosing(false);
      }, 150);
    }, 1000);
  };
  // 菜单：记录被长按项目相对 .drawer 的上下位置 + 侧栏尺寸，用于固定靠右、优先上方/下方
  const [menu, setMenu] = useState<{
    id: string;
    itemTop: number;
    itemBottom: number;
    drawerHeight: number;
  } | null>(null);
  const [menuTop, setMenuTop] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 下拉刷新 DOM 引用（拖动时直接改 transform，避免每帧 setState 重渲染 602 项列表）
  const listRef = useRef<HTMLDivElement>(null);
  const ptrRef = useRef<HTMLDivElement>(null);
  const PTR_H = 44; // 指示器高度（px）
  // 下拉刷新参数
  const PULL_MAX = 120; // 指示器最大下拉位移（px）
  const PULL_DAMPING = 0.5; // 手指实际下拉距离的阻尼系数
  const PULL_TRIGGER = 100; // 触发刷新的指示器位移阈值（px）
  // 内联重命名编辑状态（window.prompt 在部分环境被禁用，改用内联输入）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editRef = useRef<HTMLInputElement>(null);

  // 删除二次确认：避免误删，提供全屏遮罩对话框
  const [confirmDelete, setConfirmDelete] = useState<ChatSession | null>(null);

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

  // 菜单打开期间锁定列表滚动：否则列表滚动会让菜单停留在原地（移动端滚动必点击，天然规避）
  useEffect(() => {
    if (!menu) return;
    const sc = scrollRef.current;
    if (!sc) return;
    const prevent = (e: Event) => e.preventDefault();
    sc.addEventListener('wheel', prevent, { passive: false });
    sc.addEventListener('touchmove', prevent, { passive: false });
    return () => {
      sc.removeEventListener('wheel', prevent);
      sc.removeEventListener('touchmove', prevent);
    };
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

  // 分组标题羽化检测：官方语义是「卡片上边界越过/接触标题下边界」才显示下边缘羽化，
  // 而不是「标题到达容器顶部」。首个标题初始即钉在顶部，但下方卡片仍有空隙（列表项间间距），
  // 此时不显示羽化；上滑到卡片接触标题下边缘才显现。
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const update = () => {
      for (const label of sc.querySelectorAll<HTMLElement>('.conv-group-label')) {
        const next = label.nextElementSibling;
        if (!next) continue; // 空分组无卡片，不显示羽化
        const labelBottom = label.getBoundingClientRect().bottom;
        const nextTop = next.getBoundingClientRect().top;
        label.classList.toggle('pinned', nextTop <= labelBottom + 0.5);
      }
    };
    update();
    sc.addEventListener('scroll', update, { passive: true });
    return () => sc.removeEventListener('scroll', update);
  }, [grouped]);

  const handleFork = async (s: ChatSession) => {
    if (!s.current_message_id) {
      showToast('复制失败');
      return;
    }
    setBusyId(s.id);
    setMenu(null);
    try {
      const data = await fetchHistory(s.id);
      const messages = data.chat_messages.map(normalizeMessage);
      const idx = buildIndex(messages);
      const active = activePathOf(idx, data.chat_session.current_message_id);
      const share = await createShare(s.id, active);
      await forkShare(share.share_id);
      showToast('复制成功');
      onSessionsChange();
    } catch (e: any) {
      showToast('复制失败');
    } finally {
      setBusyId(null);
    }
  };

  const requestDelete = (s: ChatSession) => {
    setMenu(null);
    setConfirmDelete(s);
  };

  const handleDelete = async () => {
    const s = confirmDelete;
    if (!s) return;
    setBusyId(s.id);
    try {
      await deleteSession(s.id);
      setConfirmDelete(null);
      onSessionsChange();
    } catch (e: any) {
      // 删除失败：不关闭确认框，保留现场以便用户重试
      showToast('删除失败');
    } finally {
      setBusyId(null);
    }
  };

  const handleRename = (s: ChatSession) => {
    setEditingId(s.id);
    setEditValue(s.title || '');
    setMenu(null);
  };

  // 内联编辑提交：回车/失焦时保存
  const submitRename = (s: ChatSession) => {
    if (editingId !== s.id) return; // 已取消或已提交
    const title = editValue.trim();
    if (title && title !== s.title) {
      renameSession(s.id, title).then(() => onSessionsChange());
    }
    setEditingId(null);
  };

  // 下拉刷新：调用 onRefresh（立即重新拉取会话列表）
  const handleRefresh = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setPull({ dist: 0, refreshing: true });
    // 刷新中：列表固定下移露出指示器
    if (listRef.current) {
      listRef.current.style.transition = 'transform 0.2s ease';
      listRef.current.style.transform = `translateY(${PTR_H}px)`;
    }
    if (ptrRef.current) {
      ptrRef.current.style.transition = 'transform 0.2s ease';
      ptrRef.current.style.transform = 'translateY(0)';
      const label = ptrRef.current.querySelector('span');
      if (label) label.textContent = '刷新中…';
    }
    try {
      await onRefresh();
    } finally {
      refreshingRef.current = false;
      setPull({ dist: 0, refreshing: false });
      if (listRef.current) {
        listRef.current.style.transition = 'transform 0.25s ease';
        listRef.current.style.transform = 'translateY(0)';
      }
      if (ptrRef.current) {
        ptrRef.current.style.transition = 'transform 0.25s ease';
        ptrRef.current.style.transform = `translateY(-${PTR_H}px)`;
        const label = ptrRef.current.querySelector('span');
        if (label) label.textContent = '下拉刷新';
      }
    }
  };
  const handleRefreshRef = useRef<() => void>(() => {});
  handleRefreshRef.current = () => { void handleRefresh(); };

  // 下拉刷新手势（移动端）：列表滚到顶后继续下拉触发刷新。
  // 拖动中直接改 DOM transform（不 setState，避免重渲染数百条列表）。
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    let startY: number | null = null;
    let dist = 0;
    let hapticed = false; // 本次手势是否已振动（跨过阈值仅振一次）
    const onStart = (e: TouchEvent) => {
      if (menu || refreshingRef.current || sc.scrollTop > 0) { startY = null; return; }
      startY = e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0) {
        if (dist !== 0) { dist = 0; resetPullDom(); }
        return;
      }
      e.preventDefault(); // 阻止列表随手指滚动
      dist = Math.min(PULL_MAX, dy * PULL_DAMPING);
      if (listRef.current) {
        listRef.current.style.transition = 'none';
        listRef.current.style.transform = `translateY(${dist}px)`;
      }
      if (ptrRef.current) {
        ptrRef.current.style.transition = 'none';
        ptrRef.current.style.transform = `translateY(${dist - PTR_H}px)`;
        const label = ptrRef.current.querySelector('span');
        if (label) label.textContent = dist >= PULL_TRIGGER ? '松开刷新' : '下拉刷新';
        // 跨过触发阈值时振动一次；回落到阈值以下后重置，允许再次越过时再振
        if (dist >= PULL_TRIGGER && !hapticed) {
          hapticed = true;
          // WebView 不实现 navigator.vibrate，改用原生 Haptics 插件
          void Haptics.vibrate({ duration: 20 }).catch(() => { /* 无振动能力时忽略 */ });
        } else if (dist < PULL_TRIGGER) {
          hapticed = false;
        }
      }
    };
    const onEnd = () => {
      if (startY == null) return;
      const should = dist >= PULL_TRIGGER;
      startY = null;
      dist = 0;
      resetPullDom();
      if (should) handleRefreshRef.current();
    };
    const resetPullDom = () => {
      if (listRef.current) {
        listRef.current.style.transition = 'transform 0.25s ease';
        listRef.current.style.transform = 'translateY(0)';
      }
      if (ptrRef.current) {
        ptrRef.current.style.transition = 'transform 0.25s ease';
        ptrRef.current.style.transform = `translateY(-${PTR_H}px)`;
        const label = ptrRef.current.querySelector('span');
        if (label) label.textContent = '下拉刷新';
      }
    };
    sc.addEventListener('touchstart', onStart, { passive: true });
    sc.addEventListener('touchmove', onMove, { passive: false });
    sc.addEventListener('touchend', onEnd, { passive: true });
    sc.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      sc.removeEventListener('touchstart', onStart);
      sc.removeEventListener('touchmove', onMove);
      sc.removeEventListener('touchend', onEnd);
      sc.removeEventListener('touchcancel', onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  const openMenu = (e: React.MouseEvent, s: ChatSession) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const drawer = el.closest('.drawer-left') as HTMLElement | null;
    const iRect = el.getBoundingClientRect();
    if (drawer) {
      const dRect = drawer.getBoundingClientRect();
      setMenu({
        id: s.id,
        itemTop: iRect.top - dRect.top,
        itemBottom: iRect.bottom - dRect.top,
        drawerHeight: dRect.height,
      });
    } else {
      // 兜底：找不到侧栏时按常规绝对定位
      setMenu({ id: s.id, itemTop: iRect.top, itemBottom: iRect.bottom, drawerHeight: 600 });
    }
  };

  // 菜单挂载后按实际高度校准 top：优先项目上方，上方空间不足则下方，再兜底不越界
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const h = el.offsetHeight;
    const MARGIN = 6;
    let top = menu.itemTop - h - MARGIN; // 优先上方
    if (top < 0) top = menu.itemBottom + MARGIN; // 上方不足 → 下方
    if (top + h > menu.drawerHeight) top = menu.drawerHeight - h; // 兜底不超出侧栏
    setMenuTop(Math.max(0, top));
  }, [menu]);

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

      <div className="conv-scroll" ref={scrollRef}>
        {/* 下拉刷新指示器：默认上移隐藏，下拉/刷新时随列表下移露出 */}
        <div className="conv-ptr" ref={ptrRef}>
          <svg className={`conv-ptr-icon${pull.refreshing ? ' spin' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
          <span>{pull.refreshing ? '刷新中…' : '下拉刷新'}</span>
        </div>
        {grouped.length === 0 && (
          <div className="conv-empty">暂无对话</div>
        )}
        {grouped.map(([g, list]) => (
          <div key={g} className="conv-group">
            <div className="conv-group-label">{g}</div>
            {list.map((s) => (
              <div
                key={s.id}
                className={`conv-item ${s.id === currentId ? 'active' : ''}${menu && menu.id === s.id ? ' menu-anchor' : ''}`}
                onClick={() => { if (editingId !== s.id) onOpen(s.id); }}
                onContextMenu={(e) => openMenu(e, s)}
              >
                <div className="conv-item-title">
                  {editingId === s.id ? (
                    <input
                      ref={editRef}
                      className="conv-item-edit"
                      value={editValue}
                      autoFocus
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur(); // 触发 onBlur 提交
                        else if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => submitRename(s)}
                    />
                  ) : (
                    s.title || '未命名对话'
                  )}
                </div>
                <div className="conv-item-meta">
                  <span>{fmtTime(s.updated_at)}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* 菜单展开期间：全屏遮罩（portal 到 body）拦截外部交互，点击任意位置收起菜单；
          透明背景，视觉上无变化，仅禁止外部点击 */}
      {menu &&
        createPortal(
          <div className="conv-menu-mask" onClick={() => setMenu(null)} aria-hidden="true" />,
          document.body,
        )}

      {menu && (() => {
        const s = sessions.find((x) => x.id === menu.id);
        if (!s) return null;
        return (
          <div
            ref={menuRef}
            className="conv-context-menu"
            style={{ top: menuTop }}
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
            <button className="conv-menu-item conv-menu-item-danger" onClick={() => requestDelete(s)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
              </svg>
              <span>删除</span>
            </button>
          </div>
        );
      })()}
      {toast &&
        createPortal(
          <div className={`toast-center${toastClosing ? ' toast-center--out' : ''}`}>{toast}</div>,
          document.body,
        )}
      {confirmDelete &&
        createPortal(
          <div className="confirm-overlay" onClick={() => setConfirmDelete(null)}>
            <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="confirm-title">删除后，该对话将不可恢复</div>
              <div className="confirm-desc">由该对话生成的分享链接也将失效</div>
              <button
                className="confirm-btn confirm-btn-danger"
                disabled={busyId === confirmDelete.id}
                onClick={handleDelete}
              >
                {busyId === confirmDelete.id ? '删除中…' : '删除该对话'}
              </button>
              <button className="confirm-btn confirm-btn-cancel" onClick={() => setConfirmDelete(null)}>
                取消
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
