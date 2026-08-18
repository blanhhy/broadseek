import { useEffect, useCallback, useRef, useState } from 'react';
import { useAuth, useConversation } from '../core/store';
import {
  enrichMessageFiles,
  fetchAllSessions,
  fetchHistory,
  normalizeMessage,
  resumeMessage,
  isNativeRuntime,
} from '../core/api/client';
import { DsBridge } from '../core/api/nativeBridge';
import { loadSessionListCache, saveSessionListCache } from '../core/api/sessionCache';
import type { ChatSession, NormalizedMessage } from '../core/api/types';
import { buildIndex, activePathOf } from '../core/api/tree';
import { DeltaParser, FragmentTracker } from '../core/api/delta';
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
  // 手势闭包读取最新抽屉状态
  const leftOpenRef = useRef(leftOpen);
  const rightOpenRef = useRef(rightOpen);
  useEffect(() => { leftOpenRef.current = leftOpen; }, [leftOpen]);
  useEffect(() => { rightOpenRef.current = rightOpen; }, [rightOpen]);
  const [visibleIds, setVisibleIds] = useState<number[]>([]);
  const [viewedId, setViewedId] = useState<number | null>(null);
  const listRef = useRef<MessageViewHandle>(null);
  const reqSeq = useRef(0); // 竞态保护：只接受最后一次请求的结果

  const conv = useConversation();

  // 抽屉开关：一次只能打开一个（打开任一栏时显式关闭另一栏）
  const toggleLeft = () => {
    if (!leftOpenRef.current) setRightOpen(false); // 将打开左栏 → 关闭右栏
    setLeftOpen((v) => !v);
  };
  const toggleRight = () => {
    if (!rightOpenRef.current) setLeftOpen(false); // 将打开右栏 → 关闭左栏
    setRightOpen((v) => !v);
  };

  // 抽屉状态（open class）由 React 提交后，延迟到吸附动画结束（0.28s）再清理 --drawer-x：
  // 此刻 var 值（目标位置）与 class fallback（open→0 / 关闭→±100%）完全相等，
  // 直接 removeProperty 不会产生任何视觉跳变，也绝不打断过渡动画。
  useEffect(() => {
    const t = window.setTimeout(() => {
      for (const el of document.querySelectorAll<HTMLElement>('.drawer-left, .drawer-right')) {
        if (el.style.getPropertyValue('--drawer-x')) {
          el.style.removeProperty('--drawer-x');
        }
      }
    }, 320);
    return () => window.clearTimeout(t);
  }, [leftOpen, rightOpen]);

  // 抽屉滑动手势（移动端，拖拽跟随 + 松手按进度阈值吸附）：
  //  - 开/收手势都在整个对话页检测（官方：横向滑动代码块等横向可滚动区域除外）
  //  - 两栏都关闭：整页右滑 → 拖出左栏；整页左滑 → 拖出右栏
  //  - 左栏打开：整页左滑 → 收起左栏；右栏打开：整页右滑 → 收起右栏
  //  - 极速滑动时直接完成整个动作；左栏菜单打开时暂停关闭手势
  //  - 仅横向主导才拦截触摸，不干扰列表纵向滚动/下拉刷新
  useEffect(() => {
    const DEAD = 6; // 横向死区 px（避免纵向滚动时的抖动位移）
    const THRESH = 0.5; // 松手进度阈值：过半则吸附到另一侧
    const FLICK = 0.9; // 极速滑动阈值 px/ms：整段拖动的平均手指速度超此值则直接完成
    // 极速判定用：横向拖动起点的手指位置与时刻。
    // 用「整段拖动的平均速度」而不是「最后一次 move 到 touchend」的瞬时速度，
    // 因为松手瞬间手指往往已几乎不动，瞬时速度≈0，无法反映这是一次快速甩动。
    let dragOriginX = 0;
    let dragOriginAt = 0;
    let drawer: 'left' | 'right' | null = null;
    let opening = false; // 「整页开抽屉」手势：目标抽屉未定，由滑动方向在 onMove 首段决定
    let startX = 0;
    let startY = 0;
    let width = 336;
    let fromOpen = false; // 拖拽是否从「打开」状态开始
    let v = 0;
    let suppressClick = false; // 拖拽手势结束后抑制 click 穿透（防止误触抽屉内元素）
    // 手势方向锁定：任一轴先超出死区即锁定，之后不可切换。
    //  'x' = 抽屉手势（锁定列表滚动、只跟 x）；'y' = 纵向滚动手势（放行滚动、不接管抽屉）。
    //  避免斜向滑动时「既收起抽屉又滚动列表」。
    let axis: 'x' | 'y' | null = null;

    const leftEl = () => document.querySelector<HTMLElement>('.drawer-left');
    const rightEl = () => document.querySelector<HTMLElement>('.drawer-right');

    // 命中横向可滚动的元素（如代码块）时不接管为抽屉手势；
    // 官方行为：横向滑动代码块滚动其内容，而不是触发开/关抽屉
    const isHorizOverflowTarget = (el: EventTarget | null): boolean => {
      for (let n = el as Element | null; n && n !== document.body; n = n.parentElement) {
        const cs = getComputedStyle(n);
        const ox = cs.overflowX;
        if ((ox === 'auto' || ox === 'scroll') && n.scrollWidth > n.clientWidth + 1) return true;
      }
      return false;
    };

    // 清理拖拽变量，交还 CSS class 控制 transform（--drawer-x 缺省 = class 默认位置）
    const clearDrag = (el: HTMLElement | null) => {
      if (el) {
        el.style.transition = '';
        el.style.removeProperty('--drawer-x');
      }
    };

    const onStart = (e: TouchEvent) => {
      // 起点落在横向可滚动区域（如代码块）时不接管为抽屉手势，交由该区域自身横向滚动
      if (isHorizOverflowTarget(e.target)) { drawer = null; opening = false; return; }
      const t = e.touches[0];
      const x = t.clientX;
      const bothClosed = !leftOpenRef.current && !rightOpenRef.current;
      const menuOpen = !!document.querySelector('.conv-context-menu');
      let kind: 'closeLeft' | 'closeRight' | 'openWhole' | null = null;
      // 收起手势同样整页检测（不再限定抽屉内）
      if (leftOpenRef.current && !menuOpen) kind = 'closeLeft';
      else if (rightOpenRef.current) kind = 'closeRight';
      // 打开抽屉：检测区域扩展到整个对话页，目标抽屉由滑动方向决定（向右滑开左栏、向左滑开右栏）
      else if (bothClosed) kind = 'openWhole';
      if (!kind) { drawer = null; opening = false; return; }

      startX = x;
      startY = t.clientY;
      axis = null;
      dragOriginAt = 0;
      dragOriginX = 0;

      if (kind === 'openWhole') {
        // 整页手势：目标抽屉未定，等 onMove 横向主导时再落定
        opening = true;
        drawer = null;
        fromOpen = false;
        width = 0;
        v = 0;
        return;
      }

      const isLeft = kind === 'closeLeft';
      const target = isLeft ? leftEl() : rightEl();
      opening = false;
      width = target ? target.offsetWidth : 336;
      drawer = isLeft ? 'left' : 'right';
      fromOpen = isLeft ? leftOpenRef.current : rightOpenRef.current;
      v = fromOpen ? 0 : (isLeft ? -width : width);
    };
    const onMove = (e: TouchEvent) => {
      if (!drawer && !opening) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (axis === null) {
        // 方向竞争：任一轴先超出死区即锁定手势方向（之后不可中途切换）
        if (Math.abs(dx) <= DEAD && Math.abs(dy) <= DEAD) return; // 都在死区内，继续观望
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      if (axis === 'y') return; // 纵向滚动手势：放行列表滚动，全程不接管抽屉
      // 横向主导：记录整段拖动的起点（时刻+手指位置），用于松手时的平均速度判定
      if (dragOriginAt === 0) {
        dragOriginAt = performance.now();
        dragOriginX = t.clientX;
      }
      // 整页开抽屉：横向主导的首段落定目标抽屉——向右滑开左栏，向左滑开右栏
      if (opening) {
        const isLeft = dx > 0;
        const target = isLeft ? leftEl() : rightEl();
        opening = false;
        drawer = isLeft ? 'left' : 'right';
        fromOpen = false;
        width = target ? target.offsetWidth : 336;
        v = isLeft ? -width : width; // 起始=关闭态
      }
      // 抽屉手势（axis === 'x'）：锁定列表滚动/下拉刷新，抽屉始终跟随 x 位移
      e.preventDefault();
      const isLeft = drawer === 'left';
      // 只跟「拉出方向」：左栏 关闭态右滑/打开态左滑，右栏 关闭态左滑/打开态右滑
      const moving = isLeft ? (fromOpen ? dx < 0 : dx > 0) : (fromOpen ? dx > 0 : dx < 0);
      if (moving) {
        v = isLeft ? Math.min(0, Math.max(-width, startV0() + dx)) : Math.max(0, Math.min(width, startV0() + dx));
        const el = isLeft ? leftEl() : rightEl();
        if (el) {
          el.style.transition = 'none';
          el.style.setProperty('--drawer-x', `${v}px`);
        }
      }
    };
    const startV0 = () => (fromOpen ? 0 : (drawer === 'left' ? -width : width));
    const onEnd = (e: TouchEvent) => {
      if (!drawer) return;
      const isLeft = drawer === 'left';
      const el = isLeft ? leftEl() : rightEl();
      if (axis === 'y') {
        // 纵向滚动手势：抽屉未被拖动，直接清理，不做吸附
        clearDrag(el);
        axis = null;
        drawer = null;
        return;
      }
      if (el) {
        // 用 touchend 实际坐标校正最终位移：
        // 触摸采样稀疏时，最后一个 touchmove 可能滞后于手指位置，导致 v 误判（松手回弹）。
        const ct = e.changedTouches && e.changedTouches[0];
        if (ct) {
          const dx = ct.clientX - startX;
          const dy = ct.clientY - startY;
          if (Math.abs(dx) > DEAD && Math.abs(dx) > Math.abs(dy)) {
            const moving = isLeft ? (fromOpen ? dx < 0 : dx > 0) : (fromOpen ? dx > 0 : dx < 0);
            if (moving) {
              v = isLeft
                ? Math.min(0, Math.max(-width, startV0() + dx))
                : Math.max(0, Math.min(width, startV0() + dx));
            }
          }
        }
        // 吸附到一个最终状态并结束手势（更新状态 + 抑制 click 穿透 + 平滑过渡）
        const complete = (targetOpen: boolean) => {
          const targetV = targetOpen ? 0 : (isLeft ? -width : width);
          if (isLeft) {
            setLeftOpen(targetOpen);
            if (targetOpen) setRightOpen(false);
          } else {
            setRightOpen(targetOpen);
            if (targetOpen) setLeftOpen(false);
          }
          suppressClick = true;
          window.setTimeout(() => { suppressClick = false; }, 350);
          // 吸附动画：先确保「无过渡」且以当前位置重排提交一帧，确立为动画起点；
          // 随后恢复 0.28s 过渡并同步写入目标值（同帧完成、无 rAF 等待），
          // 避免松手瞬间因 rAF 被主线程拖慢而「定住」0.1~0.2s 再动。
          // 重排把「无过渡起点」与「过渡+新值」隔开，规避同帧改过渡+改 transform 的跳变。
          el.style.transition = 'none';
          el.style.setProperty('--drawer-x', `${v}px`);
          void el.offsetWidth; // 强制重排，提交当前帧（无过渡的当前位置）
          el.style.transition = '';
          el.style.setProperty('--drawer-x', `${targetV}px`);
        };
        // 极速滑动：整段拖动的手指平均速度超阈值则直接完成整个动作（优先于位移阈值判断）
        let flickOpen = false, flickClose = false;
        if (dragOriginAt > 0 && ct) {
          const dt = performance.now() - dragOriginAt;
          if (dt > 0) {
            const velX = (ct.clientX - dragOriginX) / dt; // 手指 x 平均速度 px/ms，正=向右
            // 左栏：打开=右甩(velX>0)、关闭=左甩(velX<0)；右栏相反
            flickOpen = isLeft ? velX > FLICK : velX < -FLICK;
            flickClose = isLeft ? velX < -FLICK : velX > FLICK;
          }
        }
        if (flickOpen || flickClose) {
          complete(flickOpen);
        } else if (Math.abs(v - startV0()) < 1) {
          // 无实际拖拽（点击/死区内滑动）：直接清变量，交还 class 控制
          clearDrag(el);
        } else {
          const targetOpen = isLeft ? v > -width * (1 - THRESH) : v < width * (1 - THRESH);
          complete(targetOpen);
        }
      }
      axis = null;
      drawer = null;
    };
    const onCancel = () => {
      if (!drawer) return;
      const el = drawer === 'left' ? leftEl() : rightEl();
      clearDrag(el); // 回弹到 class 当前态
      axis = null;
      drawer = null;
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onCancel, { passive: true });
    // 捕获阶段拦截手势拖拽结束后补发的 click（穿透抑制）
    const onClickCapture = (e: MouseEvent) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('click', onClickCapture, true);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onCancel);
      document.removeEventListener('click', onClickCapture, true);
    };
  }, []);

  // 加载会话列表
  //  - preferCache=true（启动）：先渲染本地缓存秒开，再后台拉取同步；失败静默保留缓存
  //  - preferCache=false（下拉刷新/删除/重命名后）：直接拉取最新，立即生效
  //  - silent=true（回前台后台同步）：失败不弹日志，避免打扰
  // 拉取成功后检测：当前打开的会话已不在列表（其他端删除）→ 回到未选择状态
  const loadSessions = async (preferCache = false, silent = false) => {
    if (preferCache) {
      const cached = loadSessionListCache(token);
      if (cached && cached.sessions.length > 0) setSessions(cached.sessions);
    }
    try {
      const d = await fetchAllSessions({ count: 100 });
      saveSessionListCache(token, d);
      setSessions(d);
      // 用 getState 读取最新会话（该函数可能经稳定闭包调用，避免陈旧引用）：
      // 当前打开的会话已不在列表（其他端删除）→ 回到未选择状态
      const curId = useConversation.getState().sessionId;
      if (curId && !d.some((s) => s.id === curId)) {
        const st = useConversation.getState();
        st.setData({ session: null, messages: [], activePath: [], currentMessageId: null });
        st.setConversation(null);
      }
    } catch (e) {
      if (!silent && !preferCache) console.error('加载会话失败', e);
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
      // 先渲染消息（富化文件签名不能阻塞列表加载：fetch_files 挂起会导致一直加载中）
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
      // 打开会话时若存在其他端仍在生成（WIP）的消息，自动续流（对齐官方 resumeLatestMessageAsNeed）
      void resumeWipMessages(id, messages);

      // 后台补全文件描述符（signed_path），完成后原地刷新；失败/超时不影响消息展示
      void enrichMessageFiles(data.chat_messages)
        .then((enriched) => {
          if (seq !== reqSeq.current) return;
          const msgs = enriched.map(normalizeMessage);
          const idx2 = buildIndex(msgs);
          const payload2: SessionCache = {
            session: data.chat_session,
            messages: msgs,
            activePath: activePathOf(idx2, data.chat_session.current_message_id),
            currentMessageId: data.chat_session.current_message_id,
          };
          sessionCache.set(id, payload2);
          if (seq !== reqSeq.current) return;
          conv.setData(payload2);
        })
        .catch(() => { /* 富化失败仅影响图片缩略，忽略 */ });
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

  // ── 恢复其他端仍在生成（WIP）的消息流（对齐官方 resumeLatestMessageAsNeed）──
  // 官方机制：fetchHistory 成功后，对会话内 status=WIP 的 AI 消息调用 /chat/resume_stream 续流，
  // SSE 增量原地更新该消息；若消息已在其他端生成完毕，服务端返回完整消息（full_message）直接替换。
  const resumeWipMessage = useCallback(async (sid: string, wip: NormalizedMessage) => {
    const parser = new DeltaParser();
    const frag = new FragmentTracker();
    // 基准策略（实测续流流从服务端当前状态「完整重放」：快照/首个 APPEND 即全文基准）：
    //  - 快照/SET 直接覆盖（服务端当前状态）
    //  - 首个 APPEND 以该块为基准（丢弃历史内容，避免与重放叠加）
    //  - 后续 APPEND 继续追加
    // 历史内容仅作为流事件到达前的初始显示（首个 APPEND/快照到达后即被流基准取代）。
    let seenThink = !!wip.thinking;
    let thinkContent = wip.thinking?.content ?? '';
    let thinkElapsed: number | null = wip.thinking?.elapsed_secs ?? null;
    let bodyContent = wip.content ?? '';
    let thinkBased = false; // thinking 是否已由流确立基准（快照/SET/首个 APPEND）
    let bodyBased = false; // content 是否已由流确立基准
    let status = wip.status;
    const update = () => {
      useConversation.setState((s) => ({
        messages: s.messages.map((x) =>
          x.id === wip.id
            ? {
                ...x,
                content: bodyContent,
                thinking: seenThink ? { content: thinkContent, elapsed_secs: thinkElapsed } : null,
                status,
              }
            : x,
        ),
      }));
    };
    try {
      await resumeMessage(
        { chat_session_id: sid, message_id: wip.id },
        (ev) => {
          if (ev.type === 'full_message') {
            // 其他端已生成完：直接以完整消息替换本地占位
            if (ev.message) {
              useConversation.setState((s) => ({
                messages: s.messages.map((x) =>
                  x.id === wip.id ? { ...x, ...normalizeMessage(ev.message) } : x,
                ),
              }));
            }
            return;
          }
          for (const op of parser.parse(ev)) {
            frag.apply(op.path, op.op, op.value);
            if (frag.active) {
              bodyContent = frag.content;
              if (frag.thinking) { seenThink = true; thinkContent = frag.thinking; }
              if (frag.elapsedSecs != null) { seenThink = true; thinkElapsed = frag.elapsedSecs; }
              bodyBased = true;
              thinkBased = true;
              continue;
            }
            const p = op.path;
            const v = op.value;
            // 快照事件（无路径、值为 response 对象）：以服务端当前状态为内容基准
            if (!p && v && typeof v === 'object' && (v as any).response) {
              const r = (v as any).response;
              if (typeof r.content === 'string') { bodyContent = r.content; bodyBased = true; }
              if (typeof r.thinking_content === 'string') { seenThink = true; thinkContent = r.thinking_content; thinkBased = true; }
              if (typeof r.status === 'string') status = r.status;
              if (typeof r.thinking_elapsed_secs === 'number') { seenThink = true; thinkElapsed = r.thinking_elapsed_secs; }
              continue;
            }
            if (p === 'response/status' && typeof v === 'string') {
              status = v;
            } else if (p === 'response/thinking_content') {
              if (typeof v === 'string') {
                seenThink = true;
                // 首个 APPEND（未确立基准）即重放的全文起点，直接覆盖历史兜底
                thinkContent = op.op === 'SET' || !thinkBased ? v : thinkContent + v;
                thinkBased = true;
              }
            } else if (p === 'response/thinking_elapsed_secs' && typeof v === 'number') {
              seenThink = true;
              thinkElapsed = v;
            } else if (p === 'response/content') {
              if (typeof v === 'string') {
                bodyContent = op.op === 'SET' || !bodyBased ? v : bodyContent + v;
                bodyBased = true;
              }
            }
          }
          update();
        },
        undefined,
        { vision: useConversation.getState().session?.model_type === 'vision' },
      );
    } catch (e) {
      // 恢复失败（可续流窗口已过/消息不存在/网络）→ 保留历史内容，静默
      console.error('恢复流式生成失败', e);
    }
  }, []);

  // 恢复会话内全部 WIP 消息（openSession / 回前台同步共用）
  const resumeWipMessages = useCallback(async (sid: string, msgs: NormalizedMessage[]) => {
    const wip = msgs.filter((m) => m.role === 'ASSISTANT' && m.status === 'WIP');
    if (!wip.length) return;
    useConversation.getState().setStreaming(true);
    try {
      for (const m of wip) await resumeWipMessage(sid, m);
    } finally {
      useConversation.getState().setStreaming(false);
    }
  }, [resumeWipMessage]);

  // ── 回前台异步同步当前会话（对齐官方：后台期间其他端产生的新消息 / 进行中的 WIP 流）──
  const syncingRef = useRef(false);
  const syncSessionData = useCallback(async (sid: string) => {
    // 判断是否值得 setData（方向性比较，避免无谓的整体重渲染）：
    //  - 消息数变化 / id、status、content、thinking 变化 → 应用
    //  - 文件签名（signed_path/url）变多（富化补全）→ 应用
    //  - 新拉取的裁剪版文件（缺 signed_path）不会覆盖已富化的同内容消息
    const sigCount = (ms: NormalizedMessage[]) =>
      (ms ?? []).reduce((n, m) => n + (m.files ?? []).filter((f) => !!((f as any).signed_path ?? (f as any).url)).length, 0);
    const needsApply = (list: NormalizedMessage[]): boolean => {
      const cur = useConversation.getState().messages;
      if (cur.length !== list.length) return true;
      const curBy = new Map(cur.map((m) => [m.id, m]));
      for (const a of list) {
        const b = curBy.get(a.id);
        if (!b) return true;
        if (a.status !== b.status || a.content !== b.content) return true;
        if ((a.thinking?.content ?? '') !== (b.thinking?.content ?? '')) return true;
        if (sigCount([a]) > sigCount([b])) return true;
      }
      return false;
    };
    try {
      const data = await fetchHistory(sid);
      if (useConversation.getState().sessionId !== sid) return;
      const msgs = data.chat_messages.map(normalizeMessage);
      const apply = (list: NormalizedMessage[], session: ChatSession, currentId: number | null) => {
        const idx = buildIndex(list);
        const payload: SessionCache = {
          session,
          messages: list,
          activePath: activePathOf(idx, currentId),
          currentMessageId: currentId,
        };
        sessionCache.set(sid, payload);
        const st = useConversation.getState();
        if (st.sessionId === sid && needsApply(list)) st.setData(payload);
      };
      apply(msgs, data.chat_session, data.chat_session.current_message_id);
      // 后台富化文件签名（不阻塞同步）
      void enrichMessageFiles(data.chat_messages)
        .then((enriched) => {
          if (useConversation.getState().sessionId !== sid) return;
          apply(enriched.map(normalizeMessage), data.chat_session, data.chat_session.current_message_id);
        })
        .catch(() => {});
      // 恢复仍在生成（WIP）的消息流；续流结束后再与服务端对账一次，落定最终状态/内容
      const wip = msgs.filter((m) => m.role === 'ASSISTANT' && m.status === 'WIP');
      if (wip.length) {
        await resumeWipMessages(sid, wip);
        if (useConversation.getState().sessionId !== sid) return;
        const final = await fetchHistory(sid);
        if (useConversation.getState().sessionId !== sid) return;
        const finalMsgs = final.chat_messages.map(normalizeMessage);
        apply(finalMsgs, final.chat_session, final.chat_session.current_message_id);
      }
    } catch (e) {
      // 后台同步失败静默（不影响当前界面）
      console.error('回前台同步会话失败', e);
    }
  }, [resumeWipMessages]);

  const syncOnForeground = useCallback(() => {
    // 已有本端流式在跑（发送/编辑/重新生成）或同步进行中 → 跳过，避免打断/重复
    if (syncingRef.current || useConversation.getState().streaming) return;
    const sid = useConversation.getState().sessionId;
    if (!sid) return;
    syncingRef.current = true;
    void syncSessionData(sid).finally(() => {
      syncingRef.current = false;
    });
    // 会话列表后台同步（静默失败）
    void loadSessions(false, true);
  }, [syncSessionData]);

  // 前台监听：浏览器 visibilitychange/pageshow + 原生 Activity 生命周期（appState）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') syncOnForeground();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    let appHandle: { remove: () => void } | null = null;
    if (isNativeRuntime()) {
      void DsBridge.addListener('appState', (ev) => {
        if (ev.isActive) syncOnForeground();
      }).then((h) => {
        appHandle = h;
      });
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
      appHandle?.remove();
    };
  }, [syncOnForeground]);

  const isOpen = !!conv.sessionId;

  return (
    <div className={`app-shell ${leftOpen ? 'left-open' : ''} ${rightOpen ? 'right-open' : ''}`}>
      {/* 顶部栏 */}
      <header className="topbar">
        <button className="icon-btn" onClick={toggleLeft} aria-label="会话列表">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <div className="topbar-title">
          {conv.session?.title || (isOpen ? '未命名对话' : '')}
        </div>
        <div className="topbar-actions">
          {isOpen && (
            <button className="icon-btn" onClick={toggleRight} aria-label="分支列表">
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
          open={leftOpen}
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

      {/* 遮罩：始终挂载，用 opacity 过渡淡入淡出（避免关闭瞬间遮罩突然消失造成视觉闪动） */}
      <div
        className={`scrim ${(leftOpen || rightOpen) ? 'visible' : ''}`}
        onClick={() => { setLeftOpen(false); setRightOpen(false); }}
      />

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
            onOpenBranch={() => { setLeftOpen(false); setRightOpen(true); }}
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
