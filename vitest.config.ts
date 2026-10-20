import { defineConfig } from 'vitest/config'

// 单元测试只跑纯逻辑（解析器 / 状态机 / 适配器契约），不启动 Electron、不调用真实模型。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: 'default'
  }
})
