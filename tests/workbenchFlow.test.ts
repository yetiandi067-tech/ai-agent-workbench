import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { AdapterRegistry } from '../src/main/adapters/registry'
import { createRepositories } from '../src/main/db/repositories'
import { openDatabase, type OpenDatabaseResult } from '../src/main/db/database'
import { Logger } from '../src/main/logger'
import { SettingsStore } from '../src/main/settings'
import { WorkbenchService } from '../src/main/services/workbenchService'
import type { AgentRunEvent, TaskRecord } from '../src/shared/types'

/**
 * 端到端（无窗口）流程验证：任务创建 → 状态机 → Mock 执行 → 落库 → 重新打开数据库后仍可读到。
 *
 * 本测试**不启动 Electron 窗口、不调用任何真实模型、不产生费用**：
 * 只走 Mock 适配器；真实 DSH 任务只验证「被护栏拦截」这一路径。
 */
const tempDir = mkdtempSync(join(tmpdir(), 'workbench-flow-'))
const dbPath = join(tempDir, 'workbench.db')
const logPath = join(tempDir, 'logs', 'app.log')

const opened: OpenDatabaseResult[] = []
// 每个 buildService 用独立的设置文件，避免测试之间互相污染（例如某个测试打开了真实调用开关）。
let settingsSeq = 0

function buildService(): { service: WorkbenchService; databaseInfo: OpenDatabaseResult } {
  const settingsPath = join(tempDir, `settings-${settingsSeq++}.json`)
  const settings = new SettingsStore({ filePath: settingsPath, projectRoot: tempDir })
  const database = openDatabase(dbPath)
  opened.push(database)
  const repos = createRepositories(database.db)
  const registry = new AdapterRegistry({
    getSettings: () => settings.get(),
    allowRealCall: () => {
      const current = settings.get()
      if (!current.allowRealModelCalls) {
        return { allowed: false, reason: '真实模型调用总开关为关闭状态（测试）。' }
      }
      return { allowed: true, reason: '' }
    }
  })
  const logger = new Logger(logPath)
  const service = new WorkbenchService({
    repos,
    registry,
    settings,
    logger,
    databaseInfo: {
      filePath: database.filePath,
      mode: database.mode,
      detail: database.detail,
      schemaVersion: database.schemaVersion
    },
    environment: {
      appVersion: 'test',
      electronVersion: 'test',
      nodeVersion: process.versions.node,
      chromeVersion: 'test',
      platform: 'test',
      userDataDir: tempDir,
      logDir: join(tempDir, 'logs')
    },
    onTaskChanged: () => undefined,
    onRunEvent: (_taskId: string, _event: AgentRunEvent) => undefined
  })
  service.initialize()
  return { service, databaseInfo: database }
}

afterAll(() => {
  for (const database of opened) {
    try {
      database.db.close()
    } catch {
      // 已关闭的库重复关闭会抛错，忽略即可
    }
  }
  rmSync(tempDir, { recursive: true, force: true })
})

describe('数据库与 Mock 任务流程', () => {
  it('首次打开即完成建表，模式为 file', () => {
    const { databaseInfo } = buildService()
    expect(databaseInfo.mode).toBe('file')
    expect(databaseInfo.schemaVersion).toBeGreaterThanOrEqual(1)
  })

  it('创建 Mock 任务 → 执行成功 → 用量与状态正确', async () => {
    const { service } = buildService()

    const created = service.createTask({
      title: 'Mock 链路自测',
      prompt: 'mock:success 这是本地模拟',
      agentId: 'mock'
    })
    expect(created.status).toBe('pending')
    expect(created.isRealCall).toBe(false)

    const finished = await service.runTask(created.id, false)
    expect(finished.status).toBe('succeeded')
    expect(finished.finalText).toContain('MOCK_OK')
    expect(finished.exitCode).toBe(0)
    expect(finished.usage?.totalTokens).toBe(160)
    // 关键：金额无法核验，绝不用 0 冒充
    expect(finished.usage?.actualCost).toBeNull()
    expect(finished.usage?.verified).toBe(false)
    expect(finished.usage?.source).toBe('unknown')

    const overview = service.overview()
    expect(overview.succeeded).toBe(1)
    expect(overview.knownTokensTotal).toBe(160)
    expect(overview.verifiedCostTotal).toBe(0)
    expect(overview.costUnverifiedTaskCount).toBe(0) // Mock 非真实调用

    // 事件流已落库并能取回
    const events = service.getTaskEvents(created.id)
    expect(events.length).toBeGreaterThan(0)
    // 调度器先写入一条 workbench.task_status，随后才是适配器事件
    expect(events[0].rawType).toBe('workbench.task_status')
    expect(events.some((event) => event.type === 'session')).toBe(true)
    expect(events.some((event) => event.type === 'final')).toBe(true)
  })

  it('终态任务不可重复执行（避免重复计费 / 重复执行）', async () => {
    const { service } = buildService()
    const created = service.createTask({
      title: '重复执行守卫',
      prompt: 'mock:success',
      agentId: 'mock'
    })
    const first = await service.runTask(created.id, false)
    expect(first.status).toBe('succeeded')

    const second = await service.runTask(created.id, false)
    expect(second.status).toBe('succeeded')
    expect(second.errorCode).toBe('NOT_PENDING')
  })

  it('真实调用总开关关闭时，真实任务被拦截且不启动子进程', async () => {
    const { service } = buildService()
    const created = service.createTask({
      title: '真实任务护栏',
      prompt: '这是一个真实任务（测试中不应真的发起调用）',
      agentId: 'dsh'
    })
    expect(created.isRealCall).toBe(true)

    const blocked = await service.runTask(created.id, true)
    // 被拦截：状态保持 pending，未进入 running，未产生退出码
    expect(blocked.status).toBe('pending')
    expect(blocked.errorCode).toBe('REAL_CALLS_DISABLED')
    expect(blocked.exitCode).toBeNull()
    expect(blocked.usage).toBeNull()
  })

  it('未显式确认时，即使总开关已开启也会被拦截', async () => {
    const { service } = buildService()
    service.updateSettings({ allowRealModelCalls: true })
    const created = service.createTask({
      title: '未确认的真实任务',
      prompt: '真实任务（未确认）',
      agentId: 'dsh'
    })
    const blocked = await service.runTask(created.id, false)
    expect(blocked.status).toBe('pending')
    expect(blocked.errorCode).toBe('REAL_CALL_NOT_CONFIRMED')
    expect(blocked.exitCode).toBeNull()
  })

  it('人工交接型 Agent 没有执行路径，会被明确拒绝', async () => {
    const { service } = buildService()
    const created = service.createTask({
      title: 'Trae 交接任务',
      prompt: '交给 Trae',
      agentId: 'trae-cn'
    })
    expect(created.userNotice).toContain('人工交接')
    const refused = await service.runTask(created.id, true)
    expect(refused.errorCode).toBe('NO_ADAPTER')
  })
})

describe('持久化：重新打开数据库后仍可读到历史任务', () => {
  it('关闭并重新打开数据库，任务与运行记录仍在', async () => {
    const { service } = buildService()
    const created = service.createTask({
      title: '重启后仍可查',
      prompt: 'mock:success 持久化验证',
      agentId: 'mock'
    })
    await service.runTask(created.id, false)

    const before = service.getTask(created.id)
    expect(before?.status).toBe('succeeded')

    // 关闭全部已打开的库，再用同一文件重新打开（模拟应用重启）
    for (const database of opened.splice(0)) {
      try {
        database.db.close()
      } catch {
        // 忽略重复关闭
      }
    }
    const reopened = openDatabase(dbPath)
    opened.push(reopened)
    const repos = createRepositories(reopened.db)

    const persisted: TaskRecord | null = repos.tasks.get(created.id)
    expect(persisted).not.toBeNull()
    expect(persisted?.status).toBe('succeeded')
    expect(persisted?.title).toBe('重启后仍可查')
    expect(persisted?.finalText).toContain('MOCK_OK')
    expect(persisted?.usage?.totalTokens).toBe(160)
    expect(persisted?.usage?.actualCost).toBeNull()

    expect(repos.runs.listByTask(created.id).length).toBe(1)
    expect(repos.events.countByTask(created.id)).toBeGreaterThan(0)
  })
})
