import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// 前端源码位于 web/ 目录（保持原有全局脚本风格，js/ 原样拷贝不打包）
export default defineConfig({
    root: 'web',
    base: './',
    build: {
        outDir: '../dist',
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        strictPort: true,
    },
    plugins: [
        viteStaticCopy({
            targets: [
                { src: 'js', dest: '.' },
            ],
        }),
    ],
});
