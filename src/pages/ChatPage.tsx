import { useEffect, useRef, useState } from 'react';
import { useAuth, useConversation } from '../core/store';
import { fetchAllSessions, fetchHistory, normalizeMessage } from '../core/api/client';
import { loadSessionListCache, saveSessionListCache } from '../core/api/sessionCache';
import type { ChatSession } from '../core/api/types';
import { buildIndex, activePathOf } from '../core/api/tree';
import ConversationList from '../components/ConversationList';
import BranchDrawer from '../components/BranchDrawer';
import MessageView, { type MessageViewHandle } from '../components/MessageView';
import FloatingDots from '../components/FloatingDots';
import InputBar from '../components/InputBar';

// 会话内缓存：避免重复拉取 & 切换回已开过的会话时秒开
interface SessionCache {
  session: ChatSession | null;
  messages: ReturnType<typeof normalizeMessage>[];
  activePath: number[];
  currentMessageId: number | null;
}
const sessionCache = new Map<string, SessionCache>();

export default function ChatPage() {
  const token = useAuth((s) => s.token);
  const logout = useAuth((s) => s.logout);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [leftOpen, setLeftOpen] = useState(true); // 默认展开会话列表
  const [rightOpen, setRightOpen] = useState(false);
  // 手势闭包读取最新抽屉状态
  const leftOpenRef = useRef(leftOpen);
  const rightOpenRef = useRef(rightOpen);
  useEffect(() => { leftOpenRef.current = leftOpen; }, [leftOpen]);
  useEffect(() => { rightOpenRef.current = rightOpen; }, [rightOpen]);
  const [visibleIds, setVisibleIds] = useState<number[]>([]);
  const [viewedId, setViewedId] = useState<number | null>(null);
  const listRef = useRef<MessageViewHandle>(null);
  const reqSeq = useRef(0); // 竞态保护：只接受最后一次请求的结果

  const conv = useConversation();

  // 抽屉开关：一次只能打开一个（打开任一栏时显式关闭另一栏）
  const toggleLeft = () => {
    if (!leftOpenRef.current) setRightOpen(false); // 将打开左栏 → 关闭右栏
    setLeftOpen((v) => !v);
  };
  const toggleRight = () => {
    if (!rightOpenRef.current) setLeftOpen(false); // 将打开右栏 → 关闭左栏
    setRightOpen((v) => !v);
  };

  // 抽屉滑动手势（移动端，拖拽跟随 + 松手按进度阈值吸附）：
  //  - 两栏都关闭：左边缘右滑 → 拖出左栏；右边缘左滑 → 拖出右栏
  //  - 左栏打开：左栏内右滑 → 拖出关闭（松手过半才关）
  //  - 右栏打开：右栏内左滑 → 拖出关闭
  //  - 任一抽屉打开时禁用另一侧边缘滑入（左栏/主页/右栏只能邻接，不允许交叉打开）
  //  - 仅横向主导才拦截触摸，不干扰列表纵向滚动/下拉刷新；左栏菜单打开时暂停关闭手势
  useEffect(() => {
    const EDGE = 24; // 边缘识别宽度 px
    const DEAD = 6; // 横向死区 px（避免纵向滚动时的抖动位移）
    const THRESH = 0.5; // 松手进度阈值：过半则吸附到另一侧
    const SETTLE_MS = 320; // 松手吸附动画结束后清理 --drawer-x（大于 class 0.28s 过渡）
    let drawer: 'left' | 'right' | null = null;
    let startX = 0;
    let startY = 0;
    let width = 336;
    let fromOpen = false; // 拖拽是否从「打开」状态开始
    let v = 0;
    let settleTimer: number | null = null;

    const leftEl = () => document.querySelector<HTMLElement>('.drawer-left');
    const rightEl = () => document.querySelector<HTMLElement>('.drawer-right');

    // 清理拖拽变量，交还 CSS class 控制 transform（--drawer-x 缺省 = class 默认位置）
    const clearDrag = (el: HTMLElement | null) => {
      if (settleTimer) { window.clearTimeout(settleTimer); settleTimer = null; }
      if (el) {
        el.style.transition = '';
        el.style.removeProperty('--drawer-x');
      }
    };

    const onStart = (e: TouchEvent) => {
      if (settleTimer) { window.clearTimeout(settleTimer); settleTimer = null; }
      const t = e.touches[0];
      const x = t.clientX;
      const W = window.innerWidth;
      const bothClosed = !leftOpenRef.current && !rightOpenRef.current;
      const menuOpen = !!document.querySelector('.conv-context-menu');
      let kind: 'openLeft' | 'openRight' | 'closeLeft' | 'closeRight' | null = null;
      if (leftOpenRef.current && x < 336 && !menuOpen) kind = 'closeLeft';
      else if (rightOpenRef.current && x > W - 336) kind = 'closeRight';
      else if (bothClosed && x < EDGE) kind = 'openLeft';
      else if (bothClosed && x > W - EDGE) kind = 'openRight';
      if (!kind) { drawer = null; return; }

      const isLeft = kind === 'openLeft' || kind === 'closeLeft';
      const target = isLeft ? leftEl() : rightEl();
      width = target ? target.offsetWidth : 336;
      drawer = isLeft ? 'left' : 'right';
      fromOpen = isLeft ? leftOpenRef.current : rightOpenRef.current;
      startX = x;
      startY = t.clientY;
      v = fromOpen ? 0 : (isLeft ? -width : width);
    };
    const onMove = (e: TouchEvent) => {
      if (!drawer) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) <= DEAD || Math.abs(dx) <= Math.abs(dy)) return; // 纵向滚动/死区内不拦截
      const isLeft = drawer === 'left';
      // 只跟「拉出方向」：左栏 关闭态右滑/打开态左滑，右栏 关闭态左滑/打开态右滑
      const moving = isLeft ? (fromOpen ? dx < 0 : dx > 0) : (fromOpen ? dx > 0 : dx < 0);
      if (!moving) return;
      e.preventDefault();
      v = isLeft ? Math.min(0, Math.max(-width, startV0() + dx)) : Math.max(0, Math.min(width, startV0() + dx));
      const el = isLeft ? leftEl() : rightEl();
      if (el) {
        el.style.transition = 'none';
        el.style.setProperty('--drawer-x', `${v}px`);
      }
    };
    const startV0 = () => (fromOpen ? 0 : (drawer === 'left' ? -width : width));
    const onEnd = () => {
      if (!drawer) return;
      const isLeft = drawer === 'left';
      const el = isLeft ? leftEl() : rightEl();
      if (el) {
        if (Math.abs(v - startV0()) < 1) {
          // 无实际拖拽（点击/死区内滑动）：直接清变量，交还 class 控制
          clearDrag(el);
        } else {
          const targetOpen = isLeft ? v > -width * (1 - THRESH) : v < width * (1 - THRESH);
          const targetV = targetOpen ? 0 : (isLeft ? -width : width);
          if (isLeft) {
            setLeftOpen(targetOpen);
            if (targetOpen) setRightOpen(false);
          } else {
            setRightOpen(targetOpen);
            if (targetOpen) setLeftOpen(false);
          }
          // 保持 --drawer-x 为目标值，让 class 的 0.28s 过渡从当前位置吸附过去；
          // 动画结束后定时清理变量（不依赖 transitionend，避免残留覆盖 class transform）
          el.style.transition = '';
          el.style.setProperty('--drawer-x', `${targetV}px`);
          if (settleTimer) window.clearTimeout(settleTimer);
          settleTimer = window.setTimeout(() => {
            settleTimer = null;
            el.style.transition = '';
            el.style.removeProperty('--drawer-x');
          }, SETTLE_MS);
        }
      }
      drawer = null;
    };
    const onCancel = () => {
      if (!drawer) return;
      const el = drawer === 'left' ? leftEl() : rightEl();
      clearDrag(el); // 回弹到 class 当前态
      drawer = null;
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      if (settleTimer) window.clearTimeout(settleTimer);
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onCancel);
    };
  }, []);

  // 回到未选择状态：清空当前会话数据（会话被删除时使用）
  const resetConversation = () => {
    conv.setData({ session: null, messages: [], activePath: [], currentMessageId: null });
    conv.setConversation(null);
  };

  // 加载会话列表
  //  - preferCache=true（启动）：先渲染本地缓存秒开，再后台拉取同步；失败静默保留缓存
  //  - preferCache=false（下拉刷新/删除/重命名后）：直接拉取最新，立即生效
  // 拉取成功后检测：当前打开的会话已不在列表（其他端删除）→ 回到未选择状态
  const loadSessions = async (preferCache = false) => {
    if (preferCache) {
      const cached = loadSessionListCache(token);
      if (cached && cached.sessions.length > 0) setSessions(cached.sessions);
    }
    try {
      const d = await fetchAllSessions({ count: 100 });
      saveSessionListCache(token, d);
      setSessions(d);
      if (conv.sessionId && !d.some((s) => s.id === conv.sessionId)) {
        resetConversation();
      }
    } catch (e) {
      if (!preferCache) console.error('加载会话失败', e);
      // preferCache 失败：保留缓存渲染（本地优先，异步同步失败静默）
    }
  };
  useEffect(() => {
    loadSessions(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // 打开会话：优先命中缓存，否则拉取全部消息并解析
  const openSession = async (id: string) => {
    const seq = ++reqSeq.current;
    setRightOpen(false);
    conv.setConversation(id);

    // 离开当前会话前，把最新消息树快照写回内存缓存
    // （流式/编辑/分支切换直接原地改 conv.messages，只有这里能捕获最终态）
    const prevId = conv.sessionId;
    if (prevId && prevId !== id && conv.session && conv.messages.length > 0) {
      sessionCache.set(prevId, {
        session: conv.session,
        messages: conv.messages,
        activePath: conv.activePath,
        currentMessageId: conv.currentMessageId,
      });
    }

    // 命中缓存：直接秒开，不再请求
    const cached = sessionCache.get(id);
    if (cached) {
      setLeftOpen(false);
      conv.setLoading(false);
      conv.setError(null);
      conv.setData(cached);
      return;
    }

    // 未命中：先清空旧内容进入加载态，避免停留在上一会话的画面
    conv.setLoading(true);
    conv.setError(null);
    conv.setData({ session: null, messages: [], activePath: [], currentMessageId: null });
    try {
      const data = await fetchHistory(id);
      if (seq !== reqSeq.current) return; // 已被更新的切换取代
      const messages = data.chat_messages.map(normalizeMessage);
      const idx = buildIndex(messages);
      const active = activePathOf(idx, data.chat_session.current_message_id);
      const payload: SessionCache = {
        session: data.chat_session,
        messages,
        activePath: active,
        currentMessageId: data.chat_session.current_message_id,
      };
      sessionCache.set(id, payload);
      if (seq !== reqSeq.current) return;
      conv.setData(payload);
    } catch (e: any) {
      if (seq !== reqSeq.current) return;
      conv.setError(e.message || '加载失败');
    } finally {
      if (seq === reqSeq.current) {
        conv.setLoading(false);
        setLeftOpen(false);
      }
    }
  };

  const isOpen = !!conv.sessionId;

  return (
    <div className={`app-shell ${leftOpen ? 'left-open' : ''} ${rightOpen ? 'right-open' : ''}`}>
      {/* 顶部栏 */}
      <header className="topbar">
        <button className="icon-btn" onClick={toggleLeft} aria-label="会话列表">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <div className="topbar-title">
          {conv.session?.title || (isOpen ? '未命名对话' : '')}
        </div>
        <div className="topbar-actions">
          {isOpen && (
            <button className="icon-btn" onClick={toggleRight} aria-label="分支列表">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="6" cy="5" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="19" r="2" />
                <path d="M6 7v10M18 12H8" />
              </svg>
            </button>
          )}
          <button className="icon-btn" onClick={logout} aria-label="退出">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>
        </div>
      </header>

      {/* 左侧滑栏：会话列表 */}
      <div className={`drawer drawer-left ${leftOpen ? 'open' : ''}`}>
        <ConversationList
          sessions={sessions}
          currentId={conv.sessionId}
          onOpen={openSession}
          onSessionsChange={() => loadSessions(false)}
          onRefresh={() => loadSessions(false)}
        />
      </div>

      {/* 右侧滑栏：分支列表 */}
      <div className={`drawer drawer-right ${rightOpen ? 'open' : ''}`}>
        <BranchDrawer
          messages={conv.messages}
          activePath={conv.activePath}
          currentMessageId={conv.currentMessageId}
          onClose={() => setRightOpen(false)}
          onJumped={() => listRef.current?.scrollToBottomAfterPath()}
        />
      </div>

      {/* 遮罩 */}
      {(leftOpen || rightOpen) && (
        <div className="scrim" onClick={() => { setLeftOpen(false); setRightOpen(false); }} />
      )}

      {/* 主区 */}
      <main className="chat-main">
        {!isOpen ? (
          <div className="welcome">
            <h2>还未选择对话</h2>
            <p>打开左侧栏选择已有对话</p>
          </div>
        ) : (
          <MessageView
            ref={listRef}
            sessionId={conv.sessionId!}
            messages={conv.messages}
            activePath={conv.activePath}
            loading={conv.loading}
            error={conv.error}
            onOpenBranch={() => { setLeftOpen(false); setRightOpen(true); }}
            onVisibleChange={setVisibleIds}
            onViewedChange={setViewedId}
          />
        )}

        {isOpen && !conv.editingMessageId && (
          <FloatingDots
            messages={conv.messages}
            activePath={conv.activePath}
            visibleIds={visibleIds}
            currentViewedId={viewedId}
            currentMessageId={conv.currentMessageId}
            onJump={(id) => listRef.current?.scrollToMessage(id)}
          />
        )}

        {isOpen && (
          <InputBar
            sessionId={conv.sessionId!}
          />
        )}
      </main>
    </div>
  );
}
