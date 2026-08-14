// 主聊天区：按活跃路径顺序展示消息，支持加载/错误态与滚动定位
// 每个消息若存在同父兄弟（分支），下方显示"X/Y"切换器

import { Fragment, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { NormalizedMessage } from '../core/api/types';
import { buildIndex, branchSiblings, switchBranchPath } from '../core/api/tree';
import { updateCurrentMessage } from '../core/api/client';
import { useConversation } from '../core/store';
import Markdown from './Markdown';
import FileAttachments from './FileAttachments';

// 分批渲染：首屏只渲染前 BATCH 条，其余在浏览器空闲时分批补齐，
// 避免长会话一次性渲染所有 markdown 造成长时间阻塞。
const BATCH = 20;

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
}

function Bubble({ m }: { m: NormalizedMessage }) {
  const isUser = m.role === 'USER';
  return (
    <div className={`msg-row ${isUser ? 'user' : 'ai'}`} id={`msg-${m.id}`}>
      {!isUser && m.thinking && m.thinking.content && (
        <details className="msg-thinking">
          <summary>已思考（用时 {m.thinking.elapsed_secs ? `${Math.round(m.thinking.elapsed_secs * 10) / 10}` : ''} 秒）</summary>
          <div className="thinking-body">
            <Markdown text={m.thinking.content} />
          </div>
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
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <span className="switcher-label">{index + 1}/{siblings.length}</span>
      <button
        className="switcher-btn"
        disabled={!next}
        onClick={() => next && onSwitch(next.id)}
        aria-label="下一条"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  );
}

const MessageView = forwardRef<MessageViewHandle, Props>(function MessageView(
  { sessionId, messages, activePath, loading, error, onOpenBranch, onVisibleChange },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastReported = useRef<string>('');
  const lastAtBottom = useRef<boolean>(true);
  const setActivePath = useConversation((s) => s.setActivePath);
  const [visibleIds, setVisibleIds] = useState<number[]>([]);
  const [renderCount, setRenderCount] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const btnRef = useRef<HTMLButtonElement>(null);

  // 索引 + 活跃路径消息
  const { idx, pathMessages } = useMemo(() => {
    const index = buildIndex(messages);
    const list = activePath
      .map((id) => index.byId.get(id))
      .filter((it): it is NormalizedMessage => !!it);
    return { idx: index, pathMessages: list };
  }, [messages, activePath]);

  // 路径变化时重置首屏渲染数量
  useEffect(() => {
    setRenderCount(Math.min(BATCH, pathMessages.length));
  }, [pathMessages]);

  // 空闲时分批补齐剩余消息
  useEffect(() => {
    if (renderCount >= pathMessages.length) return;
    const id = scheduleIdle(() => {
      setRenderCount((c) => Math.min(c + BATCH, pathMessages.length));
    });
    return () => cancelIdle(id);
  }, [renderCount, pathMessages.length]);

  // 分支切换：把 switchId 换成 targetId，并下探到该分支默认叶子
  const switchTo = (switchId: number, targetId: number) => {
    const newPath = switchBranchPath(idx, activePath, switchId, targetId);
    const newLeaf = newPath[newPath.length - 1];
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
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  useEffect(() => {
    if (sessionId !== prevSessionId.current) {
      prevSessionId.current = sessionId;
      pendingBottom.current = true;
      // 先回顶，避免残留上一会话的滚动位置
      const el = scrollRef.current;
      if (el) el.scrollTop = 0;
    }
  }, [sessionId]);

  useEffect(() => {
    if (pendingBottom.current && renderCount >= pathMessages.length) {
      pendingBottom.current = false;
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
        reportAtBottom(el);
      }
    }
  }, [renderCount, pathMessages.length, reportAtBottom]);

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
    });
  }, [computeVisible, pathMessages.length, reportAtBottom]);

  // 初次加载 & 路径变化后计算一次
  useEffect(() => {
    computeVisible();
  }, [pathMessages, computeVisible]);

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
          return (
            <Fragment key={m.id}>
              <BubbleMemo m={m} />
              {siblings.length > 1 && (
                <BranchSwitcher siblings={siblings} index={index} onSwitch={(t) => switchTo(m.id, t)} />
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