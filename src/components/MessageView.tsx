// 主聊天区：按活跃路径顺序展示消息，支持加载/错误态与滚动定位
// 每个消息若存在同父兄弟（分支），下方显示"X/Y"切换器

import { Fragment, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NormalizedMessage } from '../core/api/types';
import { buildIndex, branchSiblings, switchBranchPath, activePathOf } from '../core/api/tree';
import { updateCurrentMessage, sendCompletion, fetchHistory, normalizeMessage } from '../core/api/client';
import { useConversation } from '../core/store';
import Markdown from './Markdown';
import FileAttachments from './FileAttachments';

// 分批渲染：首屏只渲染前 BATCH 条，其余在浏览器空闲时分批补齐，
// 避免长会话一次性渲染所有 markdown 造成长时间阻塞。
const BATCH = 20;

// 输入卡片覆盖在消息区底部的高度：定位/可视判断时视口高度应扣除它，避免被输入框遮挡
const INPUT_OVERLAY = 104;

function scheduleIdle(fn: () => void, timeout = 300) {
  const w = window as any;
  if (typeof w.requestIdleCallback === 'function') {
    return w.requestIdleCallback(fn, { timeout });
  }
  return window.setTimeout(fn, timeout);
}
function cancelIdle(id: number) {
  const w = window as any;
  if (typeof w.cancelIdleCallback === 'function') {
    w.cancelIdleCallback(id);
  } else {
    window.clearTimeout(id);
  }
}

export interface MessageViewHandle {
  scrollToMessage: (id: number) => void;
  scrollToBottom: () => void;
}

interface Props {
  sessionId: string;
  messages: NormalizedMessage[];
  activePath: number[];
  loading: boolean;
  error: string | null;
  onOpenBranch: () => void;
  onVisibleChange?: (ids: number[]) => void;
  onViewedChange?: (id: number | null) => void;
}

function Bubble({ m }: { m: NormalizedMessage }) {
  const isUser = m.role === 'USER';
  return (
    <div className={`msg-row ${isUser ? 'user' : 'ai'}`} id={`msg-${m.id}`}>
      {!isUser && m.thinking && (
        <details className="msg-thinking">
          <summary>
            <span>
              {m.thinking.elapsed_secs != null
                ? `已思考 ${Math.round(m.thinking.elapsed_secs * 10) / 10} 秒`
                : '正在思考…'}
            </span>
            <svg className="think-arrow" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </summary>
          {m.thinking.content && (
            <div className="thinking-body">
              <Markdown text={m.thinking.content} />
            </div>
          )}
        </details>
      )}
      <div className="msg-bubble">
        <div className="msg-content">
          {/* 用户消息是原始文本；AI 消息才需要 markdown */}
          {isUser ? m.content : <Markdown text={m.content} />}
        </div>
        <FileAttachments files={m.files} />
      </div>
    </div>
  );
}

// memo：消息对象引用不变则不重渲染，避免父组件重渲染时全量重解析 markdown
const BubbleMemo = memo(Bubble);

// 分支切换器：X/Y，左右切换同父的其他兄弟消息
function BranchSwitcher({
  siblings,
  index,
  onSwitch,
}: {
  siblings: NormalizedMessage[];
  index: number;
  onSwitch: (targetId: number) => void;
}) {
  const prev = siblings[index - 1];
  const next = siblings[index + 1];
  return (
    <div className="branch-switcher">
      <button
        className="switcher-btn"
        disabled={!prev}
        onClick={() => prev && onSwitch(prev.id)}
        aria-label="上一条"
      >
        <svg width="10" height="10" viewBox="0 0 10 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 1.5L2.5 6 7 10.5" />
        </svg>
      </button>
      <span className="switcher-label">{index + 1}／{siblings.length}</span>
      <button
        className="switcher-btn"
        disabled={!next}
        onClick={() => next && onSwitch(next.id)}
        aria-label="下一条"
      >
        <svg width="10" height="10" viewBox="0 0 10 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 1.5L7.5 6 3 10.5" />
        </svg>
      </button>
    </div>
  );
}

// 最新 AI 消息下方的操作行：左为分支切换器 + 复制原始文本，右为重新生成。
// 分支切换器仅在存在同父兄弟时显示，与复制按钮同一行。
function MessageActions({
  siblings,
  index,
  onSwitch,
  onCopy,
  onRegenerate,
  regenerating,
  regenDisabled,
}: {
  siblings: NormalizedMessage[];
  index: number;
  onSwitch: (targetId: number) => void;
  onCopy: () => void;
  onRegenerate: () => void;
  regenerating: boolean;
  regenDisabled: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const toastTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  // 显示 Toast：先放大进入，约 1s 后缩小退出并复位按钮状态
  const showToast = (text: string) => {
    setClosing(false);
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setClosing(true);
      closeTimer.current = window.setTimeout(() => {
        setToast(null);
        setClosing(false);
        setCopied(false);
      }, 150);
    }, 1000);
  };

  const handleCopy = () => {
    if (copied) return; // 复制提示期间忽略再次点击
    onCopy();
    setCopied(true);
    showToast('已复制');
  };

  const handleRegenerate = () => {
    if (regenerating) return;
    if (regenDisabled) {
      showToast('重新生成次数超过限制');
      return;
    }
    onRegenerate();
  };

  return (
    <div className="msg-actions">
      <div className="msg-actions-left">
        {siblings.length > 1 && (
          <BranchSwitcher siblings={siblings} index={index} onSwitch={onSwitch} />
        )}
        <button
          className="msg-action-btn"
          onClick={handleCopy}
          disabled={copied}
          title={copied ? '已复制' : '复制原始文本'}
        >
          {copied ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          )}
        </button>
      </div>
      <div className="msg-actions-right">
        <button
          className="msg-action-btn"
          onClick={handleRegenerate}
          disabled={regenerating}
          style={regenDisabled ? { opacity: 0.4, cursor: 'default' } : undefined}
          title={regenerating ? '生成中…' : regenDisabled ? '已达到生成次数上限' : '重新生成'}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 11-2.6-6.3" /><path d="M21 3v6h-6" />
          </svg>
        </button>
      </div>
      {toast &&
        createPortal(
          <div className={`toast-center${closing ? ' toast-center--out' : ''}`}>{toast}</div>,
          document.body,
        )}
    </div>
  );
}

const MessageView = forwardRef<MessageViewHandle, Props>(function MessageView(
  { sessionId, messages, activePath, loading, error, onOpenBranch, onVisibleChange, onViewedChange },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastReported = useRef<string>('');
  const lastAtBottom = useRef<boolean>(true);
  const lastViewed = useRef<number | null>(null);
  const setActivePath = useConversation((s) => s.setActivePath);
  const setData = useConversation((s) => s.setData);
  const [visibleIds, setVisibleIds] = useState<number[]>([]);
  const [renderCount, setRenderCount] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  // 索引 + 活跃路径消息
  const { idx, pathMessages } = useMemo(() => {
    const index = buildIndex(messages);
    const list = activePath
      .map((id) => index.byId.get(id))
      .filter((it): it is NormalizedMessage => !!it);
    return { idx: index, pathMessages: list };
  }, [messages, activePath]);

  // 最新 AI 消息（活跃路径上最后一条 ASSISTANT）
  const lastAi = useMemo(() => {
    for (let i = pathMessages.length - 1; i >= 0; i--) {
      if (pathMessages[i].role === 'ASSISTANT') return pathMessages[i];
    }
    return null;
  }, [pathMessages]);

  // 重新生成后从服务器重拉并刷新整个会话
  const refreshFromServer = useCallback(async () => {
    if (!sessionId) return;
    const data = await fetchHistory(sessionId);
    const msgs = data.chat_messages.map(normalizeMessage);
    const newIdx = buildIndex(msgs);
    const active = activePathOf(newIdx, data.chat_session.current_message_id);
    setData({
      session: data.chat_session,
      messages: msgs,
      activePath: active,
      currentMessageId: data.chat_session.current_message_id,
    });
  }, [sessionId, setData]);

  // 重新生成：在最新 AI 消息的父提问下新建 AI 回复
  const handleRegenerate = useCallback(async (m: NormalizedMessage) => {
    if (!sessionId || regenerating) return;
    if (m.parent_id === null) return;
    const parent = idx.byId.get(m.parent_id);
    if (!parent) return;
    setRegenerating(true);
    try {
      await sendCompletion(
        { chat_session_id: sessionId, parent_message_id: parent.id, prompt: parent.content },
        () => {},
      );
      await refreshFromServer();
    } catch (e: any) {
      console.error('重新生成失败', e);
    } finally {
      setRegenerating(false);
    }
  }, [sessionId, regenerating, idx, refreshFromServer]);

  const handleCopy = useCallback(async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* 剪贴板不可用时静默 */ }
  }, []);

  // 路径变化时重置首屏渲染数量
  useEffect(() => {
    if (forceFullRender.current) {
      // 分支切换：一次性渲染整条路径，保证 scrollHeight 完整、新切换器可定位
      forceFullRender.current = false;
      setRenderCount(pathMessages.length);
      const relPos = anchorPosRef.current;
      const targetId = anchorTargetRef.current;
      anchorPosRef.current = null;
      anchorTargetRef.current = null;
      if (relPos !== null && targetId != null) {
        // 渲染完成后（下一帧）把目标切换器一次性拉回原位；内容不足时贴底
        requestAnimationFrame(() => {
          const sc = scrollRef.current;
          const row = sc?.querySelector(`#msg-${targetId}`);
          const sw = row?.nextElementSibling;
          if (!sc || !sw || !(sw.classList.contains('branch-switcher') || sw.classList.contains('msg-actions'))) return;
          const newTop = sw.getBoundingClientRect().top - sc.getBoundingClientRect().top;
          sc.scrollTop += newTop - relPos;
          if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1) {
            sc.scrollTop = sc.scrollHeight; // 下方内容不足 → 贴底
          }
        });
      }
    } else {
      setRenderCount(Math.min(BATCH, pathMessages.length));
    }
  }, [pathMessages]);

  // 空闲时分批补齐剩余消息
  useEffect(() => {
    if (renderCount >= pathMessages.length) return;
    const id = scheduleIdle(() => {
      setRenderCount((c) => Math.min(c + BATCH, pathMessages.length));
    });
    return () => cancelIdle(id);
  }, [renderCount, pathMessages.length]);

  // 分支切换：把 switchId 换成 targetId，并下探到该分支默认叶子。
  // 切换前记录"被操作的切换器"（操作栏或分支切换器）的位置，切换后把它一次性拉回原位，保证视觉不跳动。
  const switchTo = (switchId: number, targetId: number) => {
    const scroll = scrollRef.current;
    let relPos: number | null = null;
    if (scroll) {
      const oldRow = scroll.querySelector(`#msg-${switchId}`);
      const sw = oldRow?.nextElementSibling;
      if (sw && (sw.classList.contains('branch-switcher') || sw.classList.contains('msg-actions'))) {
        relPos = sw.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      }
    }
    const newPath = switchBranchPath(idx, activePath, switchId, targetId);
    const newLeaf = newPath[newPath.length - 1];
    forceFullRender.current = true; // 一次渲染整条路径，保证新切换器可被定位
    anchorPosRef.current = relPos;
    anchorTargetRef.current = targetId;
    setActivePath(newPath, newLeaf);
    if (sessionId) {
      updateCurrentMessage(sessionId, newLeaf).catch((e) =>
        console.error('设置服务器当前位置失败', e),
      );
    }
  };

  // 外部跳转定位（悬浮原点）
  useImperativeHandle(ref, () => ({
    scrollToMessage(id) {
      // 目标尚未渲染时先补齐到该条，保证能定位
      const targetIndex = pathMessages.findIndex((m) => m.id === id);
      if (targetIndex >= 0 && targetIndex + 1 > renderCount) {
        setRenderCount(targetIndex + 1);
      }
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${id}`);
        const scroll = scrollRef.current;
        if (!el || !scroll) return;
        const rect = el.getBoundingClientRect();
        const scrollTop = scroll.getBoundingClientRect().top;
        const relTop = rect.top - scrollTop; // 目标相对滚动容器顶部的偏移
        const relBottom = relTop + rect.height;
        // 视口高度扣除输入卡片遮挡，定位到其上方
        const viewH = scroll.clientHeight - INPUT_OVERLAY;
        const mid = viewH / 2;

        let block: ScrollLogicalPosition;
        if (relTop >= 0 && relBottom <= viewH) {
          // 目标已在有效视口内（当前可见）→ 定位到离窗口中心更远的边缘
          const topDist = Math.abs(relTop - mid);
          const bottomDist = Math.abs(relBottom - mid);
          block = bottomDist > topDist ? 'end' : 'start';
        } else if (relTop + rect.height / 2 < mid) {
          // 目标在当前位置上方 → 上边缘对齐视口最上方
          block = 'start';
        } else {
          // 目标在当前位置下方 → 下边缘对齐视口最下方（避开输入框）
          block = 'end';
        }
        el.scrollIntoView({ behavior: 'smooth', block });
      });
    },
    scrollToBottom() {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    },
  }), [pathMessages, renderCount]);

  // 判断是否接近底部，供"回到底部"按钮显隐
  const reportAtBottom = useCallback((el: HTMLElement) => {
    const ab = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (ab !== lastAtBottom.current) {
      lastAtBottom.current = ab;
      setAtBottom(ab);
    }
  }, []);

  // 初次加载/切换会话：等全部消息分批渲染完成后滚到底。
  // 若在渲染中途就滚，scrollHeight 不完整，会停在不完整的位置。
  // 以 sessionId 变化为触发（而非消息数量），避免切换数量相同的会话时不滚。
  const prevSessionId = useRef<string | null>(null);
  const pendingBottom = useRef(false);
  // 分支切换时置位：下一次路径变化一次性渲染整条路径，避免分批渲染导致 scrollHeight 骤减、
  // scrollTop 被 clamp 到局部位置、切换后停在顶部附近。
  const forceFullRender = useRef(false);
  // 分支切换前记录操作栏的相对位置，渲染完成后一次性把它拉回该位置（避免滚动跳动）
  const anchorPosRef = useRef<number | null>(null);
  // 分支切换后要锚定位置的切换器所属的目标消息 id
  const anchorTargetRef = useRef<number | null>(null);
  // useLayoutEffect：会话切换时直接定位到底部（不先显示顶部），且不保留旧会话位置
  useLayoutEffect(() => {
    if (sessionId !== prevSessionId.current) {
      prevSessionId.current = sessionId;
      pendingBottom.current = true;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [sessionId]);

  useEffect(() => {
    // 分批渲染期间持续跟随底部，渲染完成后清标记
    if (pendingBottom.current && pathMessages.length > 0) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      if (renderCount >= pathMessages.length) {
        pendingBottom.current = false;
        if (el) reportAtBottom(el);
      }
    }
  }, [renderCount, pathMessages.length, reportAtBottom]);

  // 乐观追加/流式生成时：若用户之前在底部则保持滚到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el && lastAtBottom.current) el.scrollTop = el.scrollHeight;
  }, [pathMessages]);

  // 计算当前视口内可见的消息 id，供悬浮原点跟随滚动
  const computeVisible = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    const ids: number[] = [];
    el.querySelectorAll<HTMLElement>('.msg-row').forEach((row) => {
      const id = Number(row.id.replace('msg-', ''));
      if (!Number.isFinite(id)) return;
      const r = row.offsetTop;
      const h = row.offsetHeight;
      // 与视口相交（含边界）
      if (r < bottom && r + h > top) ids.push(id);
    });
    const key = ids.join(',');
    if (key !== lastReported.current) {
      lastReported.current = key;
      setVisibleIds(ids);
      onVisibleChange?.(ids);
    }
  }, [onVisibleChange]);

  // 计算当前查看的消息：被滚动区中心线穿过的消息；
  // 若中心线恰好落在两条消息交界（未穿过任何），fallback 到下方最近的那条
  const computeViewed = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const centerY = rect.top + (el.clientHeight - INPUT_OVERLAY) / 2;
    let found: number | null = null;
    let fallback: number | null = null;
    el.querySelectorAll<HTMLElement>('.msg-row').forEach((row) => {
      const id = Number(row.id.replace('msg-', ''));
      if (!Number.isFinite(id)) return;
      const r = row.getBoundingClientRect();
      if (r.top <= centerY && r.bottom >= centerY) {
        found = id;
      } else if (r.top > centerY && fallback === null) {
        fallback = id;
      }
    });
    const viewed = found ?? fallback;
    if (viewed !== lastViewed.current) {
      lastViewed.current = viewed;
      onViewedChange?.(viewed);
    }
  }, [onViewedChange]);

  const onScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      // 滚动接近底部时提前补齐未渲染消息，避免空白
      const el = scrollRef.current;
      if (el) {
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
          setRenderCount((c) => Math.min(c + BATCH, pathMessages.length));
        }
        reportAtBottom(el);
      }
      computeVisible();
      computeViewed();
    });
  }, [computeVisible, computeViewed, pathMessages.length, reportAtBottom]);

  // 初次加载 & 路径变化后计算一次
  useEffect(() => {
    computeVisible();
    computeViewed();
  }, [pathMessages, computeVisible, computeViewed]);

  // 上报给父级（供 FloatingDots）
  useEffect(() => {
    onVisibleChange?.(visibleIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 回到底部按钮右边界对齐 AI 消息右边界：right = 内容 padding(24px) + 滚动条宽度。
  // 依赖 atBottom：按钮仅在 !atBottom 时渲染，需在按钮出现后再计算。
  useEffect(() => {
    const scroll = scrollRef.current;
    const btn = btnRef.current;
    const update = () => {
      if (!scroll || !btn) return;
      const barW = scroll.offsetWidth - scroll.clientWidth;
      btn.style.right = `${24 + barW}px`;
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [atBottom]);

  const scrollToBottomSelf = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="msg-wrap">
      <div className="msg-scroll" ref={scrollRef} onScroll={onScroll}>
        {loading && <div className="msg-state">加载中…</div>}
        {!loading && error && (
          <div className="msg-state error">
            <span>{error}</span>
            <button className="retry-btn" onClick={onOpenBranch}>打开分支列表</button>
          </div>
        )}
        {!loading && !error && pathMessages.length === 0 && (
          <div className="msg-state empty">这条路径还没有消息，从下方输入开始对话</div>
        )}
        {pathMessages.slice(0, renderCount).map((m) => {
          const { siblings, index } = branchSiblings(idx, m.id);
          const isLastAi = lastAi !== null && m.id === lastAi.id;
          return (
            <Fragment key={m.id}>
              <BubbleMemo m={m} />
              {isLastAi ? (
                <MessageActions
                  siblings={siblings}
                  index={index}
                  onSwitch={(t) => switchTo(m.id, t)}
                  onCopy={() => lastAi && handleCopy(lastAi.content)}
                  onRegenerate={() => lastAi && handleRegenerate(lastAi)}
                  regenerating={regenerating}
                  regenDisabled={siblings.length >= 6}
                />
              ) : (
                siblings.length > 1 && (
                  <BranchSwitcher siblings={siblings} index={index} onSwitch={(t) => switchTo(m.id, t)} />
                )
              )}
            </Fragment>
          );
        })}
      </div>
      {!atBottom && (
        <button
          ref={btnRef}
          className="scroll-bottom-btn"
          onClick={scrollToBottomSelf}
          aria-label="回到底部"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 9l7 7 7-7" />
          </svg>
        </button>
      )}
    </div>
  );
});

export default MessageView;