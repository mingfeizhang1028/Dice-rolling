import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages 子路径安全：不管部署在 /Dice-rolling/ 还是根域都成立
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // three 那块 hash 长期不变，第二次访问只下载 app 代码。
        // 对 PWA 更新体验影响很大：用户更新时只需要几十 KB，而不是 600 KB。
        //
        // ⚠️ 必须写成函数。Vite 8 底层是 rolldown，对象形式（Rollup 的老写法）
        //    会直接报 "manualChunks is not a function" 并中断构建。
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/cannon-es')) return 'physics';
          return null;
        },
      },
    },
  },
  server: { host: true, port: 5173 },
});
