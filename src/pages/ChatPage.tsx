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

  // 抽屉状态（open class）由 React 提交后，延迟到吸附动画结束（0.28s）再清理 --drawer-x：
  // 此刻 var 值（目标位置）与 class fallback（open→0 / 关闭→±100%）完全相等，
  // 直接 removeProperty 不会产生任何视觉跳变，也绝不打断过渡动画。
  useEffect(() => {
    const t = window.setTimeout(() => {
      for (const el of document.querySelectorAll<HTMLElement>('.drawer-left, .drawer-right')) {
        if (el.style.getPropertyValue('--drawer-x')) {
          el.style.removeProperty('--drawer-x');
        }
      }
    }, 320);
    return () => window.clearTimeout(t);
  }, [leftOpen, rightOpen]);

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
    let drawer: 'left' | 'right' | null = null;
    let startX = 0;
    let startY = 0;
    let width = 336;
    let fromOpen = false; // 拖拽是否从「打开」状态开始
    let v = 0;
    let suppressClick = false; // 拖拽手势结束后抑制 click 穿透（防止误触抽屉内元素）
    // 手势方向锁定：任一轴先超出死区即锁定，之后不可切换。
    //  'x' = 抽屉手势（锁定列表滚动、只跟 x）；'y' = 纵向滚动手势（放行滚动、不接管抽屉）。
    //  避免斜向滑动时「既收起抽屉又滚动列表」。
    let axis: 'x' | 'y' | null = null;

    const leftEl = () => document.querySelector<HTMLElement>('.drawer-left');
    const rightEl = () => document.querySelector<HTMLElement>('.drawer-right');

    // 清理拖拽变量，交还 CSS class 控制 transform（--drawer-x 缺省 = class 默认位置）
    const clearDrag = (el: HTMLElement | null) => {
      if (el) {
        el.style.transition = '';
        el.style.removeProperty('--drawer-x');
      }
    };

    const onStart = (e: TouchEvent) => {
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
      axis = null;
    };
    const onMove = (e: TouchEvent) => {
      if (!drawer) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (axis === null) {
        // 方向竞争：任一轴先超出死区即锁定手势方向（之后不可中途切换）
        if (Math.abs(dx) <= DEAD && Math.abs(dy) <= DEAD) return; // 都在死区内，继续观望
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      if (axis === 'y') return; // 纵向滚动手势：放行列表滚动，全程不接管抽屉
      // 抽屉手势（axis === 'x'）：锁定列表滚动/下拉刷新，抽屉始终跟随 x 位移
      e.preventDefault();
      const isLeft = drawer === 'left';
      // 只跟「拉出方向」：左栏 关闭态右滑/打开态左滑，右栏 关闭态左滑/打开态右滑
      const moving = isLeft ? (fromOpen ? dx < 0 : dx > 0) : (fromOpen ? dx > 0 : dx < 0);
      if (moving) {
        v = isLeft ? Math.min(0, Math.max(-width, startV0() + dx)) : Math.max(0, Math.min(width, startV0() + dx));
        const el = isLeft ? leftEl() : rightEl();
        if (el) {
          el.style.transition = 'none';
          el.style.setProperty('--drawer-x', `${v}px`);
        }
      }
    };
    const startV0 = () => (fromOpen ? 0 : (drawer === 'left' ? -width : width));
    const onEnd = (e: TouchEvent) => {
      if (!drawer) return;
      const isLeft = drawer === 'left';
      const el = isLeft ? leftEl() : rightEl();
      if (axis === 'y') {
        // 纵向滚动手势：抽屉未被拖动，直接清理，不做吸附
        clearDrag(el);
        axis = null;
        drawer = null;
        return;
      }
      if (el) {
        // 用 touchend 实际坐标校正最终位移：
        // 触摸采样稀疏时，最后一个 touchmove 可能滞后于手指位置，导致 v 误判（松手回弹）。
        const ct = e.changedTouches && e.changedTouches[0];
        if (ct) {
          const dx = ct.clientX - startX;
          const dy = ct.clientY - startY;
          if (Math.abs(dx) > DEAD && Math.abs(dx) > Math.abs(dy)) {
            const moving = isLeft ? (fromOpen ? dx < 0 : dx > 0) : (fromOpen ? dx > 0 : dx < 0);
            if (moving) {
              v = isLeft
                ? Math.min(0, Math.max(-width, startV0() + dx))
                : Math.max(0, Math.min(width, startV0() + dx));
            }
          }
        }
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
          // 抑制手势结束后浏览器派发的 click 穿透：
          // touchend 后浏览器会补发 click，若拖拽未超过阈值回弹打开，该 click 会命中抽屉内元素
          // （左栏会话项/右栏分支项）触发 openSession/跳转，造成「闪回完全关闭」的假象。
          suppressClick = true;
          window.setTimeout(() => { suppressClick = false; }, 350);
          // 吸附动画：先恢复 class 的 0.28s 过渡，下一帧（transition 已生效）再写入目标值。
          // 若同一帧内「恢复过渡 + 改 transform」，部分 WebView 会认为变化发生在过渡生效前，
          // 直接跳变到最终位置（无过渡动画），表现为「松手瞬间立即完全关闭」。
          el.style.transition = '';
          requestAnimationFrame(() => {
            el.style.setProperty('--drawer-x', `${targetV}px`);
          });
        }
      }
      axis = null;
      drawer = null;
    };
    const onCancel = () => {
      if (!drawer) return;
      const el = drawer === 'left' ? leftEl() : rightEl();
      clearDrag(el); // 回弹到 class 当前态
      axis = null;
      drawer = null;
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onCancel, { passive: true });
    // 捕获阶段拦截手势拖拽结束后补发的 click（穿透抑制）
    const onClickCapture = (e: MouseEvent) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('click', onClickCapture, true);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onCancel);
      document.removeEventListener('click', onClickCapture, true);
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

      {/* 遮罩：始终挂载，用 opacity 过渡淡入淡出（避免关闭瞬间遮罩突然消失造成视觉闪动） */}
      <div
        className={`scrim ${(leftOpen || rightOpen) ? 'visible' : ''}`}
        onClick={() => { setLeftOpen(false); setRightOpen(false); }}
      />

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
