import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.broadseek.app',
  appName: 'BroadSeek',
  webDir: 'dist',
  // 本地 WebView 服务，避免 file:// 下 fetch/WebAssembly 受限
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;