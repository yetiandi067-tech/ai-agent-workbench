import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { AdapterRegistry } from '../src/main/adapters/registry'
import { openDatabase, type OpenDatabaseResult } from '../src/main/db/database'
import { createRepositories, type Repositories } from '../src/main/db/repositories'
import { Logger } from '../src/main/logger'
import { buildMockPlan, MockPlanner } from '../src/main/planner/mockPlanner'
import type { Planner, PlannerContext } from '../src/main/planner/types'
import { PlanService } from '../src/main/services/planService'
import { WorkbenchService } from '../src/main/services/workbenchService'
import { SettingsStore } from '../src/main/settings'

/**
 * 阶段 4·第一步：handoff 交接单适配器测试。
 *
 * 全程不启动 Electron、不调用任何真实模型、不启动任何子进程、不产生费用：
 * - trae-cn / workbuddy 是真实的 HandoffAdapter（纯本地生成交接单文本）；
 * - grok 无适配器（应用已卸载，unavailable），验证 NO_ADAPTER 拒绝路径。
 */
const tempDir = mkdtempSync(join(tmpdir(), 'handoff-adapter-'))
const opened: OpenDatabaseResult[] = []
let seq = 0

interface Harness {
  workbench: WorkbenchService
  planService: PlanService
  repos: Repositories
  settings: SettingsStore
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
    allowRealCall: () =>
      settings.get().allowRealModelCalls
        ? { allowed: true, reason: '' }
        : { allowed: false, reason: '真实模型调用总开关为关闭状态（测试）。' }
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
    registry,
    planners: { 'mock-planner': new MockPlanner(), 'stub-handoff': handoffPlanner },
    onPlanChanged: () => undefined,
    plannerContext: {
      getSettings: () => settings.get(),
      allowRealCall: () => ({ allowed: true, reason: '' }),
      cwd: tempDir,
      timeoutMs: 30000
    }
  })
  // 与 index.ts 相同的装配：回填 → 计划恢复调度
  workbench.onHandoffResolved = (planId) => {
    void planService.resumePlan(planId)
  }
  return { workbench, planService, repos, settings }
}

/** 混合计划桩：#1 为 handoff 子任务（trae-cn），其余为 mock（isRealCall=false，守卫放行）。 */
const handoffPlanner: Planner = {
  id: 'stub-handoff',
  name: 'stub handoff planner（测试桩）',
  isRealCall: false,
  plan: async (goal: string, _ctx: PlannerContext) => {
    const draft = buildMockPlan(goal)
    return {
      draft: {
        ...draft,
        planner: 'stub-handoff',
        subtasks: draft.subtasks.map((sub, index) => ({
          ...sub,
          agentId: index === 0 ? 'trae-cn' : 'mock'
        }))
      },
      usage: null,
      modelOutputExcerpt: null
    }
  }
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

async function waitForPlanStatus(
  planService: PlanService,
  planId: string,
  statuses: string[],
  timeoutMs = 8000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const plan = planService.getPlanWithTasks(planId)?.plan
    if (plan && statuses.includes(plan.status)) return plan.status
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return planService.getPlanWithTasks(planId)?.plan.status ?? 'unknown'
}

describe('阶段4·第一步：handoff 交接单适配器', () => {
  it('H1 独立 handoff 任务：生成接单 → needs_confirmation，零子进程零费用', async () => {
    const harness = buildService()
    const created = harness.workbench.createTask({
      title: '交接单任务',
      prompt: '请在 Trae CN 中总结一段文本',
      agentId: 'trae-cn'
    })
    expect(created.isRealCall).toBe(false)

    const finished = await harness.workbench.runTask(created.id, false)
    expect(finished.status).toBe('needs_confirmation')
    expect(finished.finalText).toContain('人工交接单')
    expect(finished.finalText).toContain('请在 Trae CN 中总结一段文本')
    expect(finished.finalText).toContain('Trae CN')
    expect(finished.finalText).toContain('回填指引')
    expect(finished.usage).toBeNull()
    expect(finished.exitCode).toBeNull()

    const runs = harness.repos.runs.listByTask(created.id)
    expect(runs.length).toBe(1)
    expect(runs[0].isRealCall).toBe(false)
    // 可用性描述：mode=handoff，仅人工交接
    const descriptor = harness.workbench.listAgents().find((agent) => agent.id === 'trae-cn')
    expect(descriptor?.mode).toBe('handoff')
    expect(descriptor?.isRealCall).toBe(false)
  })

  it('H2 人工回填成功：needs_confirmation → succeeded，finalText 保留交接单与回填段', async () => {
    const harness = buildService()
    const created = harness.workbench.createTask({
      title: '回填成功任务',
      prompt: 'prompt-h2',
      agentId: 'trae-cn'
    })
    await harness.workbench.runTask(created.id, false)
    const resolved = harness.workbench.submitHandoffResult(created.id, '任务完成，结果如下', true)
    expect(resolved.status).toBe('succeeded')
    expect(resolved.finalText).toContain('人工交接单')
    expect(resolved.finalText).toContain('人工回填结果（成功）')
    expect(resolved.finalText).toContain('任务完成，结果如下')
    expect(resolved.userNotice).toContain('执行成功')
    // 回填事件可审计
    const events = harness.repos.events.listByTask(created.id, 100)
    expect(events.some((event) => event.rawType === 'workbench.handoff_resolved')).toBe(true)
  })

  it('H3 人工回填失败：needs_confirmation → failed，不自动重试', async () => {
    const harness = buildService()
    const created = harness.workbench.createTask({
      title: '回填失败任务',
      prompt: 'prompt-h3',
      agentId: 'workbuddy'
    })
    await harness.workbench.runTask(created.id, false)
    const resolved = harness.workbench.submitHandoffResult(created.id, '', false)
    expect(resolved.status).toBe('failed')
    expect(resolved.userNotice).toContain('不会自动重试')
    // 空回填文本不覆盖交接单
    expect(resolved.finalText).toContain('人工交接单')
  })

  it('H4 非 needs_confirmation 任务回填被拒', async () => {
    const harness = buildService()
    const created = harness.workbench.createTask({
      title: '待执行任务',
      prompt: 'prompt-h4',
      agentId: 'trae-cn'
    })
    expect(() => harness.workbench.submitHandoffResult(created.id, 'x', true)).toThrow(
      /待人工确认/
    )
    // 再次回填已终态任务同样被拒
    await harness.workbench.runTask(created.id, false)
    harness.workbench.submitHandoffResult(created.id, 'done', true)
    expect(() => harness.workbench.submitHandoffResult(created.id, 'again', true)).toThrow(
      /待人工确认/
    )
  })

  it('H5 计划内 handoff 子任务：生成接单后计划暂停，回填成功后继续推进并成功收尾', async () => {
    const harness = buildService()
    const created = await harness.planService.createPlan('测试：handoff 计划', 'stub-handoff')
    const planId = created.plan.id
    const confirmed = await harness.planService.confirmPlan(planId)
    expect(confirmed.status).toBe('running')

    // 调度到 #1（handoff）：生成交接单 → 计划暂停，#2 保持 pending（不被阻断）
    const status1 = await waitForPlanStatus(harness.planService, planId, ['running'])
    expect(status1).toBe('running')
    const tasks = harness.repos.tasks.listByPlan(planId)
    expect(tasks[0].status).toBe('needs_confirmation')
    expect(tasks[0].finalText).toContain('人工交接单')
    expect(tasks.slice(1).every((task) => task.status === 'pending')).toBe(true)
    expect(tasks.slice(1).every((task) => task.errorCode === null)).toBe(true)

    // 人工回填成功 → resumePlan 继续推进 #2（Mock 适配器立即成功）→ 计划成功收尾
    const firstTask = tasks[0]
    const resolved = harness.workbench.submitHandoffResult(firstTask.id, 'handoff done', true)
    expect(resolved.status).toBe('succeeded')

    const status2 = await waitForPlanStatus(harness.planService, planId, ['succeeded', 'failed'])
    expect(status2).toBe('succeeded')
    const after = harness.repos.tasks.listByPlan(planId)
    expect(after.every((task) => task.status === 'succeeded')).toBe(true)
  })

  it('H6 计划内 handoff 子任务回填失败：下游被阻断，计划以失败收尾', async () => {
    const harness = buildService()
    const created = await harness.planService.createPlan('测试：handoff 失败', 'stub-handoff')
    const planId = created.plan.id
    await harness.planService.confirmPlan(planId)
    await waitForPlanStatus(harness.planService, planId, ['running'])

    const tasks = harness.repos.tasks.listByPlan(planId)
    expect(tasks[0].status).toBe('needs_confirmation')
    harness.workbench.submitHandoffResult(tasks[0].id, '', false)

    const status = await waitForPlanStatus(harness.planService, planId, ['succeeded', 'failed'])
    expect(status).toBe('failed')
    const after = harness.repos.tasks.listByPlan(planId)
    expect(after[0].status).toBe('failed')
    expect(after.slice(1).every((task) => task.status === 'failed')).toBe(true)
    expect(after.slice(1).every((task) => task.errorCode === 'BLOCKED_BY_DEPENDENCY')).toBe(true)
  })

  it('H7 真实调用总开关关闭不影响 handoff 执行（isRealCall=false）', async () => {
    const harness = buildService()
    await harness.settings.update({ allowRealModelCalls: false })
    const created = harness.workbench.createTask({
      title: '开关关闭',
      prompt: 'prompt-h7',
      agentId: 'trae-cn'
    })
    const finished = await harness.workbench.runTask(created.id, false)
    expect(finished.status).toBe('needs_confirmation')
  })

  it('H8 grok 暂不可用：创建任务执行被 NO_ADAPTER 拒绝，描述为 unavailable', async () => {
    const harness = buildService()
    const descriptor = harness.workbench.listAgents().find((agent) => agent.id === 'grok')
    expect(descriptor?.mode).toBe('unavailable')
    expect(descriptor?.availability).toBe('unavailable')

    const created = harness.workbench.createTask({
      title: 'grok 任务',
      prompt: 'prompt-h8',
      agentId: 'grok'
    })
    const rejected = await harness.workbench.runTask(created.id, false)
    expect(rejected.status).toBe('pending')
    expect(rejected.errorCode).toBe('NO_ADAPTER')
    expect(harness.repos.runs.listByTask(created.id).length).toBe(0)
  })
})
