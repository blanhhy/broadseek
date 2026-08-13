// Vite 配置：dev 下把 /api/v0 代理到 chat.deepseek.com 以绕过 CORS
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api/v0': {
        target: 'https://chat.deepseek.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
});