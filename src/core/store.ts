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
}

export const useConversation = create<ConversationState>((set) => ({
  sessionId: null,
  session: null,
  messages: [],
  activePath: [],
  currentMessageId: null,
  loading: false,
  error: null,
  setConversation: (sessionId) => set({ sessionId }),
  setData: (d) => set({ ...d }),
  setActivePath: (activePath, currentMessageId) =>
    set({ activePath, currentMessageId }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
