// 官方 completion SSE 增量解析（操作符格式，p/o 跨事件持久化）
// 参考 raw-api-reference.md 的 DeltaParser
export class DeltaParser {
  private op = 'SET';
  private path = '';
  parse(event: any): { path: string; op: string; value: any }[] {
    let op = this.op = event.o ?? this.op;
    let path = this.path = event.p ?? this.path;
    if (op !== 'BATCH') return [{ path, op, value: event.v }];
    const results: { path: string; op: string; value: any }[] = [];
    for (const item of event.v) {
      for (const s of this.parse(item)) {
        s.path = (path ? path + '/' : '') + s.path;
        results.push(s);
      }
    }
    return results;
  }
}

// 临时消息 id（负数自减，避免与服务器真实 id 冲突）
let tempSeq = 0;
export function nextTempId(): number {
  return --tempSeq;
}

// ── fragments 流格式增量状态机 ──
// 官方客户端（vision 会话 / 带 x-client-* 标识头）的 SSE 用 fragments 结构：
//   - 快照事件 {"v":{"response":{...,"fragments":[{id,type:"THINK"|"RESPONSE"|"TIP",content,elapsed_secs}]}}}
//   - 追加片段   {"p":"response/fragments","o":"APPEND","v":[{...}]}（SET → 整体替换）
//   - 追加内容   {"p":"response/fragments/-1/content","o":"APPEND","v":"..."}（-1 = 最后一个片段；SET → 覆盖）
//   - 思考耗时   {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":number}
// 目标：把增量重组为 {thinking, content, elapsed_secs}，与 delta 格式的消费方对齐。
export interface FragmentItem {
  id?: number;
  type?: string;
  content?: string;
  elapsed_secs?: number | null;
}

export class FragmentTracker {
  private frags: FragmentItem[] = [];
  active = false;
  thinking = '';
  content = '';
  elapsedSecs: number | null = null;

  // path/op/value 取自 DeltaParser.parse 的输出（op 已做跨事件持久化）
  apply(path: string, op: string, value: any) {
    // 快照：v.response.fragments 携带完整数组（路径常为空字符串）
    if (value && typeof value === 'object' && Array.isArray((value as any).response?.fragments)) {
      this.active = true;
      this.frags = ((value as any).response.fragments as FragmentItem[]).map((f) => ({ ...f }));
    } else if (path === 'response/fragments' && (Array.isArray(value) || (value && typeof value === 'object'))) {
      this.active = true;
      const items = Array.isArray(value) ? value : [value];
      if (op === 'APPEND') this.frags.push(...items.map((f) => ({ ...f })));
      else this.frags = items.map((f) => ({ ...f }));
    } else {
      const m = /^response\/fragments\/(-?\d+)\/(content|elapsed_secs)$/.exec(path);
      if (m) {
        this.active = true;
        const idx = Number(m[1]) === -1 ? this.frags.length - 1 : Number(m[1]);
        const frag = this.frags[idx];
        if (!frag) return;
        if (m[2] === 'content') {
          frag.content = op === 'APPEND' ? (frag.content ?? '') + String(value ?? '') : String(value ?? '');
        } else if (typeof value === 'number') {
          frag.elapsed_secs = value;
        }
      }
    }
    this.recompute();
  }

  private recompute() {
    const think = this.frags.filter((f) => f.type === 'THINK');
    this.thinking = think.map((f) => f.content ?? '').join('');
    this.content = this.frags.filter((f) => f.type === 'RESPONSE').map((f) => f.content ?? '').join('');
    const lastThink = think[think.length - 1];
    this.elapsedSecs = lastThink?.elapsed_secs ?? null;
  }
}
