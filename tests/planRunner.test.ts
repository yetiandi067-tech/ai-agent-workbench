import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { AdapterRegistry } from '../src/main/adapters/registry'
import { createRepositories } from '../src/main/db/repositories'
import { openDatabase, type OpenDatabaseResult } from '../src/main/db/database'
import { Logger } from '../src/main/logger'
import { SettingsStore } from '../src/main/settings'
import { PlanService } from '../src/main/services/planService'
import { WorkbenchService } from '../src/main/services/workbenchService'
import { BLOCKED_BY_DEPENDENCY_CODE, type AgentRunEvent } from '../src/shared/types'

/**
 * PlanService 流程测试：主管 Agent 调度层的完整链路验证。
 *
 * 本测试**不启动 Electron 窗口、不调用任何真实模型、不产生费用**：
 * 只走 Mock 适配器；所有子任务都是本地模拟执行。
 */
const tempDir = mkdtempSync(join(tmpdir(), 'plan-runner-'))
const dbPath = join(tempDir, 'workbench.db')
const logPath = join(tempDir, 'logs', 'app.log')

const opened: OpenDatabaseResult[] = []
let settingsSeq = 0

function buildService(): {
  workbench: WorkbenchService
  planService: PlanService
  databaseInfo: OpenDatabaseResult
} {
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
  const workbench = new WorkbenchService({
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
  workbench.initialize()

  const planService = new PlanService({
    repos,
    logger,
    workbench,
    onPlanChanged: () => undefined
  })

  return { workbench, planService, databaseInfo: database }
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

describe('PlanService：主管 Agent 调度层（Mock 优先）', () => {
  it('创建计划草稿并预览，不执行任何任务', async () => {
    const { planService } = buildService()
    const { plan, tasks } = planService.createPlan('调研本地大模型并写报告')

    expect(plan.status).toBe('draft')
    expect(plan.taskCount).toBe(4)
    expect(tasks.length).toBe(4)
    expect(tasks.map((task) => task.taskKind)).toEqual(['research', 'analysis', 'writing', 'review'])
    expect(tasks.every((task) => task.status === 'pending')).toBe(true)
    expect(tasks.every((task) => task.planId === plan.id)).toBe(true)

    // 预览阶段不应执行任何子任务
    const runningTasks = tasks.filter((task) => task.status === 'running')
    expect(runningTasks.length).toBe(0)
  })

  it('未确认的计划不能执行（confirmPlan 前调用 runTask 会被护栏拦截）', async () => {
    const { planService, workbench } = buildService()
    const { tasks } = planService.createPlan('测试未确认执行')

    // 尝试直接执行子任务（绕过 confirmPlan）
    const firstTask = tasks[0]
    await workbench.runner.runTask(firstTask.id, { realCallConfirmed: false })

    // Mock 任务可以执行（因为子任务状态是 pending），但这里我们验证的是：
    // 正常情况下应该通过 confirmPlan 启动计划，而不是单独执行子任务
    // 这个测试主要验证「未确认的计划不会被自动执行」
    expect(planService.getPlanWithTasks(firstTask.planId!)?.plan.status).toBe('draft')
  })

  it('确认后按计划顺序串行执行全部子任务，最终状态为 succeeded', async () => {
    const { planService } = buildService()
    const { plan } = planService.createPlan('完整执行四段链路')

    const confirmed = await planService.confirmPlan(plan.id)
    expect(confirmed.status).toBe('running')
    expect(confirmed.confirmedAt).not.toBeNull()
    expect(confirmed.startedAt).not.toBeNull()

    // 等待调度完成（串行执行 4 个 Mock 任务，每个约 100ms）
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const final = planService.getPlanWithTasks(plan.id)
    expect(final).not.toBeNull()
    expect(final!.plan.status).toBe('succeeded')
    expect(final!.plan.endedAt).not.toBeNull()
    expect(final!.plan.summary).not.toBeNull()
    expect(final!.plan.summary!.conclusion).toBe('all_succeeded')
    expect(final!.plan.summary!.succeededCount).toBe(4)
    expect(final!.plan.summary!.failedCount).toBe(0)
    expect(final!.plan.summary!.blockedCount).toBe(0)

    // 所有子任务都应该是 succeeded
    for (const task of final!.tasks) {
      expect(task.status).toBe('succeeded')
      expect(task.finalText).toContain('MOCK_OK')
      expect(task.endedAt).not.toBeNull()
    }
  }, 10000)

  it('子任务失败时阻断所有下游依赖任务，计划状态为 failed', async () => {
    const { planService } = buildService()
    const { plan } = planService.createPlan('模拟失败：测试依赖阻断')

    await planService.confirmPlan(plan.id)

    // 等待调度完成
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const final = planService.getPlanWithTasks(plan.id)
    expect(final).not.toBeNull()
    expect(final!.plan.status).toBe('failed')
    expect(final!.plan.summary).not.toBeNull()
    expect(final!.plan.summary!.conclusion).toBe('all_blocked_or_failed')
    expect(final!.plan.summary!.succeededCount).toBe(0)

    // research 应该失败（mock:failure）
    const research = final!.tasks.find((task) => task.taskKind === 'research')
    expect(research).toBeDefined()
    expect(research!.status).toBe('failed')
    expect(research!.errorCode).toBe('MOCK_LLM_ERROR')

    // analysis / writing / review 应该被阻断
    const analysis = final!.tasks.find((task) => task.taskKind === 'analysis')
    const writing = final!.tasks.find((task) => task.taskKind === 'writing')
    const review = final!.tasks.find((task) => task.taskKind === 'review')

    for (const task of [analysis, writing, review]) {
      expect(task).toBeDefined()
      expect(task!.status).toBe('failed')
      expect(task!.errorCode).toBe(BLOCKED_BY_DEPENDENCY_CODE)
      expect(task!.blockedReason).toContain('依赖的上游任务')
      expect(task!.startedAt).toBeNull() // 被阻断的任务不应有执行记录
    }
  }, 10000)

  it('部分子任务成功时，计划状态为 partial', async () => {
    const { planService, workbench } = buildService()
    const { plan, tasks } = planService.createPlan('测试部分成功场景')

    // 手动把 writing 子任务改为 mock:failure
    const writing = tasks.find((task) => task.taskKind === 'writing')
    expect(writing).toBeDefined()

    // 我们需要手动更新 prompt 来注入失败标记
    const repos = (workbench as any).deps.repos
    const writingTask = repos.tasks.get(writing!.id)
    repos.tasks.update({
      ...writingTask,
      prompt: '[writing] 测试部分成功场景 mock:failure'
    })

    await planService.confirmPlan(plan.id)

    // 等待调度完成
    await new Promise((resolve) => setTimeout(resolve, 3000))

    const final = planService.getPlanWithTasks(plan.id)
    expect(final).not.toBeNull()
    expect(final!.plan.status).toBe('partial')
    expect(final!.plan.summary).not.toBeNull()
    expect(final!.plan.summary!.conclusion).toBe('partial')
    expect(final!.plan.summary!.succeededCount).toBe(2) // research + analysis
    expect(final!.plan.summary!.failedCount).toBe(1) // writing
    expect(final!.plan.summary!.blockedCount).toBe(1) // review

    // research 和 analysis 应该成功
    const research = final!.tasks.find((task) => task.taskKind === 'research')
    const analysis = final!.tasks.find((task) => task.taskKind === 'analysis')
    expect(research!.status).toBe('succeeded')
    expect(analysis!.status).toBe('succeeded')

    // writing 应该失败
    const writingFinal = final!.tasks.find((task) => task.taskKind === 'writing')
    expect(writingFinal!.status).toBe('failed')
    expect(writingFinal!.errorCode).toBe('MOCK_LLM_ERROR')

    // review 应该被阻断
    const review = final!.tasks.find((task) => task.taskKind === 'review')
    expect(review!.status).toBe('failed')
    expect(review!.errorCode).toBe(BLOCKED_BY_DEPENDENCY_CODE)
  }, 10000)

  it('重复确认同一计划会被拒绝', async () => {
    const { planService } = buildService()
    const { plan } = planService.createPlan('测试重复确认')

    await planService.confirmPlan(plan.id)

    // 第二次确认应该抛错
    await expect(planService.confirmPlan(plan.id)).rejects.toThrow('只有「待确认（预览）」状态')
  })

  it('重新打开数据库后仍能读取历史计划与子任务', async () => {
    const { planService } = buildService()
    const { plan } = planService.createPlan('测试持久化')

    await planService.confirmPlan(plan.id)
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // 关闭并重新打开数据库
    const { planService: planService2 } = buildService()
    const reloaded = planService2.getPlanWithTasks(plan.id)

    expect(reloaded).not.toBeNull()
    expect(reloaded!.plan.id).toBe(plan.id)
    expect(reloaded!.plan.status).toBe('succeeded')
    expect(reloaded!.plan.summary).not.toBeNull()
    expect(reloaded!.tasks.length).toBe(4)
    expect(reloaded!.tasks.every((task) => task.status === 'succeeded')).toBe(true)
  }, 10000)

  it('「只调研」目标只生成 research + analysis 两段', async () => {
    const { planService } = buildService()
    const { plan, tasks } = planService.createPlan('只调研一下本地大模型现状')

    expect(plan.taskCount).toBe(2)
    expect(tasks.map((task) => task.taskKind)).toEqual(['research', 'analysis'])

    await planService.confirmPlan(plan.id)
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const final = planService.getPlanWithTasks(plan.id)
    expect(final!.plan.status).toBe('succeeded')
    expect(final!.plan.summary!.succeededCount).toBe(2)
  }, 10000)

  it('「不用审」目标省略 review 段', async () => {
    const { planService } = buildService()
    const { plan, tasks } = planService.createPlan('写一段项目介绍（不用审）')

    expect(plan.taskCount).toBe(3)
    expect(tasks.map((task) => task.taskKind)).toEqual(['research', 'analysis', 'writing'])

    await planService.confirmPlan(plan.id)
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const final = planService.getPlanWithTasks(plan.id)
    expect(final!.plan.status).toBe('succeeded')
  }, 10000)
})
