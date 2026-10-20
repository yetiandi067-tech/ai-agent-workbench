import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { AppSettings } from '../shared/types'

export type { AppSettings }

export interface SettingsStoreOptions {
  filePath: string
  projectRoot: string
}

export const TIMEOUT_MIN_MS = 5_000
export const TIMEOUT_MAX_MS = 600_000

export function createDefaultSettings(projectRoot: string, home: string = homedir()): AppSettings {
  return {
    dshExePath: 'E:\\gsh\\DeepSeek Harness.exe',
    dshCliScript:
      'E:\\gsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
    dshProfile: 'headless',
    dshHomeDir: join(home, '.dsh'),
    taskCwd: join(projectRoot, 'workspace'),
    taskTimeoutMs: 120_000,
    realConcurrencyLimit: 1,
    mockConcurrencyLimit: 3,
    allowRealModelCalls: false
  }
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function normalizeSettings(patch: Partial<AppSettings>, base: AppSettings): AppSettings {
  const merged: AppSettings = { ...base, ...patch }
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback

  return {
    dshExePath: str(merged.dshExePath, base.dshExePath),
    dshCliScript: str(merged.dshCliScript, base.dshCliScript),
    dshProfile: str(merged.dshProfile, base.dshProfile),
    dshHomeDir: str(merged.dshHomeDir, base.dshHomeDir),
    taskCwd: str(merged.taskCwd, base.taskCwd),
    taskTimeoutMs: clamp(merged.taskTimeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, base.taskTimeoutMs),
    realConcurrencyLimit: clamp(merged.realConcurrencyLimit, 1, 4, base.realConcurrencyLimit),
    mockConcurrencyLimit: clamp(merged.mockConcurrencyLimit, 1, 8, base.mockConcurrencyLimit),
    allowRealModelCalls: merged.allowRealModelCalls === true
  }
}

export class SettingsStore {
  private settings: AppSettings

  constructor(private readonly opts: SettingsStoreOptions) {
    this.settings = this.load()
  }

  get(): AppSettings {
    return this.settings
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = normalizeSettings(patch, this.settings)
    this.persist()
    return this.settings
  }

  private filePath(): string {
    return this.opts.filePath
  }

  private load(): AppSettings {
    const defaults = createDefaultSettings(this.opts.projectRoot)
    try {
      if (!existsSync(this.filePath())) {
        const result = defaults
        this.writeFile(result)
        return result
      }
      const raw = readFileSync(this.filePath(), 'utf8')
      if (raw.trim().length === 0) return defaults
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      return normalizeSettings(parsed, defaults)
    } catch {
      // 设置文件损坏不应导致应用无法启动 —— 退回默认值并继续。
      return defaults
    }
  }

  private persist(): void {
    try {
      this.writeFile(this.settings)
    } catch {
      // 写盘失败只影响下次启动的默认值，不影响本次运行。
    }
  }

  private writeFile(value: AppSettings): void {
    const dir = dirname(this.filePath())
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.filePath(), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }
}
