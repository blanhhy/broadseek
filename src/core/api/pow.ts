// DeepSeek PoW 求解器（DeepSeekHashV1）
//
// 用浏览器 WebAssembly 加载官方 sha3_wasm_bg.wasm（与官网完全一致的代码），
// 调用 wasm_solve 计算 x-ds-pow-response 头。
//
// 参考: Deepseek-API/pow.py 与 deepseek-free-api/pow_solver.js

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  expire_at: number;
  expire_after: number;
  target_path: string;
}

let _wasmPromise: Promise<WebAssembly.Instance> | null = null;

function getWasmUrl(): string {
  // 浏览器里从 public/wasm 加载；若已配置远程 URL 则用远程
  const remote = (import.meta as any).env?.VITE_DS_WASM_URL as string | undefined;
  return remote || '/wasm/sha3_wasm_bg.wasm';
}

async function loadInstance(): Promise<WebAssembly.Instance> {
  if (_wasmPromise) return _wasmPromise;
  _wasmPromise = (async () => {
    const res = await fetch(getWasmUrl());
    if (!res.ok) throw new Error(`加载 PoW wasm 失败: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(buf, {});
    return instance;
  })();
  return _wasmPromise;
}

function writeString(mem: WebAssembly.Memory, malloc: CallableFunction, text: string): { ptr: number; length: number } {
  const encoded = new TextEncoder().encode(text);
  const ptr = malloc(encoded.length, 1) as number;
  const view = new Uint8Array(mem.buffer);
  for (let i = 0; i < encoded.length; i++) view[ptr + i] = encoded[i];
  return { ptr, length: encoded.length };
}

/**
 * 求解 PoW，返回 answer（整数），失败返回 null
 */
export async function solvePow(challenge: PowChallenge): Promise<number | null> {
  const inst = await loadInstance();
  const exports = inst.exports as any;
  const mem: WebAssembly.Memory = exports.memory;
  const malloc = exports.__wbindgen_export_0 as CallableFunction;
  const addToStack = exports.__wbindgen_add_to_stack_pointer as CallableFunction;
  const wasmSolve = exports.wasm_solve as CallableFunction;

  if (!malloc || !addToStack || !wasmSolve) {
    throw new Error('wasm 缺少所需导出函数（可能官方更新了 wasm，需更新）');
  }

  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const retptr = addToStack(-16) as number;
  try {
    const c = writeString(mem, malloc, challenge.challenge);
    const p = writeString(mem, malloc, prefix);
    wasmSolve(retptr, c.ptr, c.length, p.ptr, p.length, challenge.difficulty);

    const i32 = new Int32Array(mem.buffer);
    const status = i32[retptr / 4];
    if (status === 0) return null;

    const f64 = new Float64Array(mem.buffer);
    const value = f64[(retptr + 8) / 8];
    return Math.floor(value);
  } finally {
    addToStack(16);
  }
}

/**
 * 生成完整的 x-ds-pow-response header 值
 */
export async function makePowHeader(challenge: PowChallenge): Promise<string> {
  const answer = await solvePow(challenge);
  if (answer === null) throw new Error('PoW 求解失败（challenge 可能已过期）');
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  };
  return btoa(JSON.stringify(payload));
}
