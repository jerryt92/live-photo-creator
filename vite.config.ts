import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  // 构建标记：注入构建/启动时刻（上海时区），页脚展示，用于确认页面运行的是哪份代码。
  define: {
    __BUILD_STAMP__: JSON.stringify(
      new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date()).replace(/\//g, '-'),
    ),
  },
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
