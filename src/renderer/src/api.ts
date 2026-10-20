import type { WorkbenchApi } from '../../shared/api'

/**
 * 渲染层唯一的数据入口。
 *
 * 这里只做两件事：取到 preload 暴露的白名单 API，以及把错误统一转成可读文案。
 * **渲染层不允许自己启动任何 shell 命令** —— 所有执行动作都必须走主进程通道。
 */
export const api: WorkbenchApi = window.workbench

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return '未知错误'
  }
}

export function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} 秒`
}

/** 金额格式化：null 一律显示「无法核验」，绝不用 0 代替。 */
export function formatMoney(value: number | null): string {
  if (value === null) return '无法核验'
  return `¥${value.toFixed(6)}`
}
