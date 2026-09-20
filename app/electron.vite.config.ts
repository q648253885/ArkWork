import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
      },
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          /**
           * ★ v0.35.0：插件 Host 半入口 —— 独立打包成 `out/main/plugin-host.js`。
           *
           * 为什么必须是**独立入口**而不是 index.ts 里顺手 import：
           * 插件代码跑在 `utilityProcess` 里（另一条进程），它需要的是一个
           * **可被 fork 的模块路径**。打进 index.js 会被主进程的启动链带着跑，
           * 与我们「主进程永不 import 插件代码」的边界正相反。
           * 产物名固定 `plugin-host.js`，由 supervisor 按此路径 fork。
           */
          'plugin-host': resolve(__dirname, 'src/main/plugins/runtime/host-entry.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // v0.26.0 P0：浮窗/迷你模式独立入口（BrowserChrome），主进程以
          // pathToFileURL(out/renderer/browser-toolbar.html) 加载，杜绝内联 HTML
          'browser-toolbar': resolve(__dirname, 'src/renderer/browser-toolbar.html'),
        },
      },
    },
    server: {
      port: 5174,
    },
  },
})
