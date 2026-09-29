import { defineConfig } from 'vite';

// base 用相对路径：GitHub Pages 项目页 / 本地 dist / 任意静态托管都直接可用。
export default defineConfig({
    base: './',
    build: {
        outDir: 'dist'
    }
});
