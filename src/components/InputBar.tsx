// 底部输入栏：发送消息（乐观 UI：立即在对话页追加 User，流式生成 AI，失败撤回）
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sendCompletion, editMessageFallback, fetchHistory, normalizeMessage, enrichMessageFiles, ApiError } from '../core/api/client';
import { useConversation } from '../core/store';
import { buildIndex, activePathOf } from '../core/api/tree';
import { DeltaParser, FragmentTracker, nextTempId } from '../core/api/delta';
import type { NormalizedMessage } from '../core/api/types';

interface Props {
  sessionId: string;
}

export default function InputBar({ sessionId }: Props) {
  const conv = useConversation();
  const editingMessageId = useConversation((s) => s.editingMessageId);
  const setEditingMessageId = useConversation((s) => s.setEditingMessageId);
  const setInputTall = useConversation((s) => s.setInputTall);
  const setStreaming = useConversation((s) => s.setStreaming);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastClosing, setToastClosing] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const toastTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  // 显示居中 Toast（放大进入，约 1s 后缩小退出）
  const showToast = (msg: string) => {
    setToastClosing(false);
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToastClosing(true);
      closeTimer.current = window.setTimeout(() => {
        setToast(null);
        setToastClosing(false);
      }, 150);
    }, 1000);
  };

  // 编辑结束（点蒙版取消 / 发送完成）时清空输入框，避免残留被编辑内容
  const prevEditing = useRef<number | null>(editingMessageId);
  useEffect(() => {
    if (prevEditing.current != null && editingMessageId == null) {
      setText('');
    }
    prevEditing.current = editingMessageId;
  }, [editingMessageId]);

  // 随内容自动增高，达到 max-height 后内部滚动
  const autoResize = () => {
    const ta = taRef.current;
    if (!ta) return;
    const MAX_H = 128; // 与 textarea max-height 一致（外层 wrapper 的顶部内衬不计入）
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, MAX_H) + 'px';
    ta.style.overflowY = ta.scrollHeight > MAX_H ? 'auto' : 'hidden';
  };
  // 文本变化后重算高度（渲染后 DOM 已更新，覆盖取消编辑/发送后清空等程序化变更路径）。
  // 输入框变高（多行输入或编辑提示条撑高）时设置 inputTall，隐藏回到底部按钮。
  useEffect(() => {
    autoResize();
    const ta = taRef.current;
    const tall = editingMessageId != null || (!!ta && ta.scrollHeight > 30); // 单行约 22px，阈值取 30
    setInputTall(tall);
  }, [text, editingMessageId]);

  // 当前活跃路径最后一条消息作为父节点（在其下新建分支）
  const parentMessageId = conv.activePath.length
    ? conv.activePath[conv.activePath.length - 1]
    : null;

  // 视觉会话判定：以会话模型类型为准（chat_session.model_type === 'vision'）。
  // 不能用"会话含图片"判断——非视觉模型（default/OCR）也能发图片，但那不是视觉模型会话。
  // 服务端对 vision 模型的 completion/edit 校验客户端身份（缺 x-client-* 头会被拒），
  // 需带 sseHeaders（→ fragments 流格式）；default 会话保持 delta。见 client.ts StreamOpts。
  const isVision = conv.session?.model_type === 'vision';

  const refresh = async () => {
    const data = await fetchHistory(sessionId);
    const apply = (msgs: NormalizedMessage[]) => {
      const idx = buildIndex(msgs);
      const active = activePathOf(idx, data.chat_session.current_message_id);
      conv.setData({
        session: data.chat_session,
        messages: msgs,
        activePath: active,
        currentMessageId: data.chat_session.current_message_id,
      });
    };
    // 先渲染，再后台富化文件签名（signed_path）——否则历史里文件是裁剪版（缺 signed_path），
    // 发送/编辑后重新拉取的图片消息会丢掉预览（首次打开/重新生成走富化路径所以有预览）。
    apply(data.chat_messages.map(normalizeMessage));
    void enrichMessageFiles(data.chat_messages)
      .then((enriched) => apply(enriched.map(normalizeMessage)))
      .catch(() => {});
  };

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setText('');
    setSending(true);
    setStreaming(true);
    const now = Date.now() / 1000;
    const base: Omit<NormalizedMessage, 'id' | 'parent_id' | 'role' | 'content'> = {
      thinking: null,
      model: '',
      status: 'FINISHED',
      token_usage: null,
      thinking_enabled: false,
      search_enabled: false,
      ban_edit: false,
      ban_regenerate: false,
      files: [],
      feedback: null,
      search_results: null,
      tips: [],
      inserted_at: now,
    };

    // 编辑重发模式：用 edit_message 修改选中的用户消息
    if (editingMessageId != null) {
      const editId = editingMessageId;
      setEditingMessageId(null);
      const editMsg = conv.messages.find((m) => m.id === editId);
      const editIdx = conv.activePath.indexOf(editId);
      if (!editMsg || editIdx < 0) {
        setSending(false);
        setStreaming(false);
        return;
      }
      // 乐观 UI：模拟 edit_message 在服务器创建新用户消息分支的行为——
      // 原消息保持原样，追加虚拟用户消息（新文本）+ 虚拟 AI 消息承载流式，
      // 路径切换到新虚拟分支（原分支下方消息不再显示，切换器数量 +1）。
      const tempUserId = nextTempId();
      const tempAiId = nextTempId();
      useConversation.setState((s) => ({
        messages: [
          ...s.messages,
          { ...base, id: tempUserId, parent_id: editMsg.parent_id, role: 'USER', content: t },
          { ...base, id: tempAiId, parent_id: tempUserId, role: 'ASSISTANT', content: '' },
        ],
        activePath: [...s.activePath.slice(0, editIdx), tempUserId, tempAiId],
        currentMessageId: tempAiId,
      }));

      try {
        const parser = new DeltaParser();
        // 视觉会话走 fragments 流格式，普通会话走 delta：先喂给 FragmentTracker，
        // 命中（active）即按 fragments 重组，否则回退 delta（与 MessageView 一致）。
        const frag = new FragmentTracker();
        let seenThink = false;
        let thinkContent = '';
        let thinkElapsed: number | null = null;
        let bodyContent = '';
        const applyStream = () => {
          useConversation.setState((s) => ({
            messages: s.messages.map((m) =>
              m.id === tempAiId
                ? {
                    ...m,
                    content: bodyContent,
                    thinking: seenThink ? { content: thinkContent, elapsed_secs: thinkElapsed } : null,
                  }
                : m,
            ),
          }));
        };
        await editMessageFallback(
          {
            chat_session_id: sessionId,
            parent_message_id: editMsg.parent_id,
            prompt: t,
            thinking_enabled: editMsg.thinking_enabled,
            // model_type: editMsg.model
            // 不知道为什么，传了会出问题，待进一步测试
          },
          (ev) => {
            for (const op of parser.parse(ev)) {
              frag.apply(op.path, op.op, op.value);
              if (frag.active) {
                bodyContent = frag.content;
                if (frag.thinking) {
                  seenThink = true;
                  thinkContent = frag.thinking;
                }
                if (frag.elapsedSecs != null) {
                  seenThink = true;
                  thinkElapsed = frag.elapsedSecs;
                }
                continue;
              }
              const p = op.path;
              const v = op.value;
              if (p === 'response/thinking_content') {
                if (typeof v === 'string') {
                  seenThink = true;
                  thinkContent = op.op === 'SET' ? v : thinkContent + v;
                }
              } else if (p === 'response/thinking_elapsed_secs' && typeof v === 'number') {
                seenThink = true;
                thinkElapsed = v;
              } else if (p === 'response/content') {
                if (typeof v === 'string') {
                  bodyContent = op.op === 'SET' ? v : bodyContent + v;
                }
              }
            }
            applyStream();
          },
          undefined,
          { vision: isVision },
        );
        await refresh();
      } catch (e: any) {
        if (e instanceof ApiError && e.bizCode > 0) {
          showToast('修改输入次数超过限制');
        } else {
          showToast('发送失败');
        }
        await refresh(); // 恢复原始数据
      } finally {
        setSending(false);
        setStreaming(false);
      }
      return;
    }

    // 普通发送：乐观 UI 追加 User + AI，流式生成
    const tempUserId = nextTempId();
    const tempAiId = nextTempId();
    const userMsg: NormalizedMessage = { ...base, id: tempUserId, parent_id: parentMessageId, role: 'USER', content: t };
    const aiMsg: NormalizedMessage = { ...base, id: tempAiId, parent_id: tempUserId, role: 'ASSISTANT', content: '' };
    useConversation.setState((s) => ({
      messages: [...s.messages, userMsg, aiMsg],
      activePath: [...s.activePath, tempUserId, tempAiId],
      currentMessageId: tempAiId,
    }));

    try {
      const parser = new DeltaParser();
      // 视觉会话走 fragments 流格式，普通会话走 delta：双路解析（同编辑重发）。
      const frag = new FragmentTracker();
      // 流式状态：实际下发使用扁平路径
      //   response/thinking_content      → 思考内容（裸 {v} 事件依赖 p 跨事件持久化）
      //   response/thinking_elapsed_secs → 思考结束耗时（SET）
      //   response/content               → 正文内容
      let seenThink = false; // 是否出现过思考（决定是否渲染思考块）
      let thinkContent = '';
      let thinkElapsed: number | null = null;
      let bodyContent = '';
      const applyStream = () => {
        useConversation.setState((s) => ({
          messages: s.messages.map((m) =>
            m.id === tempAiId
              ? {
                  ...m,
                  content: bodyContent,
                  thinking: seenThink ? { content: thinkContent, elapsed_secs: thinkElapsed } : null,
                }
              : m,
          ),
        }));
      };
      await sendCompletion(
        {
          chat_session_id: sessionId,
          parent_message_id: parentMessageId,
          model_type: conv.session?.model_type || 'default',
          prompt: t,
        },
        (ev) => {
          for (const op of parser.parse(ev)) {
            frag.apply(op.path, op.op, op.value);
            if (frag.active) {
              bodyContent = frag.content;
              if (frag.thinking) {
                seenThink = true;
                thinkContent = frag.thinking;
              }
              if (frag.elapsedSecs != null) {
                seenThink = true;
                thinkElapsed = frag.elapsedSecs;
              }
              continue;
            }
            const p = op.path;
            const v = op.value;
            if (p === 'response/thinking_content') {
              if (typeof v === 'string') {
                seenThink = true;
                thinkContent = op.op === 'SET' ? v : thinkContent + v;
              }
            } else if (p === 'response/thinking_elapsed_secs' && typeof v === 'number') {
              seenThink = true;
              thinkElapsed = v;
            } else if (p === 'response/content') {
              if (typeof v === 'string') {
                bodyContent = op.op === 'SET' ? v : bodyContent + v;
              }
            }
          }
          applyStream();
        },
        undefined,
        { vision: isVision },
      );
      await refresh(); // 成功：用服务器真实数据替换临时消息
    } catch (e: any) {
      console.error('发送失败', e);
      // 失败：撤回临时 User + AI 消息，并 Toast 提示
      useConversation.setState((s) => ({
        messages: s.messages.filter((m) => m.id !== tempUserId && m.id !== tempAiId),
        activePath: s.activePath.filter((id) => id !== tempUserId && id !== tempAiId),
      }));
      showToast('发送失败');
    } finally {
      setSending(false);
      setStreaming(false);
    }
  };

  return (
    <div className="input-bar">
      <div className="input-card">
        {/* 编辑提示条：始终挂载，用 editing class 控制 grid-rows 展开/收起，
            进入与退出都能平滑推拉（条件渲染会直接 mount 无动画） */}
        <div className={`edit-banner-wrap${editingMessageId != null ? ' editing' : ''}`}>
          <div className="edit-banner-inner">
            <div className="edit-banner">
              <span>修改输入</span>
              <button
                className="edit-cancel"
                aria-label="取消编辑"
                onClick={() => { setEditingMessageId(null); setText(''); }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div className="input-textarea-container">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={editingMessageId != null ? '编辑消息…' : '发消息…'}
            rows={1}
          />
        </div>
        <div className="input-card-footer">
          <button className="send-btn" onClick={send} disabled={!text.trim() || sending}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20V4" />
              <path d="M5 11l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
      {toast &&
        createPortal(
          <div className={`toast-center${toastClosing ? ' toast-center--out' : ''}`}>{toast}</div>,
          document.body,
        )}
    </div>
  );
}