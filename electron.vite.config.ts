import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// 主进程与 preload 走 CJS 输出（Node/Electron 最成熟的路径），渲染层走 ESM。
// package.json 刻意不设置 "type": "module"，以保持电子主进程的 CJS 兼容性。
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    }
  }
})
