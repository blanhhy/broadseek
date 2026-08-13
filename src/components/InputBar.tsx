// 底部输入栏：发送消息（SSE 流式），完成后刷新整棵树

import { useState } from 'react';
import { sendCompletion, fetchHistory, normalizeMessage } from '../core/api/client';
import { useConversation } from '../core/store';
import { buildIndex, activePathOf } from '../core/api/tree';

interface Props {
  sessionId: string;
}

export default function InputBar({ sessionId }: Props) {
  const conv = useConversation();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState('');

  // 当前活跃路径最后一条消息作为父节点（在其下新建分支）
  const parentMessageId = conv.activePath.length
    ? conv.activePath[conv.activePath.length - 1]
    : null;

  const refresh = async () => {
    const data = await fetchHistory(sessionId);
    const msgs = data.chat_messages.map(normalizeMessage);
    const idx = buildIndex(msgs);
    const active = activePathOf(idx, data.chat_session.current_message_id);
    conv.setData({
      session: data.chat_session,
      messages: msgs,
      activePath: active,
      currentMessageId: data.chat_session.current_message_id,
    });
  };

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setText('');
    setSending(true);
    setStreaming('');
    try {
      await sendCompletion(
        {
          chat_session_id: sessionId,
          parent_message_id: parentMessageId,
          prompt: t,
        },
        (ev) => {
          const c = ev?.choices?.[0]?.delta?.content;
          if (typeof c === 'string' && c) setStreaming((s) => s + c);
        },
      );
      await refresh();
    } catch (e: any) {
      console.error('发送失败', e);
    } finally {
      setSending(false);
      setStreaming('');
    }
  };

  return (
    <div className="input-bar">
      {streaming && <div className="stream-preview">{streaming}</div>}
      <div className="input-row">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="发消息…"
          rows={1}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="send-btn" onClick={send} disabled={!text.trim() || sending}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20V4" />
            <path d="M5 11l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}