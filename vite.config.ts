import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    host: true,
    allowedHosts: ['test.jerryt92.top', 'jerryt92.top'],
    port: 5173,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 4096,
  },
})
