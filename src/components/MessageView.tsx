// 主聊天区：按活跃路径顺序展示消息，支持加载/错误态与滚动定位
// 每个消息若存在同父兄弟（分支），下方显示"第 X/Y 条"切换器

import { Fragment, forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { NormalizedMessage } from '../core/api/types';
import { buildIndex, branchSiblings, switchBranchPath } from '../core/api/tree';
import { updateCurrentMessage } from '../core/api/client';
import { useConversation } from '../core/store';
import Markdown from './Markdown';

export interface MessageViewHandle {
  scrollToMessage: (id: number) => void;
}

interface Props {
  sessionId: string;
  messages: NormalizedMessage[];
  activePath: number[];
  loading: boolean;
  error: string | null;
  onOpenBranch: () => void;
}

function Bubble({ m }: { m: NormalizedMessage }) {
  const isUser = m.role === 'USER';
  return (
    <div className={`msg-row ${isUser ? 'user' : 'ai'}`} id={`msg-${m.id}`}>
      {!isUser && m.thinking && m.thinking.content && (
        <details className="msg-thinking">
          <summary>思考 · {m.thinking.elapsed_secs ? `${m.thinking.elapsed_secs}s` : ''}</summary>
          <div className="thinking-body">{m.thinking.content}</div>
        </details>
      )}
      <div className="msg-bubble">
        <div className="msg-content">
          {/* 用户消息是纯文本（保留换行）；AI 消息才需要 markdown */}
          {isUser ? m.content : <Markdown text={m.content} />}
        </div>
        {!isUser && m.files && m.files.length > 0 && (
          <div className="msg-tags">附件 {m.files.length}</div>
        )}
      </div>
    </div>
  );
}

// memo：消息对象引用不变则不重渲染，避免父组件重渲染时全量重解析 markdown
const BubbleMemo = memo(Bubble);

// 分支切换器：第 X/Y 条，左右切换同父的其他兄弟消息
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
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <span className="switcher-label">第 {index + 1}/{siblings.length} 条</span>
      <button
        className="switcher-btn"
        disabled={!next}
        onClick={() => next && onSwitch(next.id)}
        aria-label="下一条"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  );
}

const MessageView = forwardRef<MessageViewHandle, Props>(function MessageView(
  { sessionId, messages, activePath, loading, error, onOpenBranch },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const setActivePath = useConversation((s) => s.setActivePath);

  // 索引 + 活跃路径消息
  const { idx, pathMessages } = useMemo(() => {
    const index = buildIndex(messages);
    const list = activePath
      .map((id) => index.byId.get(id))
      .filter((it): it is NormalizedMessage => !!it);
    return { idx: index, pathMessages: list };
  }, [messages, activePath]);

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

  // 外部跳转定位（悬浮原点已废弃，保留接口供未来使用）
  useImperativeHandle(ref, () => ({
    scrollToMessage(id) {
      const el = document.getElementById(`msg-${id}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  }));

  // 滚动：仅当列表变长（新增消息/初次加载）时滚到底；
  // 分支切换是替换内容，应保持当前位置，不应触发滚底
  const prevLen = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pathMessages.length > prevLen.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevLen.current = pathMessages.length;
  }, [pathMessages.length]);

  return (
    <div className="msg-scroll" ref={scrollRef}>
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
      {pathMessages.map((m) => {
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
  );
});

export default MessageView;