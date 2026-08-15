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
