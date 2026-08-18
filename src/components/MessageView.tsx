// 主聊天区：按活跃路径顺序展示消息，支持加载/错误态与滚动定位
// 每个消息若存在同父兄弟（分支），下方显示"X/Y"切换器

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NormalizedMessage } from '../core/api/types';
import { buildIndex, branchSiblings, switchBranchPath, activePathOf } from '../core/api/tree';
import { regenerateMessage, fetchHistory, normalizeMessage, enrichMessageFiles, ApiError } from '../core/api/client';
import { DeltaParser, nextTempId } from '../core/api/delta';
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
  scrollToBottomAfterPath: () => void;
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

function Bubble({ m, onToggleActions }: { m: NormalizedMessage; onToggleActions?: () => void }) {
  const isUser = m.role === 'USER';
  const setEditingMessageId = useConversation((s) => s.setEditingMessageId);
  const activePath = useConversation((s) => s.activePath);
  const editingMessageId = useConversation((s) => s.editingMessageId);

  // 长按用户消息 → 编辑重发：将消息内容填入输入框
  const handleEdit = () => {
    if (!isUser || m.ban_edit) return;
    // 找到该消息在活跃路径上的位置，确认它是当前路径上的消息
    if (!activePath.includes(m.id)) return;
    // 找到该用户消息对应的输入框（InputBar 监听 store 中 editingMessageId 变化）
    setEditingMessageId(m.id);
    // 将消息内容填入输入框
    const textarea = document.querySelector('.input-card textarea') as HTMLTextAreaElement | null;
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, m.content);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
    }
  };

  // 点击 AI 消息展开/收起操作栏；忽略点击可交互元素（链接/按钮/thinking 标题等）内部
  const handleToggle = (e: React.MouseEvent) => {
    if (!onToggleActions) return;
    const t = e.target as HTMLElement;
    if (t.closest('a, button, summary, input, textarea')) return;
    onToggleActions();
  };

  // thinking 块受控展开/收起（带高度推拉动画）：
  // 用实测内联 height 过渡替代 grid-template-rows（后者在 WebView 上逐帧触发 layout）。
  // 高度变化的"内容跑到上方/标题弹出视口"，根因是滚动容器默认 overflow-anchor 会补偿滚动，
  // 所以动画期间临时关掉容器锚定；并在标题 flow 位置贴住/超出视口上缘时，把它最小对齐到顶部。
  // 其余情况（标题完整可见）不做任何滚动，原地推拉
  const [thinkOpen, setThinkOpen] = useState(false);
  const thinkBtnRef = useRef<HTMLButtonElement>(null);
  const thinkingBodyRef = useRef<HTMLDivElement>(null);
  const thinkOpening = useRef(false); // 记录本次过渡是展开还是收起，用于 transitionend 收尾

  // 标题 flow（未吸顶）位置若已贴住/超出视口上缘，则滚动让它刚好对齐到顶部
  const settleTitle = () => {
    const sc2 = document.querySelector('.msg-scroll') as HTMLElement | null;
    const btn2 = thinkBtnRef.current;
    if (!sc2 || !btn2) return;
    const saved = btn2.style.position;
    btn2.style.position = 'static'; // 临测未吸顶的 flow 位置
    const flowTop = btn2.getBoundingClientRect().top - sc2.getBoundingClientRect().top;
    btn2.style.position = saved;
    if (flowTop <= 4) sc2.scrollTop += flowTop; // 已贴顶或超出 → 上移对齐
  };

  const handleThinkToggle = () => {
    const body = thinkingBodyRef.current;
    const sc = document.querySelector('.msg-scroll') as HTMLElement | null;
    // 动画期间关掉滚动容器锚定，消除高度变化引发的补偿滚动；
    // 用 dataset 记录锁定时刻，稍后由 onScroll（用户手动滚动）恢复，
    // 避免在动画结束后立刻恢复触发浏览器重锚定跳回标题上方
    if (sc) {
      sc.style.overflowAnchor = 'none';
      sc.dataset.thinkAnchorLocked = String(Date.now());
    }
    if (!thinkOpen) {
      // 展开：先锁在 0，量好目标高度后 rAF 过渡到该高度。
      // 展开不改滚动（避免网页端 onScroll→重渲染把该块重挂载导致立刻收起），
      // "内容往下推/不跑到上方"由关闭容器锚定保证
      thinkOpening.current = true;
      setThinkOpen(true);
      if (body) {
        body.style.height = '0px';
        body.getBoundingClientRect(); // 强制回流，确保从 0 起动画
        const full = body.scrollHeight;
        requestAnimationFrame(() => {
          if (body) body.style.height = full + 'px';
        });
      }
    } else {
      // 收起前先 settleTitle：标题 flow 已贴住/超出视口上缘时上移对齐，避免包含块变矮
      // 触发 sticky 释放导致标题弹出视口
      thinkOpening.current = false;
      settleTitle();
      setThinkOpen(false);
      if (body) {
        body.style.height = body.offsetHeight + 'px';
        body.getBoundingClientRect();
        requestAnimationFrame(() => {
          if (body) body.style.height = '0px';
        });
      }
    }
  };
  const handleThinkTransitionEnd = (e: React.TransitionEvent) => {
    if (e.target !== thinkingBodyRef.current) return;
    if (e.propertyName !== 'height') return;
    const body = thinkingBodyRef.current;
    if (thinkOpening.current && body) {
      // 展开完成：解除内联高度，交给内容自适应（流式更新时不被裁剪）
      thinkOpening.current = false;
      body.style.height = '';
    }
    // 不在此处恢复容器锚定——恢复会触发浏览器重锚定，导致网页端展开完立刻跳回标题上方。
    // 锚定延迟到用户真正开始手动滚动（onScroll，且距上次切换 >350ms）后再恢复
  };

  return (
    <div
      className={`msg-row ${isUser ? 'user' : 'ai'}${m.id === editingMessageId ? ' editing' : ''}`}
      id={`msg-${m.id}`}
      onClick={onToggleActions ? handleToggle : undefined}
      onContextMenu={isUser && !m.ban_edit ? (e) => { e.preventDefault(); handleEdit(); } : undefined}
    >
      {!isUser && m.thinking && (
        <div className={`msg-thinking${thinkOpen ? ' open' : ''}`}>
          <button
            type="button"
            className="msg-thinking-toggle"
            ref={thinkBtnRef}
            onClick={handleThinkToggle}
          >
            <span>
              {m.thinking.elapsed_secs != null
                ? `已思考 ${Math.round(m.thinking.elapsed_secs * 10) / 10} 秒`
                : '正在思考…'}
            </span>
            <svg className="think-arrow" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
          {m.thinking.content && (
            <div className="thinking-body" ref={thinkingBodyRef} onTransitionEnd={handleThinkTransitionEnd}>
              <div className="thinking-body-inner">
                <Markdown text={m.thinking.content} />
              </div>
            </div>
          )}
        </div>
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
  disabled,
}: {
  siblings: NormalizedMessage[];
  index: number;
  onSwitch: (targetId: number) => void;
  disabled?: boolean;
}) {
  const prev = siblings[index - 1];
  const next = siblings[index + 1];
  return (
    <div className="branch-switcher">
      <button
        className="switcher-btn"
        disabled={!prev || disabled}
        onClick={() => prev && onSwitch(prev.id)}
        aria-label="上一条"
      >
        <svg width="10" height="10" viewBox="0 0 10 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 1.5L2.5 6 7 10.5" />
        </svg>
      </button>
      <span className="switcher-label">{index + 1}/{siblings.length}</span>
      <button
        className="switcher-btn"
        disabled={!next || disabled}
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
  hidden,
  siblings,
  index,
  onSwitch,
  onCopy,
  onRegenerate,
  regenerating,
  regenDisabled,
}: {
  hidden?: boolean;
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
    <div className={`msg-actions${hidden ? ' hidden' : ''}`}>
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

// 单条消息块：气泡 + 操作栏。AI 消息操作栏默认隐藏（不占高度），
// 点击气泡展开/收起；有分支切换器时操作栏内一并显示（合并）。
function MessageBlock({
  m,
  siblings,
  index,
  onSwitch,
  onCopy,
  onRegenerate,
  regenerating,
  regenDisabled,
  scrollEl,
  streaming,
  isLast,
}: {
  m: NormalizedMessage;
  siblings: NormalizedMessage[];
  index: number;
  onSwitch: (targetId: number) => void;
  onCopy: () => void;
  onRegenerate: () => void;
  regenerating: boolean;
  regenDisabled: boolean;
  scrollEl: HTMLElement | null;
  streaming: boolean;
  isLast: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const blockRef = useRef<HTMLDivElement>(null);
  const prevBubbleTop = useRef<number | null>(null);

  // 切换操作栏显隐：先记录气泡相对滚动容器的位置，渲染提交后补偿 scrollTop，
  // 让消息正文在展开/收起期间保持屏幕位置（操作栏在气泡下方，其显隐会改变块高度引发重排）。
  const toggle = useCallback(() => {
    if (scrollEl && blockRef.current) {
      const bubble = blockRef.current.querySelector('.msg-bubble');
      if (bubble) {
        prevBubbleTop.current =
          bubble.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
      }
    }
    setExpanded((v) => !v);
  }, [scrollEl]);

  useLayoutEffect(() => {
    if (!scrollEl || !blockRef.current || prevBubbleTop.current == null) return;
    const bubble = blockRef.current.querySelector('.msg-bubble');
    if (!bubble) return;
    const top = bubble.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
    scrollEl.scrollTop += top - prevBubbleTop.current;
    prevBubbleTop.current = null;
  }, [expanded, scrollEl]);

  const isAi = m.role === 'ASSISTANT';

  return (
    <div className="msg-block" ref={blockRef}>
      <BubbleMemo m={m} onToggleActions={isAi && !isLast ? toggle : undefined} />
      {isAi &&
        (isLast || expanded ? (
          // 展开/最新消息：完整操作栏（含分支切换器，合并显示）
          <MessageActions
            siblings={siblings}
            index={index}
            onSwitch={onSwitch}
            onCopy={onCopy}
            onRegenerate={onRegenerate}
            regenerating={regenerating}
            regenDisabled={regenDisabled}
          />
        ) : (
          // 未展开：有分支的消息常驻显示分支切换器
          siblings.length > 1 && (
            <BranchSwitcher
              siblings={siblings}
              index={index}
              onSwitch={onSwitch}
              disabled={streaming && siblings.some((s) => s.id < 0)}
            />
          )
        ))}
      {/* 用户消息：有同父兄弟（多分支）时也常驻显示分支切换器 */}
      {!isAi && siblings.length > 1 && (
        <BranchSwitcher
          siblings={siblings}
          index={index}
          onSwitch={onSwitch}
          disabled={streaming && siblings.some((s) => s.id < 0)}
        />
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
  const inputTall = useConversation((s) => s.inputTall);
  const streaming = useConversation((s) => s.streaming);
  const setStreaming = useConversation((s) => s.setStreaming);
  const editingMessageId = useConversation((s) => s.editingMessageId);
  const setEditingMessageId = useConversation((s) => s.setEditingMessageId);
  const [visibleIds, setVisibleIds] = useState<number[]>([]);
  const [renderCount, setRenderCount] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastClosing, setToastClosing] = useState(false);
  const toastTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);
  const btnRef = useRef<HTMLButtonElement>(null);

  // 显示居中 Toast（放大进入，约 1s 后缩小退出）
  const showToast = (msg: string) => {
    setToastClosing(false);
    setToast(msg);
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

  // 索引 + 活跃路径消息
  const { idx, pathMessages } = useMemo(() => {
    const index = buildIndex(messages);
    const list = activePath
      .map((id) => index.byId.get(id))
      .filter((it): it is NormalizedMessage => !!it);
    return { idx: index, pathMessages: list };
  }, [messages, activePath]);

  // 最新 AI 消息（活跃路径上最后一条 ASSISTANT）：操作栏始终显示
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
    const apply = (msgs: NormalizedMessage[]) => {
      const newIdx = buildIndex(msgs);
      const active = activePathOf(newIdx, data.chat_session.current_message_id);
      setData({
        session: data.chat_session,
        messages: msgs,
        activePath: active,
        currentMessageId: data.chat_session.current_message_id,
      });
    };
    // 先渲染，再后台富化文件签名（不阻塞刷新）
    apply(data.chat_messages.map(normalizeMessage));
    void enrichMessageFiles(data.chat_messages)
      .then((enriched) => apply(enriched.map(normalizeMessage)))
      .catch(() => {});
  }, [sessionId, setData]);

  // 重新生成：调 /chat/regenerate 在父提问下创建新 AI 分支。
  // 乐观 UI：追加虚拟 AI 消息并切换到该分支（原回复保留为兄弟分支，切换器数量 +1），
  // 流式写入虚拟消息，完成后用服务器真实数据替换；失败撤回虚拟消息并恢复原路径。
  const handleRegenerate = useCallback(async (m: NormalizedMessage) => {
    if (!sessionId || regenerating || streaming) return;
    if (m.id < 0 || m.parent_id === null) return; // 虚拟消息（编辑/生成中）不可再生成
    const aiIdx = activePath.lastIndexOf(m.id);
    if (aiIdx < 0) return;
    const prevPath = activePath;
    setRegenerating(true);
    setStreaming(true);

    const tempAiId = nextTempId();
    useConversation.setState((s) => ({
      messages: [
        ...s.messages,
        {
          id: tempAiId,
          parent_id: m.parent_id,
          role: 'ASSISTANT',
          content: '',
          thinking: null,
          model: '',
          status: 'FINISHED',
          token_usage: null,
          thinking_enabled: m.thinking_enabled ?? true,
          search_enabled: m.search_enabled ?? true,
          ban_edit: false,
          ban_regenerate: false,
          files: [],
          feedback: null,
          search_results: null,
          tips: [],
          inserted_at: Date.now() / 1000,
        },
      ],
      activePath: [...s.activePath.slice(0, aiIdx), tempAiId],
      currentMessageId: tempAiId,
    }));

    try {
      const parser = new DeltaParser();
      let seenThink = false;
      let thinkContent = '';
      let thinkElapsed: number | null = null;
      let bodyContent = '';
      const applyStream = () => {
        useConversation.setState((s) => ({
          messages: s.messages.map((x) =>
            x.id === tempAiId
              ? {
                  ...x,
                  content: bodyContent,
                  thinking: seenThink ? { content: thinkContent, elapsed_secs: thinkElapsed } : null,
                }
              : x,
          ),
        }));
      };
      await regenerateMessage(
        {
          chat_session_id: sessionId,
          child_message_id: m.id,
          thinking_enabled: m.thinking_enabled ?? true,
          search_enabled: m.search_enabled ?? true,
        },
        (ev) => {
          for (const op of parser.parse(ev)) {
            const p = op.path;
            const v = op.value;
            if (p === 'response/thinking_content') {
              if (typeof v === 'string') {
                seenThink = true;
                thinkContent = op.op === 'SET' ? v : thinkContent + v;
              }
            } else if (p === 'response/thinking_elapsed_secs' && typeof v === 'number') {
              seenThink = true;
              thinkElapsed = v;
            } else if (p === 'response/content') {
              if (typeof v === 'string') {
                bodyContent = op.op === 'SET' ? v : bodyContent + v;
              }
            }
          }
          applyStream();
        },
      );
      await refreshFromServer();
    } catch (e: any) {
      console.error('重新生成失败', e);
      useConversation.setState((s) => ({
        messages: s.messages.filter((x) => x.id !== tempAiId),
        activePath: prevPath,
        currentMessageId: prevPath[prevPath.length - 1] ?? null,
      }));
      // 服务端拒绝（"ban regenerate" / "重新生成次数超过限制"）映射为友好文案；
      // 其余错误透出失败提示
      const text = e instanceof ApiError ? e.message : '';
      if (/ban regenerate/i.test(text)) {
        showToast('该消息暂不支持重新生成');
      } else if (/regeneration_limit|次数|limit/i.test(text)) {
        showToast('重新生成次数超过限制');
      } else {
        showToast(text || '重新生成失败');
      }
    } finally {
      setRegenerating(false);
      setStreaming(false);
    }
  }, [sessionId, regenerating, streaming, activePath, refreshFromServer]);

  const handleCopy = useCallback(async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* 剪贴板不可用时静默 */ }
  }, []);

  // 编辑重发/重新生成：路径尾部切换为虚拟消息（负 id，可能截断也可能等长替换），
  // 以及流式结束后虚拟路径被服务器真实数据替换（上次尾部为负 id），
  // 均视作分支切换：置位 forceFullRender 一次性渲染整条路径，避免 renderCount 重置导致视口内容突变
  const prevPathRef = useRef<number[]>(activePath);
  useEffect(() => {
    const prev = prevPathRef.current;
    prevPathRef.current = activePath;
    const tail = activePath[activePath.length - 1];
    const prevTail = prev[prev.length - 1];
    if ((tail !== undefined && tail < 0) || prevTail < 0) {
      forceFullRender.current = true;
    }
  }, [activePath]);

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
    // 分支路径切换后立即滚到底：置位 pendingBottom，分批渲染补齐期间持续跟随底部
    scrollToBottomAfterPath() {
      pendingBottom.current = true;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
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
  // 用屏幕坐标判断与滚动容器视口的相交，兼容 column-reverse 布局
  const computeVisible = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const er = el.getBoundingClientRect();
    const ids: number[] = [];
    el.querySelectorAll<HTMLElement>('.msg-row').forEach((row) => {
      const id = Number(row.id.replace('msg-', ''));
      if (!Number.isFinite(id)) return;
      const r = row.getBoundingClientRect();
      // 与视口相交（含边界）
      if (r.top < er.bottom && r.bottom > er.top) ids.push(id);
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
      // 自底向上渲染：未渲染的更早消息在顶部，滚动接近顶部时提前补齐，避免空白
      const el = scrollRef.current;
      if (el) {
        // thinking 切换时临时关掉了容器锚定：待动画结束(>350ms)后，用户手动滚动时再恢复，
        // 避免在展开/收起完成后立刻恢复被浏览器重锚定跳移
        if (el.style.overflowAnchor === 'none' && el.dataset.thinkAnchorLocked) {
          const locked = Number(el.dataset.thinkAnchorLocked);
          if (Date.now() - locked > 350) {
            el.style.overflowAnchor = '';
            delete el.dataset.thinkAnchorLocked;
          }
        }
        if (el.scrollTop < 240) {
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

  // 回到底部按钮右边界对齐 AI 消息右边界：right = 内容 padding(22px) + 滚动条宽度。
  // 22 = msg-block 左右 padding(16px) + msg-row.ai 左右 padding(6px)；
  // 左右 padding 在 msg-block 上（不在 .msg-scroll），故不含 scroll padding。
  // 依赖 atBottom：按钮仅在 !atBottom 时渲染，需在按钮出现后再计算。
  useEffect(() => {
    const scroll = scrollRef.current;
    const btn = btnRef.current;
    const update = () => {
      if (!scroll || !btn) return;
      const barW = scroll.offsetWidth - scroll.clientWidth;
      btn.style.right = `${22 + barW}px`;
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
    <div className={`msg-wrap${editingMessageId != null ? ' editing' : ''}`}>
      {editingMessageId != null && (
        <div
          className="edit-mask"
          onClick={() => setEditingMessageId(null)}
          aria-hidden="true"
        />
      )}
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
        {/* 自底向上渲染：取尾部 renderCount 条（最新消息在 DOM 末尾 = 视觉底部），
            分批补充更早消息时在顶部扩展、底部位置保持稳定 */}
        {pathMessages.slice(-renderCount).map((m) => {
          const { siblings, index } = branchSiblings(idx, m.id);
          const isLastAi = lastAi !== null && m.id === lastAi.id;
          return (
            <MessageBlock
              key={m.id}
              m={m}
              siblings={siblings}
              index={index}
              isLast={isLastAi}
              scrollEl={scrollRef.current}
              streaming={streaming}
              onSwitch={(t) => switchTo(m.id, t)}
              onCopy={() => handleCopy(m.content)}
              onRegenerate={() => handleRegenerate(m)}
              regenerating={regenerating || streaming}
              regenDisabled={siblings.length >= 6}
            />
          );
        })}
      </div>
      {!atBottom && !inputTall && (
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
      {toast &&
        createPortal(
          <div className={`toast-center${toastClosing ? ' toast-center--out' : ''}`}>{toast}</div>,
          document.body,
        )}
    </div>
  );
});

export default MessageView;