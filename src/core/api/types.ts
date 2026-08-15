// DeepSeek API 数据类型（对齐 history_messages / fetch_page 真实返回）

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
  files: unknown[];
  feedback: unknown;
  inserted_at: number;
  content: string; // 正文，纯字符串
  thinking_content: string | null; // 思考，独立字段
  thinking_elapsed_secs: number | null;
  search_status: string | null;
  search_results: unknown;
  tips: unknown[];
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
  files: unknown[];
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
