import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { HttpsProxyAgent } from 'https-proxy-agent'

// sqlite-wasm 的 OPFS / 多线程依赖 SharedArrayBuffer,
// 需要 COOP/COEP 跨源隔离头. 见 ADR-001.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// Dev proxy 需要 agent 才能走系统 HTTP 代理（Vite http-proxy 默认不读
// HTTPS_PROXY env var）. WSL 下 ccapi.us 被 clash DNS 劫持到 127.0.0.1,
// 但 clash 只监听 :7897, 不监听 :443 → 直连会 socket disconnected.
const systemHttpsProxy =
  process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7897'
const proxyAgent = new HttpsProxyAgent(systemHttpsProxy)

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // sqlite-wasm 不能被预打包, 需作为静态资源按 wasm 原样加载
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  build: {
    rollupOptions: {
      output: {
        // sqlite-wasm 内部用 new URL("xxx", import.meta.url) 硬编码查找
        // 无 hash 文件名, 以下文件必须保留原名, 否则生产 build 找不到:
        //   - sqlite3.wasm               (主 wasm)
        //   - sqlite3-opfs-async-proxy   (OPFS 持久化的 async worker)
        // sqlite3-worker1 不需要 (它由 promiser 显式 URL 加载, hash 不影响)
        assetFileNames: (assetInfo) => {
          const n = assetInfo.name ?? '';
          if (n === 'sqlite3.wasm' || n === 'sqlite3-opfs-async-proxy.js') {
            return `assets/${n}`;
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
  server: {
    headers: crossOriginIsolationHeaders,
    // Dev proxy: /llm-proxy/* → ccapi.us 同源转发,
    // 绕过 Chromium headless 下 COEP require-corp + 代理叠加导致 fetch 挂死。
    // ccapi.us DNS 劫持到 127.0.0.1 (clash), Vite 直连即可。
    // 生产（PWA）不走此 proxy。
    proxy: {
      // 一个 host 一个 proxy entry: 简单稳定, 避免 router 函数不被调用的问题.
      // OpenAiProvider dev mode 根据 baseUrl host 选择对应 prefix.
      '/llm-proxy/ccapi': {
        target: 'https://ccapi.us',
        changeOrigin: true,
        secure: false,
        agent: proxyAgent,
        rewrite: (path) => path.replace(/^\/llm-proxy\/ccapi/, ''),
      },
      '/llm-proxy/deepseek': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        secure: false,
        agent: proxyAgent,
        rewrite: (path) => path.replace(/^\/llm-proxy\/deepseek/, ''),
      },
      // 多端同步 dev proxy: 同源访问 /api/sync/* → 本地 sync-server :3199,
      // 避免浏览器跨源 + 不需要在 sync-server 配 CORS. 生产由 Nginx 反代.
      '/api': {
        target: 'http://127.0.0.1:3199',
        changeOrigin: true,
      },
    },
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
})
