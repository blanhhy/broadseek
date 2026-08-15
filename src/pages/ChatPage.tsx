import { useEffect, useRef, useState } from 'react';
import { useAuth, useConversation } from '../core/store';
import { fetchAllSessions, fetchHistory, normalizeMessage } from '../core/api/client';
import { loadSessionListCache, saveSessionListCache } from '../core/api/sessionCache';
import type { ChatSession } from '../core/api/types';
import { buildIndex, activePathOf } from '../core/api/tree';
import ConversationList from '../components/ConversationList';
import BranchDrawer from '../components/BranchDrawer';
import MessageView, { type MessageViewHandle } from '../components/MessageView';
import FloatingDots from '../components/FloatingDots';
import InputBar from '../components/InputBar';

// 会话内缓存：避免重复拉取 & 切换回已开过的会话时秒开
interface SessionCache {
  session: ChatSession | null;
  messages: ReturnType<typeof normalizeMessage>[];
  activePath: number[];
  currentMessageId: number | null;
}
const sessionCache = new Map<string, SessionCache>();

export default function ChatPage() {
  const token = useAuth((s) => s.token);
  const logout = useAuth((s) => s.logout);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [leftOpen, setLeftOpen] = useState(true); // 默认展开会话列表
  const [rightOpen, setRightOpen] = useState(false);
  const [visibleIds, setVisibleIds] = useState<number[]>([]);
  const [viewedId, setViewedId] = useState<number | null>(null);
  const listRef = useRef<MessageViewHandle>(null);
  const reqSeq = useRef(0); // 竞态保护：只接受最后一次请求的结果

  const conv = useConversation();

  // 回到未选择状态：清空当前会话数据（会话被删除时使用）
  const resetConversation = () => {
    conv.setData({ session: null, messages: [], activePath: [], currentMessageId: null });
    conv.setConversation(null);
  };

  // 加载会话列表
  //  - preferCache=true（启动）：先渲染本地缓存秒开，再后台拉取同步；失败静默保留缓存
  //  - preferCache=false（下拉刷新/删除/重命名后）：直接拉取最新，立即生效
  // 拉取成功后检测：当前打开的会话已不在列表（其他端删除）→ 回到未选择状态
  const loadSessions = async (preferCache = false) => {
    if (preferCache) {
      const cached = loadSessionListCache(token);
      if (cached && cached.sessions.length > 0) setSessions(cached.sessions);
    }
    try {
      const d = await fetchAllSessions({ count: 100 });
      saveSessionListCache(token, d);
      setSessions(d);
      if (conv.sessionId && !d.some((s) => s.id === conv.sessionId)) {
        resetConversation();
      }
    } catch (e) {
      if (!preferCache) console.error('加载会话失败', e);
      // preferCache 失败：保留缓存渲染（本地优先，异步同步失败静默）
    }
  };
  useEffect(() => {
    loadSessions(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // 打开会话：优先命中缓存，否则拉取全部消息并解析
  const openSession = async (id: string) => {
    const seq = ++reqSeq.current;
    setRightOpen(false);
    conv.setConversation(id);

    // 离开当前会话前，把最新消息树快照写回内存缓存
    // （流式/编辑/分支切换直接原地改 conv.messages，只有这里能捕获最终态）
    const prevId = conv.sessionId;
    if (prevId && prevId !== id && conv.session && conv.messages.length > 0) {
      sessionCache.set(prevId, {
        session: conv.session,
        messages: conv.messages,
        activePath: conv.activePath,
        currentMessageId: conv.currentMessageId,
      });
    }

    // 命中缓存：直接秒开，不再请求
    const cached = sessionCache.get(id);
    if (cached) {
      setLeftOpen(false);
      conv.setLoading(false);
      conv.setError(null);
      conv.setData(cached);
      return;
    }

    // 未命中：先清空旧内容进入加载态，避免停留在上一会话的画面
    conv.setLoading(true);
    conv.setError(null);
    conv.setData({ session: null, messages: [], activePath: [], currentMessageId: null });
    try {
      const data = await fetchHistory(id);
      if (seq !== reqSeq.current) return; // 已被更新的切换取代
      const messages = data.chat_messages.map(normalizeMessage);
      const idx = buildIndex(messages);
      const active = activePathOf(idx, data.chat_session.current_message_id);
      const payload: SessionCache = {
        session: data.chat_session,
        messages,
        activePath: active,
        currentMessageId: data.chat_session.current_message_id,
      };
      sessionCache.set(id, payload);
      if (seq !== reqSeq.current) return;
      conv.setData(payload);
    } catch (e: any) {
      if (seq !== reqSeq.current) return;
      conv.setError(e.message || '加载失败');
    } finally {
      if (seq === reqSeq.current) {
        conv.setLoading(false);
        setLeftOpen(false);
      }
    }
  };

  const isOpen = !!conv.sessionId;

  return (
    <div className={`app-shell ${leftOpen ? 'left-open' : ''} ${rightOpen ? 'right-open' : ''}`}>
      {/* 顶部栏 */}
      <header className="topbar">
        <button className="icon-btn" onClick={() => setLeftOpen((v) => !v)} aria-label="会话列表">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <div className="topbar-title">
          {conv.session?.title || (isOpen ? '未命名对话' : '')}
        </div>
        <div className="topbar-actions">
          {isOpen && (
            <button className="icon-btn" onClick={() => setRightOpen((v) => !v)} aria-label="分支列表">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="6" cy="5" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="19" r="2" />
                <path d="M6 7v10M18 12H8" />
              </svg>
            </button>
          )}
          <button className="icon-btn" onClick={logout} aria-label="退出">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>
        </div>
      </header>

      {/* 左侧滑栏：会话列表 */}
      <div className={`drawer drawer-left ${leftOpen ? 'open' : ''}`}>
        <ConversationList
          sessions={sessions}
          currentId={conv.sessionId}
          onOpen={openSession}
          onSessionsChange={() => loadSessions(false)}
          onRefresh={() => loadSessions(false)}
        />
      </div>

      {/* 右侧滑栏：分支列表 */}
      <div className={`drawer drawer-right ${rightOpen ? 'open' : ''}`}>
        <BranchDrawer
          messages={conv.messages}
          activePath={conv.activePath}
          currentMessageId={conv.currentMessageId}
          onClose={() => setRightOpen(false)}
          onJumped={() => listRef.current?.scrollToBottomAfterPath()}
        />
      </div>

      {/* 遮罩 */}
      {(leftOpen || rightOpen) && (
        <div className="scrim" onClick={() => { setLeftOpen(false); setRightOpen(false); }} />
      )}

      {/* 主区 */}
      <main className="chat-main">
        {!isOpen ? (
          <div className="welcome">
            <h2>还未选择对话</h2>
            <p>打开左侧栏选择已有对话</p>
          </div>
        ) : (
          <MessageView
            ref={listRef}
            sessionId={conv.sessionId!}
            messages={conv.messages}
            activePath={conv.activePath}
            loading={conv.loading}
            error={conv.error}
            onOpenBranch={() => setRightOpen(true)}
            onVisibleChange={setVisibleIds}
            onViewedChange={setViewedId}
          />
        )}

        {isOpen && !conv.editingMessageId && (
          <FloatingDots
            messages={conv.messages}
            activePath={conv.activePath}
            visibleIds={visibleIds}
            currentViewedId={viewedId}
            currentMessageId={conv.currentMessageId}
            onJump={(id) => listRef.current?.scrollToMessage(id)}
          />
        )}

        {isOpen && (
          <InputBar
            sessionId={conv.sessionId!}
          />
        )}
      </main>
    </div>
  );
}
