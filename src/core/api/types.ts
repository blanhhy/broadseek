// DeepSeek API 数据类型（对齐 history_messages / fetch_page 真实返回）

// ── 消息文件（history_messages 真实返回：文件描述符）──
// 图片文件额外带 is_image/width/height；signed_path 需经 buildFileUrl 拼成可访问 URL
export interface ChatFile {
  id: string | number;
  signed_path: string | null;
  file_name: string | null;
  status?: string; // PARSING | SUCCESS | FAILED | ...
  file_size?: number | null;
  audit_result?: 'pass' | 'reject' | 'unknown' | null;
  from_share?: boolean;
  token_usage?: number | null;
  is_image?: boolean;
  width?: number;
  height?: number;
  content_type?: string;
  model_kind?: string;
  // 兜底字段（部分来源可能直接给 URL 或用驼峰命名）
  url?: string | null;
  file_url?: string | null;
}

// ── 会话 ──
export interface ChatSession {
  id: string;
  seq_id: number;
  title: string | null;
  model_type: string;
  pinned: boolean;
  current_message_id: number | null;
  inserted_at: number;
  updated_at: number;
  version: number; // 会话内容版本号：history_messages 缓存协议(cache_version)的依据
}

// ── 官方 Android 消息片段（带 x-client-version 头时 history_messages 返回）──
// 旧客户端曾全局携带版本头，把这种格式写进了本地缓存：
// 消息没有 content/thinking_content，内容分散在 fragments 里。
export type ChatFragmentType = 'REQUEST' | 'RESPONSE' | 'THINK' | 'TIP';

export interface ChatFragment {
  id: number;
  type: ChatFragmentType;
  content?: string;
  elapsed_secs?: number;
  references?: unknown;
  stage_id?: string;
  style?: unknown;
  hide_on_wip?: boolean;
}

// ── 单条消息（history_messages 返回）──
export interface ChatMessage {
  message_id: number;
  parent_id: number | null;
  model: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  thinking_enabled: boolean;
  search_enabled: boolean;
  ban_edit: boolean;
  ban_regenerate: boolean;
  status: string; // WIP | FINISHED | INCOMPLETE
  incomplete_message: unknown;
  accumulated_token_usage: number | null;
  files: ChatFile[];
  feedback: unknown;
  inserted_at: number;
  content: string; // 正文，纯字符串
  thinking_content: string | null; // 思考，独立字段
  thinking_elapsed_secs: number | null;
  search_status: string | null;
  search_results: unknown;
  tips: unknown[];
  fragments?: ChatFragment[]; // Android 格式：内容分散在片段里（见上）
}

// ── 完整导出格式（扁平存储，parent_id 还原树）──
export interface NormalizedMessage {
  id: number;
  parent_id: number | null;
  role: ChatMessage['role'];
  content: string;
  thinking: { content: string; elapsed_secs: number | null } | null;
  model: string;
  status: string;
  token_usage: number | null;
  thinking_enabled: boolean;
  search_enabled: boolean;
  ban_edit: boolean;
  ban_regenerate: boolean;
  files: ChatFile[];
  feedback: unknown;
  search_results: unknown;
  tips: unknown[];
  inserted_at: number;
}

export interface ConversationExport {
  session: {
    id: string;
    title: string | null;
    model_type: string;
    pinned: boolean;
    current_message_id: number | null;
    inserted_at: number;
    updated_at: number;
  };
  messages: NormalizedMessage[];
}

// ── 树节点（解析后用于展示/交互）──
export interface BranchNode {
  message: NormalizedMessage;
  children: BranchNode[];
  depth: number;
  isRoot: boolean;
  isLeaf: boolean;
  siblingCount: number; // 父节点子节点总数
}

// ── 叶子路径（右侧分支列表的核心数据）──
export interface LeafEntry {
  leaf: NormalizedMessage; // AI 叶子
  question: NormalizedMessage; // 父提问（USER）
  path: number[]; // 从根到叶子的 message_id 路径
  replyCount: number; // 该提问下 AI 回复数
  insertedAt: number;
}
