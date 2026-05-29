import { defineConfig } from 'vite'

export default defineConfig({
  // root=src 让 index.html 成为构建根，产物落在 dist/index.html（而非 dist/src/index.html），
  // 否则 Tauri 的 frontendDist 找不到 index.html，webview 会显示 "asset not found: index.html"
  root: 'src',
  css: {
    postcss: {
      plugins: []
    }
  },
  build: {
    target: 'es2022',
    // outDir 相对 root(src) 解析，指向包根目录的 dist；outDir 在 root 之外需 emptyOutDir
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 1420,
  },
})