// 原生桥（Capacitor 插件 DsBridge）封装
// 用于原生 WebView 环境：绕过 chat.deepseek.com 的 CORS/WAF 拦截。
// 提供 request()（普通 JSON）与 startSse()（流式）两个接口。

import { registerPlugin } from '@capacitor/core';
import type { Plugin, PluginListenerHandle } from '@capacitor/core';

export type { PluginListenerHandle };

export interface DsRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface DsResponse {
  status: number;
  data: any;
  headers: Record<string, string>;
}

export interface DsSseEvent {
  type: 'data' | 'end' | 'error';
  key?: string;
  payload?: string;
  status?: number;
  message?: string;
}

export interface DsBridgePlugin extends Plugin {
  request(options: DsRequestOptions): Promise<DsResponse>;
  requestBinary(options: DsRequestOptions): Promise<{
    status: number;
    data: string; // base64
    mimeType: string;
    headers: Record<string, string>;
  }>;
  startSse(options: DsRequestOptions & { key: string }): Promise<void>;
  stopSse(options: { key: string }): Promise<void>;
  addListener(
    eventName: 'sseEvent',
    listener: (event: DsSseEvent) => void,
  ): Promise<PluginListenerHandle>;
}

// 仅原生环境注册（web 环境该插件不存在，走回退逻辑）
export const DsBridge = registerPlugin<DsBridgePlugin>('DsBridge');