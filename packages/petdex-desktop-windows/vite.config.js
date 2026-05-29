import { defineConfig } from 'vite'

export default defineConfig({
  css: {
    postcss: {
      plugins: []
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: './src/index.html',
      },
    },
  },
  server: {
    port: 1420,
  },
})