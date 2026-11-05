import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 渲染进程构建配置。
 * base 使用相对路径，便于主进程通过 app:// 自定义协议加载打包产物。
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      // 原生 / 主进程专用依赖一律 external：绝不把 node-llama-cpp 及预编译后端打进渲染产物
      external: [/^node-llama-cpp(\/.*)?$/, /^@node-llama-cpp\//, /^electron(\/.*)?$/],
    },
  },
  server: {
    port: 5178,
    strictPort: true,
  },
});
