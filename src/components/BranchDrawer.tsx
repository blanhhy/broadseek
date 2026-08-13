// 右侧分支列表：叶子问答对卡片
// 提问文本：最大行数 + 展开/收起；AI 回复：固定 2 行摘取；元信息（时间/回复数）在卡片外

import { useEffect, useMemo, useRef, useState } from 'react';
import type { NormalizedMessage } from '../core/api/types';
import { extractLeafEntries } from '../core/api/tree';
import { useConversation } from '../core/store';
import { updateCurrentMessage } from '../core/api/client';

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

/** 多行文本截断 + 展开/收起（不足最大行数时隐藏切换按钮） */
function ClampText({ text, rows }: { text: string; rows: number }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 只在收起（clamp）状态下测量一次是否溢出；展开时跳过，避免反复 reflow
  useEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text, rows, expanded]);

  const showToggle = expanded || overflowing;

  return (
    <div className="branch-q">
      <div
        ref={ref}
        className={`branch-q-text ${expanded ? '' : 'clamp'}`}
        style={expanded ? undefined : ({ WebkitLineClamp: rows } as React.CSSProperties)}
      >
        {text || '（空提问）'}
      </div>
      {showToggle && (
        <button
          className="branch-toggle"
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
        >
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  );
}

export default function BranchDrawer({ messages, activePath, onClose }: Props) {
  const [keyword, setKeyword] = useState('');
  const sessionId = useConversation((s) => s.sessionId);
  const setActivePath = useConversation((s) => s.setActivePath);

  const entries = useMemo(() => extractLeafEntries(messages), [messages]);

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

  const jumpTo = (path: number[], leafId: number) => {
    setActivePath(path, leafId);
    if (sessionId) {
      updateCurrentMessage(sessionId, leafId).catch((e) =>
        console.error('设置服务器当前位置失败', e),
      );
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
      <div className="branch-scroll" onScroll={onScroll}>
        {filtered.length === 0 && <div className="conv-empty">无分支</div>}
        {visible.map((e) => {
          const isCurrent = activeSet.has(e.leaf.id);
          return (
            <div key={e.leaf.id} className="branch-item">
              <div
                className={`branch-card ${isCurrent ? 'current' : ''}`}
                onClick={() => jumpTo(e.path, e.leaf.id)}
              >
                {/* 提问文本（最大行数，可展开/收起） */}
                <ClampText text={e.question.content} rows={3} />
                {/* 叶子 AI 预览（固定 2 行摘取） */}
                <div className="branch-leaf-preview">
                  {e.leaf.content || '（AI 回复）'}
                </div>
              </div>
              {/* 元信息：卡片下方（卡片外） */}
              <div className="branch-meta">
                <span>{fmtTime(e.insertedAt)}</span>
                <span>{e.replyCount} 条回复</span>
                {isCurrent && <span className="branch-current-tag">当前</span>}
              </div>
            </div>
          );
        })}
        {count < filtered.length && (
          <div className="branch-more" onClick={loadMore}>加载更多</div>
        )}
      </div>
    </div>
  );
}