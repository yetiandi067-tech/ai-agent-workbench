import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { redactText } from '../shared/redact'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogMeta {
  [key: string]: unknown
}

/**
 * 追加写日志。两条纪律：
 * 1. 所有文本先脱敏（日志里不允许出现凭据）；
 * 2. 写日志失败 **绝不能** 让应用崩溃。
 */
export class Logger {
  private ready = false

  constructor(
    private readonly filePath: string,
    private readonly minLevel: LogLevel = 'info'
  ) {
    try {
      const dir = dirname(filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      this.ready = true
    } catch {
      this.ready = false
    }
  }

  debug(message: string, meta?: LogMeta): void {
    this.write('debug', message, meta)
  }

  info(message: string, meta?: LogMeta): void {
    this.write('info', message, meta)
  }

  warn(message: string, meta?: LogMeta): void {
    this.write('warn', message, meta)
  }

  error(message: string, meta?: LogMeta): void {
    this.write('error', message, meta)
  }

  private write(level: LogLevel, message: string, meta?: LogMeta): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message: redactText(message),
      meta: meta === undefined ? undefined : JSON.parse(redactText(JSON.stringify(meta)))
    })
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)

    if (!this.ready) return
    try {
      appendFileSync(this.filePath, `${line}\n`, 'utf8')
    } catch {
      this.ready = false
    }
  }
}
