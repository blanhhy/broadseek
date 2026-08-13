import { useEffect, useRef, useState } from 'react';
import { useAuth, useConversation } from '../core/store';
import { fetchSessionsPage, fetchHistory, normalizeMessage } from '../core/api/client';
import type { ChatSession } from '../core/api/types';
import { buildIndex, activePathOf } from '../core/api/tree';
import ConversationList from '../components/ConversationList';
import BranchDrawer from '../components/BranchDrawer';
import MessageView, { type MessageViewHandle } from '../components/MessageView';
import FloatingDots from '../components/FloatingDots';
import InputBar from '../components/InputBar';

export default function ChatPage() {
  const token = useAuth((s) => s.token);
  const logout = useAuth((s) => s.logout);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [leftOpen, setLeftOpen] = useState(true); // 默认展开会话列表
  const [rightOpen, setRightOpen] = useState(false);
  const listRef = useRef<MessageViewHandle>(null);

  const conv = useConversation();

  // 加载会话列表
  useEffect(() => {
    fetchSessionsPage({ count: 100 })
      .then((d) => setSessions(d.chat_sessions))
      .catch((e) => console.error('加载会话失败', e));
  }, [token]);

  // 打开会话：拉取全部消息并解析
  const openSession = async (id: string) => {
    setRightOpen(false);
    setLeftOpen(false);
    conv.setConversation(id);
    conv.setLoading(true);
    conv.setError(null);
    try {
      const data = await fetchHistory(id);
      const messages = data.chat_messages.map(normalizeMessage);
      const idx = buildIndex(messages);
      const active = activePathOf(idx, data.chat_session.current_message_id);
      conv.setData({
        session: data.chat_session,
        messages,
        activePath: active,
        currentMessageId: data.chat_session.current_message_id,
      });
    } catch (e: any) {
      conv.setError(e.message || '加载失败');
    } finally {
      conv.setLoading(false);
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
          {conv.session?.title || (isOpen ? '未命名对话' : '对话')}
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
        />
      </div>

      {/* 右侧滑栏：分支列表 */}
      <div className={`drawer drawer-right ${rightOpen ? 'open' : ''}`}>
        <BranchDrawer
          messages={conv.messages}
          activePath={conv.activePath}
          currentMessageId={conv.currentMessageId}
          onClose={() => setRightOpen(false)}
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
            <div className="welcome-logo">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none">
                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z" fill="#4D6BFE" />
                <path d="M12 6a6 6 0 100 12 6 6 0 000-12zm0 9a3 3 0 110-6 3 3 0 010 6z" fill="#fff" />
              </svg>
            </div>
            <h2>选择或开始一段对话</h2>
            <p>从左侧列表选择已有对话</p>
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
          />
        )}

        {isOpen && (
          <>
            <FloatingDots
              messages={conv.messages}
              activePath={conv.activePath}
              currentMessageId={conv.currentMessageId}
              onJump={(id) => listRef.current?.scrollToMessage(id)}
            />
            <InputBar
              sessionId={conv.sessionId!}
            />
          </>
        )}
      </main>
    </div>
  );
}
