// 右侧分支列表：叶子问答对卡片
// 提问文本：最大行数 + 展开/收起；AI 回复：固定 2 行摘取；元信息（时间/回复数）在卡片外

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LeafEntry, NormalizedMessage } from '../core/api/types';
import { useConversation } from '../core/store';
import { buildIndex, extractLeafEntries } from '../core/api/tree';

interface Props {
  messages: NormalizedMessage[];
  activePath: number[];
  currentMessageId: number | null;
  onClose: () => void;
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 多行文本截断（不足最大行数时隐藏切换开关） */
function ClampText({
  text,
  rows,
  expanded,
  onOverflowChange,
}: {
  text: string;
  rows: number;
  expanded: boolean;
  onOverflowChange: (v: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // 只在收起（clamp）状态下测量一次是否溢出；展开时跳过，避免反复 reflow
  useEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (el) onOverflowChange(el.scrollHeight > el.clientHeight + 1);
  }, [text, rows, expanded, onOverflowChange]);

  return (
    <div
      ref={ref}
      className={`branch-q-text ${expanded ? '' : 'clamp'}`}
      style={expanded ? undefined : ({ WebkitLineClamp: rows } as React.CSSProperties)}
    >
      {text || '（空提问）'}
    </div>
  );
}

/** 单个分支卡片：提问(clamp) + AI 预览(2行) + 右侧展开/收起箭头 */
function BranchItem({
  entry,
  replies,
  isCurrent,
  onJump,
}: {
  entry: LeafEntry;
  replies: NormalizedMessage[];
  isCurrent: boolean;
  onJump: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const showToggle = expanded || overflowing;

  // 微缩分支切换器：当前预览的 AI 回复序号
  const [previewIdx, setPreviewIdx] = useState(() => {
    const i = replies.findIndex((r) => r.id === entry.leaf.id);
    return i >= 0 ? i : 0;
  });
  const preview = replies[previewIdx] ?? entry.leaf;

  return (
    <div className="branch-item" data-leaf-id={entry.leaf.id}>
      <div className={`branch-card ${isCurrent ? 'current' : ''}`} onClick={onJump}>
        <ClampText
          text={entry.question.content}
          rows={3}
          expanded={expanded}
          onOverflowChange={setOverflowing}
        />
        {/* 叶子 AI 预览：固定 2 行，右侧放展开/收起箭头 */}
        <div className="branch-leaf-row">
          <div className="branch-leaf-preview">
            {preview.content || '（AI 回复）'}
          </div>
          {showToggle && (
            <button
              className="branch-arrow"
              aria-label={expanded ? '收起' : '展开'}
              onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            >
              {expanded ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 15l6-6 6 6" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              )}
            </button>
          )}
        </div>
      </div>
      {/* 元信息：卡片下方（卡片外） */}
      <div className="branch-meta">
        <span className="branch-time">{fmtTime(entry.insertedAt)}</span>
        {/* 微缩分支切换器：仅在多个 AI 回复之间切换预览 */}
        {replies.length > 1 && (
          <div className="branch-mini-switch">
            <button
              className="mini-switch-btn"
              disabled={previewIdx === 0}
              onClick={(e) => { e.stopPropagation(); setPreviewIdx((i) => i - 1); }}
              aria-label="上一条回复"
            >
              <svg width="9" height="9" viewBox="0 0 10 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 1.5L2.5 6 7 10.5" />
              </svg>
            </button>
            <span className="mini-switch-label">{previewIdx + 1}／{replies.length}</span>
            <button
              className="mini-switch-btn"
              disabled={previewIdx === replies.length - 1}
              onClick={(e) => { e.stopPropagation(); setPreviewIdx((i) => i + 1); }}
              aria-label="下一条回复"
            >
              <svg width="9" height="9" viewBox="0 0 10 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 1.5L7.5 6 3 10.5" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function BranchDrawer({ messages, activePath, onClose }: Props) {
  const [keyword, setKeyword] = useState('');
  const setActivePath = useConversation((s) => s.setActivePath);

  const entries = useMemo(() => extractLeafEntries(messages), [messages]);

  // 每个提问下的 AI 回复列表（用于微缩分支切换器切换预览）
  const repliesByQuestion = useMemo(() => {
    const idx = buildIndex(messages);
    const map = new Map<number, NormalizedMessage[]>();
    for (const e of entries) {
      const replies = (idx.childrenOf.get(e.question.id) ?? []).filter(
        (m) => m.role === 'ASSISTANT',
      );
      map.set(e.question.id, replies);
    }
    return map;
  }, [entries, messages]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    let list = entries;
    if (kw) list = list.filter(
      (e) =>
        e.question.content.toLowerCase().includes(kw) ||
        e.leaf.content.toLowerCase().includes(kw),
    );
    // 从新到旧（插入时间倒序），渐进渲染从最新开始
    return [...list].sort((a, b) => b.insertedAt - a.insertedAt);
  }, [entries, keyword]);

  // 渐进渲染：只渲染可见的前若干条，滚动到底再加载，降低打开侧栏/展开收起的渲染负担
  const PAGE = 30;
  const [count, setCount] = useState(PAGE);
  useEffect(() => { setCount(PAGE); }, [keyword]);
  const visible = filtered.slice(0, count);
  const loadMore = () => setCount((c) => c + PAGE);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadMore();
  };

  const activeSet = useMemo(() => new Set(activePath), [activePath]);

  const scrollRef = useRef<HTMLDivElement>(null);

  const jumpTo = (path: number[], leafId: number) => {
    setActivePath(path, leafId);
    // 跳转后把该条目滚动到能露出下方小字(meta)的位置
    const container = scrollRef.current;
    if (container) {
      const el = container.querySelector(`[data-leaf-id="${leafId}"]`) as HTMLElement | null;
      if (el) {
        const cRect = container.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        if (eRect.top < cRect.top) {
          // 在视口上方：向上滚动到用户消息末行进入视口
          container.scrollTop = el.offsetTop - 4;
        } else if (eRect.bottom > cRect.bottom) {
          // 在视口下方：向下滚动到小字下边缘与视口下边缘对齐
          container.scrollTop = el.offsetTop + el.offsetHeight - container.clientHeight + 4;
        }
      }
    }
    onClose();
  };

  return (
    <div className="branch-drawer">
      <div className="branch-header">
        <span className="branch-title">分支列表</span>
        <span className="branch-count">{entries.length} 条</span>
      </div>
      <div className="drawer-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" />
        </svg>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索分支提问"
        />
      </div>
      <div className="branch-scroll" ref={scrollRef} onScroll={onScroll}>
        {filtered.length === 0 && <div className="conv-empty">无分支</div>}
        {visible.map((e) => {
          const isCurrent = activeSet.has(e.leaf.id);
          return (
            <BranchItem
              key={e.leaf.id}
              entry={e}
              replies={repliesByQuestion.get(e.question.id) ?? []}
              isCurrent={isCurrent}
              onJump={() => jumpTo(e.path, e.leaf.id)}
            />
          );
        })}
        {count < filtered.length && (
          <div className="branch-more" onClick={loadMore}>加载更多</div>
        )}
      </div>
    </div>
  );
}