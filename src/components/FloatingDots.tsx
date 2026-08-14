// 右侧悬浮原点：随滚动位置变化，取当前可见消息及其上方若干条（固定最多 MAX_DOTS 条）
// 以视口最上方可见消息为锚点，沿祖先回溯到根，当前消息高亮，点击跳转

import { useMemo } from 'react';
import type { NormalizedMessage } from '../core/api/types';
import { buildIndex, ancestorsOf } from '../core/api/tree';

interface Props {
  messages: NormalizedMessage[];
  visibleIds: number[];
  currentMessageId: number | null;
  onJump: (id: number) => void;
}

const MAX_DOTS = 9;

export default function FloatingDots({ messages, visibleIds, currentMessageId, onJump }: Props) {
  const dots = useMemo(() => {
    const idx = buildIndex(messages);
    // 取视口内最上方那条作为"当前可见消息"；无可见时回退到当前消息
    const anchorId = visibleIds[0] ?? currentMessageId;
    if (anchorId === null || anchorId === undefined) return [];
    // 沿祖先回溯到根（根→当前），固定取最多 MAX_DOTS 条，包含当前可见消息及其上方几条
    const path = ancestorsOf(idx, anchorId);
    return path
      .slice(-MAX_DOTS)
      .map((id) => idx.byId.get(id))
      .filter((m): m is NormalizedMessage => !!m);
  }, [messages, visibleIds, currentMessageId]);

  if (dots.length === 0) return null;

  return (
    <div className="floating-dots">
      {dots.map((m) => {
        const isUser = m.role === 'USER';
        const isCurrent = m.id === currentMessageId;
        const preview = (m.content || '').replace(/\s+/g, ' ').slice(0, 40);
        return (
          <button
            key={m.id}
            className={`dot ${isUser ? 'dot-user' : 'dot-ai'} ${isCurrent ? 'dot-current' : ''}`}
            onClick={() => onJump(m.id)}
            title={preview}
          >
            <span className="dot-preview">{preview}</span>
          </button>
        );
      })}
    </div>
  );
}