import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { AdapterRegistry } from '../src/main/adapters/registry'
import { openDatabase, type OpenDatabaseResult } from '../src/main/db/database'
import { createRepositories, type Repositories } from '../src/main/db/repositories'
import { Logger } from '../src/main/logger'
import { SettingsStore } from '../src/main/settings'
import { PlanService } from '../src/main/services/planService'
import { WorkbenchService } from '../src/main/services/workbenchService'
import {
  BLOCKED_BY_DEPENDENCY_CODE,
  INTERRUPTED_LAST_RUN_CODE,
  type PlanRecord,
  type TaskRecord
} from '../src/shared/types'

/**
 * 第 4 步·阶段 2：主管调度层「加固」测试。
 *
 * 覆盖 SPEC 第七节列出的依赖阻断 / 防重复执行 / 并发确认 / 异常计划 / 重启恢复 /
 * 汇总口径 / 错误处理等专项场景。
 *
 * 全程**不启动 Electron、不调用任何真实模型、不产生费用**：只用 Mock 适配器与临时数据库。
 */
const tempDir = mkdtempSync(join(tmpdir(), 'plan-hardening-'))
const opened: OpenDatabaseResult[] = []
let seq = 0

interface Harness {
  workbench: WorkbenchService
  planService: PlanService
  repos: Repositories
  settings: SettingsStore
  database: OpenDatabaseResult
}

function buildService(): Harness {
  seq += 1
  const settingsPath = join(tempDir, `settings-${seq}.json`)
  const dbPath = join(tempDir, `db-${seq}.db`)
  const settings = new SettingsStore({ filePath: settingsPath, projectRoot: tempDir })
  const database = openDatabase(dbPath)
  opened.push(database)
  const repos = createRepositories(database.db)
  const registry = new AdapterRegistry({
    getSettings: () => settings.get(),
    allowRealCall: () => {
      const current = settings.get()
      return current.allowRealModelCalls
        ? { allowed: true, reason: '' }
        : { allowed: false, reason: '真实模型调用总开关为关闭状态（测试）。' }
    }
  })
  const logger = new Logger(join(tempDir, `logs-${seq}`, 'app.log'))
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
      logDir: join(tempDir, `logs-${seq}`)
    },
    onTaskChanged: () => undefined,
    onRunEvent: () => undefined
  })
  workbench.initialize()

  const planService = new PlanService({
    repos,
    logger,
    workbench,
    onPlanChanged: () => undefined
  })
  return { workbench, planService, repos, settings, database }
}

afterAll(() => {
  for (const database of opened) {
    try {
      database.db.close()
    } catch {
      // 重复关闭会抛错，忽略
    }
  }
  rmSync(tempDir, { recursive: true, force: true })
})

/** 轮询等待条件成立（确定性强，长于 8s 视为失败）。 */
async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor 超时：条件未在预期时间内成立')
}

function planOf(harness: Harness, planId: string): {
  plan: PlanRecord
  tasks: TaskRecord[]
} {
  const plan = harness.repos.plans.get(planId)
  if (!plan) throw new Error(`计划不存在：${planId}`)
  return { plan, tasks: harness.repos.tasks.listByPlan(planId) }
}

function countRuns(harness: Harness, planId: string): number {
  return harness.repos.tasks
    .listByPlan(planId)
    .reduce((sum, task) => sum + harness.repos.runs.listByTask(task.id).length, 0)
}

function injectPrompt(harness: Harness, task: TaskRecord, prompt: string): void {
  harness.repos.tasks.update({ ...task, prompt })
}

describe('计划加固：创建与顺序执行', () => {
  it('E1：创建计划只生成草稿，不执行任何子任务（无运行记录）', () => {
    const harness = buildService()
    const { plan, tasks } = harness.planService.createPlan('只创建不执行')

    expect(plan.status).toBe('draft')
    expect(plan.confirmedAt).toBeNull()
    expect(tasks.every((task) => task.status === 'pending')).toBe(true)
    expect(countRuns(harness, plan.id)).toBe(0)
  })

  it('E2：正常依赖链按 seq 顺序串行执行', async () => {
    const harness = buildService()
    const { plan } = harness.planService.createPlan('顺序执行校验')

    await harness.planService.confirmPlan(plan.id)
    await waitFor(() => planOf(harness, plan.id).plan.status !== 'running')

    const { plan: final, tasks } = planOf(harness, plan.id)
    expect(final.status).toBe('succeeded')

    // 每个子任务的 startedAt 必须随 seq 非递减（串行执行，不并发）
    const started = tasks
      .slice()
      .sort((a, b) => (a.planSeq ?? 0) - (b.planSeq ?? 0))
      .map((task) => task.startedAt)
    expect(started.every((value) => value !== null)).toBe(true)
    for (let i = 1; i < started.length; i += 1) {
      expect(started[i]! >= started[i - 1]!).toBe(true)
    }
  })
})

describe('计划加固：失败阻断递归传播', () => {
  it('E3：第一项任务失败，全部下游被阻断且无 pending 残留', async () => {
    const harness = buildService()
    const { plan } = harness.planService.createPlan('模拟失败：首项阻断')
    await harness.planService.confirmPlan(plan.id)
    await waitFor(() => planOf(harness, plan.id).plan.status !== 'running')

    const { plan: final, tasks } = planOf(harness, plan.id)
    expect(final.status).toBe('failed')
    expect(tasks.every((task) => task.status !== 'pending' && task.status !== 'running')).toBe(true)

    const research = tasks.find((task) => task.taskKind === 'research')!
    expect(research.status).toBe('failed')
    expect(research.errorCode).toBe('MOCK_LLM_ERROR')

    for (const downstream of tasks.filter((task) => task.taskKind !== 'research')) {
      expect(downstream.status).toBe('failed')
      expect(downstream.errorCode).toBe(BLOCKED_BY_DEPENDENCY_CODE)
      expect(downstream.blockedReason).toContain('依赖的上游任务')
      expect(downstream.startedAt).toBeNull()
      // 被阻断的任务不应产生运行记录（未实际执行）
      expect(harness.repos.runs.listByTask(downstream.id).length).toBe(0)
    }
  })

  it('E4：中间任务失败，后续任务递归阻断（含多级下游）', async () => {
    const harness = buildService()
    const { plan, tasks } = harness.planService.createPlan('中间失败递归阻断')
    const analysis = tasks.find((task) => task.taskKind === 'analysis')!
    injectPrompt(harness, analysis, '[analysis] 中间失败递归阻断 mock:failure')

    await harness.planService.confirmPlan(plan.id)
    await waitFor(() => planOf(harness, plan.id).plan.status !== 'running')

    const { plan: final, tasks: finalTasks } = planOf(harness, plan.id)
    expect(final.status).toBe('partial')
    const byKind = Object.fromEntries(finalTasks.map((task) => [task.taskKind, task]))
    expect(byKind.research.status).toBe('succeeded')
    expect(byKind.analysis.status).toBe('failed')
    expect(byKind.analysis.errorCode).toBe('MOCK_LLM_ERROR')
    // writing 依赖 analysis，review 依赖 writing —— 两级递归阻断
    expect(byKind.writing.errorCode).toBe(BLOCKED_BY_DEPENDENCY_CODE)
    expect(byKind.review.errorCode).toBe(BLOCKED_BY_DEPENDENCY_CODE)
    expect(byKind.review.blockedReason).toContain('依赖的上游任务')
  })
})

describe('计划加固：超时 / 取消的上游阻断', () => {
  it('E5a：上游超时（timed_out）后，下游被阻断', async () => {
    const harness = buildService()
    // 最小允许超时 5s；把首个子任务改为「一直等到超时」的 Mock 场景
    harness.settings.update({ taskTimeoutMs: 5000 })
    const { plan, tasks } = harness.planService.createPlan('超时阻断校验')
    const research = tasks.find((task) => task.taskKind === 'research')!
    injectPrompt(harness, research, '[research] 超时阻断校验 mock:timeout')

    await harness.planService.confirmPlan(plan.id)
    await waitFor(() => planOf(harness, plan.id).plan.status !== 'running', 20000)

    const { plan: final, tasks: finalTasks } = planOf(harness, plan.id)
    expect(final.status).toBe('failed')
    const researchFinal = finalTasks.find((task) => task.taskKind === 'research')!
    expect(researchFinal.status).toBe('timed_out')
    for (const downstream of finalTasks.filter((task) => task.taskKind !== 'research')) {
      expect(downstream.errorCode).toBe(BLOCKED_BY_DEPENDENCY_CODE)
    }
    // 汇总口径：超时任务计入「失败」，总数守恒
    expect(final.summary!.totalCount).toBe(finalTasks.length)
    expect(
      final.summary!.succeededCount + final.summary!.failedCount + final.summary!.blockedCount
    ).toBe(final.summary!.totalCount)
  }, 30000)

  it('E5b：上游取消（cancelled）后，下游被阻断', async () => {
    const harness = buildService()
    // 让首个任务长时间运行（等待超时），以便在运行中取消
    const { plan, tasks } = harness.planService.createPlan('取消阻断校验')
    const research = tasks.find((task) => task.taskKind === 'research')!
    injectPrompt(harness, research, '[research] 取消阻断校验 mock:timeout')

    await harness.planService.confirmPlan(plan.id)
    await waitFor(() => harness.workbench.runner.activeTaskIds.includes(research.id), 8000)
    expect(harness.workbench.runner.cancelTask(research.id)).toBe(true)
    await waitFor(() => planOf(harness, plan.id).plan.status !== 'running', 8000)

    const { plan: final, tasks: finalTasks } = planOf(harness, plan.id)
    expect(final.status).toBe('failed')
    expect(finalTasks.find((task) => task.taskKind === 'research')!.status).toBe('cancelled')
    for (const downstream of finalTasks.filter((task) => task.taskKind !== 'research')) {
      expect(downstream.errorCode).toBe(BLOCKED_BY_DEPENDENCY_CODE)
    }
  }, 20000)
})

describe('计划加固：防重复执行与并发确认', () => {
  it('E7：重复确认被拒绝，且不会重复执行子任务', async () => {
    const harness = buildService()
    const { plan, tasks } = harness.planService.createPlan('重复确认校验')

    await harness.planService.confirmPlan(plan.id)
    await expect(harness.planService.confirmPlan(plan.id)).rejects.toThrow()
    await waitFor(() => planOf(harness, plan.id).plan.status !== 'running')

    // 每个子任务只执行一次 → 运行记录数 == 子任务数
    expect(countRuns(harness, plan.id)).toBe(tasks.length)
  })

  it('E8：并发两次确认只允许一次生效，子任务不重复执行', async () => {
    const harness = buildService()
    const { plan, tasks } = harness.planService.createPlan('并发确认校验')

    const results = await Promise.allSettled([
      harness.planService.confirmPlan(plan.id),
      harness.planService.confirmPlan(plan.id)
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled').length
    const rejected = results.filter((result) => result.status === 'rejected').length
    expect(fulfilled).toBe(1)
    expect(rejected).toBe(1)

    await waitFor(() => planOf(harness, plan.id).plan.status !== 'running')
    expect(countRuns(harness, plan.id)).toBe(tasks.length)
  })
})

describe('计划加固：异常计划（无效 / 循环依赖）', () => {
  it('E9a：循环依赖的计划不会无限循环，被安全终止', async () => {
    const harness = buildService()
    const planId = 'plan-cyclic'
    const now = new Date().toISOString()
    harness.repos.plans.create({
      id: planId,
      title: '循环依赖',
      goal: '循环依赖',
      status: 'draft',
      planner: 'test',
      createdAt: now,
      confirmedAt: null,
      startedAt: null,
      endedAt: null,
      summary: null,
      blockedReason: null,
      taskCount: 2
    })
    // A 依赖 B，B 依赖 A —— 互相等待，永远无可推进任务
    harness.repos.tasks.create(mkTask({ id: 'cyc-a', planId, seq: 1, dependsOn: ['cyc-b'] }))
    harness.repos.tasks.create(mkTask({ id: 'cyc-b', planId, seq: 2, dependsOn: ['cyc-a'] }))

    await harness.planService.confirmPlan(planId)
    await waitFor(() => planOf(harness, planId).plan.status !== 'running')

    const { plan, tasks } = planOf(harness, planId)
    expect(plan.status).toBe('failed')
    expect(tasks.every((task) => task.status === 'failed')).toBe(true)
    expect(tasks.every((task) => task.errorCode === BLOCKED_BY_DEPENDENCY_CODE)).toBe(true)
  }, 15000)

  it('E9b：依赖 ID 无效（指向不存在的任务）时被安全阻断', async () => {
    const harness = buildService()
    const planId = 'plan-missing-dep'
    const now = new Date().toISOString()
    harness.repos.plans.create({
      id: planId,
      title: '无效依赖',
      goal: '无效依赖',
      status: 'draft',
      planner: 'test',
      createdAt: now,
      confirmedAt: null,
      startedAt: null,
      endedAt: null,
      summary: null,
      blockedReason: null,
      taskCount: 1
    })
    harness.repos.tasks.create(
      mkTask({ id: 'miss-a', planId, seq: 1, dependsOn: ['does-not-exist'] })
    )

    await harness.planService.confirmPlan(planId)
    await waitFor(() => planOf(harness, planId).plan.status !== 'running')

    const { plan, tasks } = planOf(harness, planId)
    expect(plan.status).toBe('failed')
    expect(tasks[0].status).toBe('failed')
    expect(tasks[0].errorCode).toBe(BLOCKED_BY_DEPENDENCY_CODE)
  }, 15000)
})

describe('计划加固：终态一致性与汇总口径', () => {
  it('E6/E10/E12：完成计划无 pending/running 残留，汇总与数据库最终状态一致', async () => {
    const harness = buildService()
    const { plan } = harness.planService.createPlan('口径一致性校验')
    await harness.planService.confirmPlan(plan.id)
    await waitFor(() => planOf(harness, plan.id).plan.status !== 'running')

    const { plan: final, tasks } = planOf(harness, plan.id)
    const summary = final.summary!

    // E10：无 pending / running 残留
    expect(tasks.some((task) => task.status === 'pending' || task.status === 'running')).toBe(false)

    // E12：汇总统计与数据库最终状态一致
    expect(summary.totalCount).toBe(tasks.length)
    expect(summary.succeededCount).toBe(tasks.filter((t) => t.status === 'succeeded').length)
    expect(summary.blockedCount).toBe(
      tasks.filter((t) => t.errorCode === BLOCKED_BY_DEPENDENCY_CODE).length
    )
    expect(summary.failedCount).toBe(tasks.length - summary.succeededCount - summary.blockedCount)
    expect(
      summary.succeededCount + summary.failedCount + summary.blockedCount
    ).toBe(summary.totalCount)

    // perTask 与数据库逐条一致
    for (const item of summary.perTask) {
      const task = tasks.find((t) => t.id === item.taskId)!
      expect(item.status).toBe(task.status)
    }
  })

  it('E6b：报告明确标注 Mock，且不把未执行任务伪装成成功', async () => {
    const harness = buildService()
    const { plan } = harness.planService.createPlan('模拟失败：报告不伪装')
    await harness.planService.confirmPlan(plan.id)
    await waitFor(() => planOf(harness, plan.id).plan.status !== 'running')

    const { plan: final, tasks } = planOf(harness, plan.id)
    expect(final.summary!.report).toContain('Mock')
    for (const task of tasks) {
      const item = final.summary!.perTask.find((entry) => entry.taskId === task.id)!
      if (task.status === 'succeeded') {
        expect(item.outputExcerpt).not.toBeNull()
      } else {
        // 未成功 / 被阻断的任务不得伪造产出摘要
        expect(item.outputExcerpt).toBeNull()
      }
    }
  })
})

describe('计划加固：重启恢复', () => {
  it('E11：中断的计划重启后不自动重跑，子任务落成明确终态且需要人工检查', () => {
    const harness = buildService()
    const { plan, tasks } = harness.planService.createPlan('中断恢复校验')

    // 模拟「应用在执行中异常退出」：计划被标为 running，首个子任务卡在 running，其余仍 pending
    harness.repos.plans.update({
      ...harness.repos.plans.get(plan.id)!,
      status: 'running',
      startedAt: new Date().toISOString()
    })
    harness.repos.tasks.update({ ...tasks[0], status: 'running', startedAt: new Date().toISOString() })

    const recovered = harness.planService.recoverStalePlans()
    expect(recovered).toBe(1)

    const { plan: restored, tasks: restoredTasks } = planOf(harness, plan.id)
    expect(restored.status).toBe('failed')
    expect(restored.blockedReason).toContain('上次运行被中断')
    expect(restored.blockedReason).toContain('需要人工检查')

    // 不存在残留的 pending / running
    expect(restoredTasks.some((t) => t.status === 'pending' || t.status === 'running')).toBe(false)
    // 原 running 任务遵循既有「待人工确认」策略
    expect(restoredTasks[0].status).toBe('needs_confirmation')
    // 从未执行的 pending 任务落成「中断未执行」，不伪装成成功/失败结果
    for (const task of restoredTasks.slice(1)) {
      expect(task.status).toBe('failed')
      expect(task.errorCode).toBe(INTERRUPTED_LAST_RUN_CODE)
      expect(task.userNotice).toContain('需要人工检查')
    }

    // 不自动重跑：没有任何运行记录产生
    expect(countRuns(harness, plan.id)).toBe(0)

    // 幂等：再次恢复不应重复处理
    expect(harness.planService.recoverStalePlans()).toBe(0)
  })

  it('E11b：恢复不会重跑未知状态任务（多次调用后仍为 0 运行记录）', () => {
    const harness = buildService()
    const { plan } = harness.planService.createPlan('恢复幂等校验')
    harness.repos.plans.update({
      ...harness.repos.plans.get(plan.id)!,
      status: 'running'
    })
    harness.planService.recoverStalePlans()
    harness.planService.recoverStalePlans()
    expect(countRuns(harness, plan.id)).toBe(0)
  })
})

describe('计划加固：错误处理（无效目标 / 计划 ID / 非法转换）', () => {
  it('E14a：空目标被拒绝', () => {
    const harness = buildService()
    expect(() => harness.planService.createPlan('')).toThrow('总目标不能为空')
    expect(() => harness.planService.createPlan('   ')).toThrow('总目标不能为空')
  })

  it('E14b：确认不存在的计划 ID 报错，查询返回 null', async () => {
    const harness = buildService()
    expect(() => harness.repos.plans.get('not-exist')).not.toThrow()
    expect(harness.planService.getPlanWithTasks('not-exist')).toBeNull()
    await expect(harness.planService.confirmPlan('not-exist')).rejects.toThrow('计划不存在')
  })

  it('E14c：非法状态转换（对已完成计划再次确认）被明确拒绝', async () => {
    const harness = buildService()
    const { plan } = harness.planService.createPlan('非法转换校验')
    await harness.planService.confirmPlan(plan.id)
    await waitFor(() => planOf(harness, plan.id).plan.status !== 'running')

    // 计划已 succeeded，再次确认应被拒绝（不是静默成功，也不是重复执行）
    await expect(harness.planService.confirmPlan(plan.id)).rejects.toThrow('只有「待确认（预览）」状态')
  })
})

/** 构造一个最小可用的 TaskRecord（用于手工注入异常计划）。 */
function mkTask(input: {
  id: string
  planId: string
  seq: number
  dependsOn: string[]
}): TaskRecord {
  const now = new Date().toISOString()
  return {
    id: input.id,
    title: `子任务 #${input.seq}`,
    prompt: `[research] 子任务 #${input.seq}`,
    agentId: 'mock',
    adapterId: 'mock',
    isRealCall: false,
    status: 'pending',
    createdAt: now,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    exitCode: null,
    sessionId: null,
    sessionDir: null,
    finalText: null,
    errorCode: null,
    errorMessage: null,
    failureKind: null,
    usage: null,
    cwd: null,
    attempt: 1,
    userNotice: null,
    planId: input.planId,
    planSeq: input.seq,
    taskKind: 'research',
    dependsOn: input.dependsOn,
    acceptance: '返回 succeeded 即视为通过。',
    blockedReason: null
  }
}
