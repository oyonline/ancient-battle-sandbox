import { defineConfig } from 'vite';

// base 用相对路径：GitHub Pages 项目页 / 本地 dist / 任意静态托管都直接可用。
export default defineConfig({
    base: './',
    // dev 端口固定 5301（2026-10-03）：不配 port 会落 Vite 默认 5173，与 EP2.0 UI 的契约端口 5173 相撞。
    // 与对战服 arena.mjs 的 5300 同族，互不冲突。
    server: {
        port: 5301
    },
    build: {
        outDir: 'dist'
    }
});
