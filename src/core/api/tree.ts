// 对话树解析：扁平消息列表 → 树 / 叶子路径
// 核心范式：面向"叶子路径"而非"树"交互

import type { BranchNode, LeafEntry, NormalizedMessage } from './types';

export interface TreeIndex {
  byId: Map<number, NormalizedMessage>;
  childrenOf: Map<number | null, NormalizedMessage[]>;
  roots: NormalizedMessage[];
}

/** 从扁平消息列表建立索引 */
export function buildIndex(messages: NormalizedMessage[]): TreeIndex {
  const byId = new Map<number, NormalizedMessage>();
  const childrenOf = new Map<number | null, NormalizedMessage[]>();
  for (const m of messages) {
    byId.set(m.id, m);
    const key = m.parent_id;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(m);
  }
  // 各层按时间排序
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.inserted_at - b.inserted_at);
  }
  return { byId, childrenOf, roots: childrenOf.get(null) ?? [] };
}

/** 构建树（递归），返回根节点列表 */
export function buildTree(
  messages: NormalizedMessage[],
): BranchNode[] {
  const idx = buildIndex(messages);
  const depth = new Map<number, number>();

  const build = (m: NormalizedMessage): BranchNode => {
    const kids = idx.childrenOf.get(m.id) ?? [];
    const children = kids.map(build);
    return {
      message: m,
      children,
      depth: depth.get(m.id) ?? 0,
      isRoot: m.parent_id === null,
      isLeaf: kids.length === 0,
      siblingCount: (m.parent_id !== null ? idx.childrenOf.get(m.parent_id)?.length : idx.roots.length) ?? 1,
    };
  };

  // 计算深度（沿 parent 回溯）
  const calcDepth = (m: NormalizedMessage): number => {
    if (depth.has(m.id)) return depth.get(m.id)!;
    const d = m.parent_id !== null && idx.byId.has(m.parent_id)
      ? calcDepth(idx.byId.get(m.parent_id)!) + 1
      : 0;
    depth.set(m.id, d);
    return d;
  };
  for (const m of messages) calcDepth(m);

  return idx.roots.map(build);
}

/** 找某条消息的所有祖先 id（含自身），从根到该消息顺序 */
export function ancestorsOf(
  idx: TreeIndex,
  messageId: number,
): number[] {
  const path: number[] = [];
  let cur: NormalizedMessage | undefined = idx.byId.get(messageId);
  const visited = new Set<number>();
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    path.unshift(cur.id);
    cur = cur.parent_id !== null ? idx.byId.get(cur.parent_id) : undefined;
  }
  return path;
}

/**
 * 提取所有"叶子路径"（右侧分支列表的核心数据）。
 *
 * 规则：
 *  - 叶子 = AI 回答且无子节点（对话终点）
 *  - 每个叶子取它的父提问（USER），同一提问只保留一次（取最新叶子）
 *  - 按叶子时间升序（从早到晚）
 *  - replyCount = 该提问下的 AI 回复数
 */
export function extractLeafEntries(messages: NormalizedMessage[]): LeafEntry[] {
  const idx = buildIndex(messages);
  const byQuestion = new Map<number, LeafEntry>();

  for (const leaf of messages) {
    // 只认 AI 叶子
    if (leaf.role !== 'ASSISTANT') continue;
    if ((idx.childrenOf.get(leaf.id) ?? []).length > 0) continue;

    // 父提问：叶子是 AI，父应是 USER
    const q = leaf.parent_id !== null ? idx.byId.get(leaf.parent_id) : undefined;
    if (!q) continue;

    const path = ancestorsOf(idx, leaf.id);
    const existing = byQuestion.get(q.id);
    // 同一提问多个 AI 叶子：保留最新那个（叶子时间最晚），replyCount 累计
    if (!existing || leaf.inserted_at > existing.leaf.inserted_at) {
      byQuestion.set(q.id, {
        leaf,
        question: q,
        path,
        replyCount: (existing?.replyCount ?? 0) + (existing ? 0 : (idx.childrenOf.get(q.id) ?? []).length),
        insertedAt: leaf.inserted_at,
      });
    }
  }

  const entries = [...byQuestion.values()].sort((a, b) => a.insertedAt - b.insertedAt);
  // replyCount 统一改为该提问下的 AI 回复数
  for (const e of entries) {
    e.replyCount = (idx.childrenOf.get(e.question.id) ?? []).length;
  }
  return entries;
}

/** 活跃路径：从 currentMessageId 回溯到根（从根到当前） */
export function activePathOf(
  idx: TreeIndex,
  currentMessageId: number | null,
): number[] {
  if (currentMessageId === null) {
    // 无书签：默认取最新的叶子路径
    const entries = extractLeafEntries([...idx.byId.values()]);
    if (entries.length === 0) return [];
    return entries[entries.length - 1].path;
  }
  return ancestorsOf(idx, currentMessageId);
}

/**
 * 分支切换器数据：消息 m 的同父兄弟（含 m 自己）及 m 在其中的序号（0-based）。
 * 兄弟数 > 1 时，m 就是一个可在同父下切换的分支。
 * siblings 已按时间升序。无父或单分支时返回空。
 */
export function branchSiblings(
  idx: TreeIndex,
  messageId: number,
): { siblings: NormalizedMessage[]; index: number } {
  const m = idx.byId.get(messageId);
  if (!m || m.parent_id === null) return { siblings: [], index: -1 };
  const siblings = idx.childrenOf.get(m.parent_id) ?? [];
  const index = siblings.findIndex((s) => s.id === messageId);
  return { siblings, index };
}

/** 从 start 沿"最新子"一路下探到叶子，返回 id 路径（含 start） */
function defaultLeafPath(idx: TreeIndex, start: NormalizedMessage): number[] {
  const path = [start.id];
  let cur = start;
  for (;;) {
    const kids = idx.childrenOf.get(cur.id) ?? [];
    if (kids.length === 0) break;
    cur = kids[kids.length - 1];
    path.push(cur.id);
  }
  return path;
}

/**
 * 在活跃路径上，把"消息 switchId"替换为其兄弟 targetId，
 * 并让 targetId 沿最新子下探到叶子，返回新路径。
 * 用于分支切换器：切换到同父的另一分支后，展示该分支的默认叶子。
 */
export function switchBranchPath(
  idx: TreeIndex,
  activePath: number[],
  switchId: number,
  targetId: number,
): number[] {
  const pos = activePath.indexOf(switchId);
  if (pos < 0) return activePath;
  const target = idx.byId.get(targetId);
  if (!target) return activePath;
  const prefix = activePath.slice(0, pos); // switchId 之前（含其父路径）
  return [...prefix, ...defaultLeafPath(idx, target)];
}
