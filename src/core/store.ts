// 全局状态（zustand）

import { create } from 'zustand';
import type { ChatSession, NormalizedMessage } from './api/types';
import { setToken as apiSetToken } from './api/client';

const TOKEN_KEY = 'ds_user_token';

// ── 认证 ──
interface AuthState {
  token: string | null;
  ready: boolean;
  init: () => void;
  login: (token: string) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  token: null,
  ready: false,
  init: () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) apiSetToken(token);
    set({ token, ready: true });
  },
  login: (token) => {
    localStorage.setItem(TOKEN_KEY, token);
    apiSetToken(token);
    set({ token, ready: true });
  },
  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    apiSetToken(null);
    set({ token: null, ready: true });
  },
}));

// ── 会话树缓存（当前打开的会话）──
interface ConversationState {
  sessionId: string | null;
  session: ChatSession | null;
  messages: NormalizedMessage[];
  activePath: number[];
  currentMessageId: number | null;
  loading: boolean;
  error: string | null;
  editingMessageId: number | null; // 编辑重发模式：长按用户消息后设置
  inputTall: boolean; // 输入框变高（多行/编辑提示条）：隐藏回到底部按钮
  streaming: boolean; // 流式响应进行中（含虚拟分支时禁用切换器）
  setConversation: (sessionId: string | null) => void;
  setData: (d: {
    session: ChatSession | null;
    messages: NormalizedMessage[];
    activePath: number[];
    currentMessageId: number | null;
  }) => void;
  setActivePath: (path: number[], currentMessageId: number | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  setEditingMessageId: (id: number | null) => void;
  setInputTall: (b: boolean) => void;
  setStreaming: (b: boolean) => void;
}

export const useConversation = create<ConversationState>((set) => ({
  sessionId: null,
  session: null,
  messages: [],
  activePath: [],
  currentMessageId: null,
  loading: false,
  error: null,
  editingMessageId: null,
  setConversation: (sessionId) => set({ sessionId, editingMessageId: null }),
  setData: (d) => set({ ...d }),
  setActivePath: (activePath, currentMessageId) =>
    // 切换分支路径后目标路径上未必有被编辑消息，编辑操作随之取消
    set({ activePath, currentMessageId, editingMessageId: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setEditingMessageId: (editingMessageId) => set({ editingMessageId }),
  inputTall: false,
  setInputTall: (inputTall) => set({ inputTall }),
  streaming: false,
  setStreaming: (streaming) => set({ streaming }),
}));
