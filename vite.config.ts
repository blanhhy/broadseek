// Vite 配置：dev 下把 /api/v0 代理到 chat.deepseek.com 以绕过 CORS；
// /file-svc 代理到 files.deepseeksvc.com 并补 Referer，绕过 WAF 的跨域来源校验
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api/v0': {
        target: 'https://chat.deepseek.com',
        changeOrigin: true,
        secure: true,
      },
      '/file-svc': {
        target: 'https://files.deepseeksvc.com',
        changeOrigin: true,
        secure: true,
        // 剥掉 /file-svc 前缀，转发成 https://files.deepseeksvc.com/api/file?...
        rewrite: (path) => path.replace(/^\/file-svc/, ''),
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            // 图片签名 URL 走文件服务，需伪装成从 chat.deepseek.com 发起的来源
            proxyReq.setHeader('Referer', 'https://chat.deepseek.com/');
            proxyReq.setHeader('Origin', 'https://chat.deepseek.com');
          });
        },
      },
    },
  },
});