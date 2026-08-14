// 右侧悬浮原点：固定数量，以「视口内最后一条可见消息」为中心，上下对称取点。
// 路径消息不足固定数量则不展示；列表构建后保持稳定，仅当视口出现列表外的消息时才更新。

import { useMemo, useRef } from 'react';
import type { NormalizedMessage } from '../core/api/types';
import { buildIndex } from '../core/api/tree';

interface Props {
  messages: NormalizedMessage[];
  activePath: number[];
  visibleIds: number[];
  currentViewedId: number | null;
  currentMessageId: number | null;
  onJump: (id: number) => void;
}

const MAX_DOTS = 9;

export default function FloatingDots({ messages, activePath, visibleIds, currentViewedId, currentMessageId, onJump }: Props) {
  // 缓存已构建的列表，避免滚动时反复重建
  const cachedRef = useRef<{ ids: Set<number>; dots: NormalizedMessage[] } | null>(null);

  const dots = useMemo(() => {
    const idx = buildIndex(messages);
    // 当前查看的消息 = 被窗口中心穿过的消息（由 MessageView 计算并上报）
    const anchorId = currentViewedId ?? currentMessageId;
    if (anchorId === null || anchorId === undefined) return [];

    const total = activePath.length;
    // 固定数量：路径消息数不足则不展示
    if (total < MAX_DOTS) return [];

    // 列表稳定：仅当视口内出现列表外的消息时才重建
    const cache = cachedRef.current;
    if (cache && cache.ids.size && visibleIds.length && visibleIds.every((id) => cache.ids.has(id))) {
      return cache.dots;
    }

    const pos = activePath.indexOf(anchorId);
    if (pos === -1) return cache ? cache.dots : [];

    // 以 anchor 为中心，上下各取对称条数保证 anchor 尽量居中；某侧不足时向另一方向补足
    let up = Math.floor((MAX_DOTS - 1) / 2);
    let down = MAX_DOTS - 1 - up;
    if (pos < up) {
      down += up - pos;
      up = pos;
    }
    if (total - pos - 1 < down) {
      up = Math.min(up + (down - (total - pos - 1)), pos);
      down = total - pos - 1;
    }

    const ids = activePath.slice(pos - up, pos + down + 1);
    const dotList = ids
      .map((id) => idx.byId.get(id))
      .filter((m): m is NormalizedMessage => !!m);
    cachedRef.current = { ids: new Set(ids), dots: dotList };
    return dotList;
  }, [messages, activePath, visibleIds, currentViewedId, currentMessageId]);

  if (dots.length === 0) return null;

  // 高亮对象 = 当前查看的消息
  const anchorId = currentViewedId ?? currentMessageId;

  return (
    <div className="floating-dots">
      {dots.map((m) => {
        const isCurrent = m.id === anchorId;
        const preview = (m.content || '').replace(/\s+/g, ' ').slice(0, 40);
        return (
          <button
            key={m.id}
            className={`dot ${isCurrent ? 'dot-current' : ''}`}
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