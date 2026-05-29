import { defineConfig } from 'vite'

export default defineConfig({
  css: {
    postcss: {
      plugins: []
    }
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: './src/index.html',
    },
  },
  server: {
    port: 1420,
  },
})