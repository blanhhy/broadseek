// 右侧悬浮原点：活跃路径上最近几条消息的快速跳转点

import { useMemo } from 'react';
import type { NormalizedMessage } from '../core/api/types';
import { buildIndex } from '../core/api/tree';

interface Props {
  messages: NormalizedMessage[];
  activePath: number[];
  currentMessageId: number | null;
  onJump: (id: number) => void;
}

const RECENT = 6; // 只展示最近几条

export default function FloatingDots({ messages, activePath, currentMessageId, onJump }: Props) {
  const dots = useMemo(() => {
    const idx = buildIndex(messages);
    const recent = activePath.slice(-RECENT);
    return recent.map((id) => idx.byId.get(id)).filter((m): m is NormalizedMessage => !!m);
  }, [messages, activePath]);

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