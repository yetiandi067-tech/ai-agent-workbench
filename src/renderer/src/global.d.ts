import type { WorkbenchApi } from '../../shared/api'

declare global {
  interface Window {
    /** 由 preload 通过 contextBridge 注入，是渲染层唯一的外部能力入口。 */
    workbench: WorkbenchApi
  }
}

export {}
