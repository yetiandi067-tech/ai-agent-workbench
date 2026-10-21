import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { AdapterRegistry } from '../src/main/adapters/registry'
import type { AgentAdapter, RunOutcome } from '../src/main/adapters/types'
import { emptyDiagnostics } from '../src/main/adapters/types'
import { openDatabase, type OpenDatabaseResult } from '../src/main/db/database'
import { createRepositories, type Repositories } from '../src/main/db/repositories'
import { Logger } from '../src/main/logger'
import { SettingsStore } from '../src/main/settings'
import { PlanService } from '../src/main/services/planService'
import { WorkbenchService } from '../src/main/services/workbenchService'
import { buildMockPlan, MockPlanner } from '../src/main/planner/mockPlanner'
import type { Planner, PlannerContext } from '../src/main/planner/types'
import type { AgentDescriptor, Capability, CapabilityState, TaskRecord } from '../src/shared/types'

/** 测试桩能力表（占位，不参与业务判断）。 */
const STUB_CAPABILITIES: Record<Capability, CapabilityState> = {
  submit: 'unverified',
  result: 'unsupported',
  status: 'unsupported',
  cancel: 'unsupported',
  cost: 'unsupported'
}

/**
 * 阶段 3·第二阶段：真实计划的「逐任务授权执行」测试。
 *
 * 全程不启动 Electron、不调用任何真实模型、不产生费用：
 * - 「dsh」适配器被替换为可编程桩（isRealCall=true，直接返回结果，不启动子进程）；
 * - 「stub-real」规划器复用 buildMockPlan 的确定性草稿结构，仅把 agentId 换成 dsh。
 */
const tempDir = mkdtempSync(join(tmpdir(), 'plan-manual-run-'))
const opened: OpenDatabaseResult[] = []
let seq = 0

type StubScript = Array<'succeed' | 'fail'>

function stubRealAdapter(script: StubScript): { adapter: AgentAdapter; getCalls: () => number } {
  let calls = 0
  const adapter: AgentAdapter = {
    id: 'dsh',
    name: 'stub-dsh（测试桩）',
    mode: 'auto',
    isRealCall: true,
    capabilities: () => ({ ...STUB_CAPABILITIES }),
    describe: (): AgentDescriptor => ({
      id: 'dsh',
      name: 'stub-dsh（测试桩）',
      adapterId: 'dsh',
      mode: 'auto',
      isRealCall: true,
      description: '测试桩：直接返回预设结果，不启动任何子进程。',
      capabilities: { ...STUB_CAPABILITIES },
      availability: 'available',
      availabilityDetail: '测试桩',
      version: 'stub',
      checkedAt: null,
      configNote: '仅用于测试'
    }),
    checkAvailability: async () => ({
      id: 'dsh',
      name: 'stub-dsh（测试桩）',
      adapterId: 'dsh',
      mode: 'auto' as const,
      isRealCall: true,
      description: '测试桩：直接返回预设结果，不启动任何子进程。',
      capabilities: { ...STUB_CAPABILITIES },
      availability: 'available' as const,
      availabilityDetail: '测试桩',
      version: 'stub',
      checkedAt: null,
      configNote: '仅用于测试'
    }),
    run: async (_input, _hooks): Promise<RunOutcome> => {
      const step = script[Math.min(calls, script.length - 1)]
      calls += 1
      // 留出并发窗口，供双击防重断言使用
      await new Promise((resolve) => setTimeout(resolve, 30))
      const succeeded = step === 'succeed'
      return {
        status: succeeded ? 'succeeded' : 'failed',
        sessionId: 'stub-session',
        sessionDir: join(tempDir, 'stub-session'),
        finalText: succeeded ? 'STUB_OK' : null,
        exitCode: succeeded ? 0 : 1,
        errorCode: succeeded ? null : 'STUB_FAIL',
        errorMessage: succeeded ? null : 'stub failure（测试桩预设失败）',
        failureKind: succeeded ? null : 'internal_error',
        durationMs: 1,
        usage: null,
        diagnostics: emptyDiagnostics(),
        userNotice: null
      }
    },
    getUsage: () => null
  }
  return { adapter, getCalls: () => calls }
}

const stubRealPlanner: Planner = {
  id: 'stub-real',
  name: 'stub real planner（测试桩）',
  isRealCall: true,
  plan: async (goal: string, _ctx: PlannerContext) => {
    const draft = buildMockPlan(goal)
    return {
      draft: {
        ...draft,
        planner: 'stub-real',
        subtasks: draft.subtasks.map((sub) => ({ ...sub, agentId: 'dsh' }))
      },
      usage: null,
      modelOutputExcerpt: null
    }
  }
}

interface Harness {
  workbench: WorkbenchService
  planService: PlanService
  repos: Repositories
  settings: SettingsStore
  dshCalls: () => number
}

function buildService(dshScript: StubScript = ['succeed']): Harness {
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
  // 用测试桩替换真实 DSH 适配器，确保任何分支都不会启动真实子进程。
  const { adapter: stub, getCalls } = stubRealAdapter(dshScript)
  ;(registry as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set('dsh', stub)

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
    planners: { 'mock-planner': new MockPlanner(), 'stub-real': stubRealPlanner },
    onPlanChanged: () => undefined,
    plannerContext: {
      getSettings: () => settings.get(),
      allowRealCall: () => ({ allowed: true, reason: '' }),
      cwd: tempDir,
      timeoutMs: 30000
    }
  })
  return { workbench, planService, repos, settings, dshCalls: getCalls }
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

async function createRealPlan(harness: Harness): Promise<{ planId: string; tasks: TaskRecord[] }> {
  const created = await harness.planService.createPlan('测试目标：逐任务授权执行', 'stub-real')
  return { planId: created.plan.id, tasks: created.tasks }
}

describe('阶段3·第二阶段：真实计划的逐任务授权执行', () => {
  it('F1 整计划自动执行被服务层拒绝（真实计划 confirmPlan 守卫）', async () => {
    const harness = buildService()
    const { planId, tasks } = await createRealPlan(harness)
    await expect(harness.planService.confirmPlan(planId)).rejects.toThrow(/整计划自动执行/)
    const after = harness.repos.plans.get(planId)
    expect(after?.status).toBe('draft')
    expect(harness.repos.tasks.listByPlan(planId).every((t) => t.status === 'pending')).toBe(true)
    expect(harness.dshCalls()).toBe(0)
    expect(tasks.length).toBeGreaterThan(0)
  })

  it('F2 依赖未满足的子任务被拒绝且不执行', async () => {
    const harness = buildService()
    const { planId, tasks } = await createRealPlan(harness)
    const downstream = tasks[1] // 依赖 #1
    await expect(
      harness.planService.runPlanTask(planId, downstream.id, true)
    ).rejects.toThrow(/依赖的上游任务未全部成功/)
    expect(harness.repos.tasks.listByPlan(planId).find((t) => t.id === downstream.id)?.status).toBe('pending')
    expect(harness.dshCalls()).toBe(0)
    const runs = harness.repos.runs.listByTask(downstream.id)
    expect(runs.length).toBe(0)
  })

  it('F3 真实任务未显式确认时被门控拒绝（REAL_CALL_NOT_CONFIRMED），任务保持 pending', async () => {
    const harness = buildService()
    await harness.settings.update({ allowRealModelCalls: true })
    const { planId, tasks } = await createRealPlan(harness)
    // 门控拒绝是「返回记录」而非抛错：任务不启动、不下游阻断、不产生运行记录
    const finished = await harness.planService.runPlanTask(planId, tasks[0].id, false)
    expect(finished.status).toBe('pending')
    expect(finished.errorCode).toBe('REAL_CALL_NOT_CONFIRMED')
    expect(finished.userNotice).toContain('显式确认')
    const after = harness.repos.tasks.listByPlan(planId)
    expect(after[0].status).toBe('pending')
    expect(after.slice(1).every((t) => t.status === 'pending')).toBe(true)
    expect(harness.dshCalls()).toBe(0)
    expect(harness.repos.runs.listByTask(tasks[0].id).length).toBe(0)
    expect(harness.repos.plans.get(planId)?.status).toBe('running')
  })

  it('F4 总开关关闭时真实任务被门控拒绝（REAL_CALLS_DISABLED）', async () => {
    const harness = buildService()
    const { planId, tasks } = await createRealPlan(harness)
    const finished = await harness.planService.runPlanTask(planId, tasks[0].id, true)
    expect(finished.status).toBe('pending')
    expect(finished.errorCode).toBe('REAL_CALLS_DISABLED')
    expect(harness.dshCalls()).toBe(0)
    expect(harness.repos.tasks.listByPlan(planId).find((t) => t.id === tasks[0].id)?.status).toBe('pending')
    expect(harness.repos.runs.listByTask(tasks[0].id).length).toBe(0)
  })

  it('F5 逐任务授权：单任务成功 → 计划 running 且不自动推进', async () => {
    const harness = buildService(['succeed', 'fail', 'fail', 'fail'])
    await harness.settings.update({ allowRealModelCalls: true })
    const { planId, tasks } = await createRealPlan(harness)
    const finished = await harness.planService.runPlanTask(planId, tasks[0].id, true)
    expect(finished.status).toBe('succeeded')
    expect(finished.finalText).toBe('STUB_OK')
    const plan = harness.repos.plans.get(planId)
    expect(plan?.status).toBe('running')
    const after = harness.repos.tasks.listByPlan(planId)
    expect(after[0].status).toBe('succeeded')
    expect(after.slice(1).every((t) => t.status === 'pending')).toBe(true)
    expect(harness.dshCalls()).toBe(1)
  })

  it('F6 全部子任务逐个授权成功后，计划收尾为 succeeded 且汇总正确', async () => {
    const harness = buildService()
    await harness.settings.update({ allowRealModelCalls: true })
    const { planId, tasks } = await createRealPlan(harness)
    for (const task of tasks) {
      await harness.planService.runPlanTask(planId, task.id, true)
    }
    const plan = harness.repos.plans.get(planId)
    expect(plan?.status).toBe('succeeded')
    const after = harness.repos.tasks.listByPlan(planId)
    expect(after.every((t) => t.status === 'succeeded')).toBe(true)
    expect(harness.dshCalls()).toBe(tasks.length)
  })

  it('F7 失败任务递归阻断下游，计划收尾为 failed', async () => {
    const harness = buildService(['fail'])
    await harness.settings.update({ allowRealModelCalls: true })
    const { planId, tasks } = await createRealPlan(harness)
    await expect(harness.planService.runPlanTask(planId, tasks[0].id, true)).resolves.toBeTruthy()
    const after = harness.repos.tasks.listByPlan(planId)
    expect(after[0].status).toBe('failed')
    expect(after.slice(1).every((t) => t.status === 'failed' && t.errorCode === 'BLOCKED_BY_DEPENDENCY')).toBe(true)
    const plan = harness.repos.plans.get(planId)
    expect(plan?.status).toBe('failed')
    expect(harness.dshCalls()).toBe(1)
  })

  it('F8 同一子任务并发双击：恰好执行一次，第二次被计划锁拒绝', async () => {
    const harness = buildService()
    await harness.settings.update({ allowRealModelCalls: true })
    const { planId, tasks } = await createRealPlan(harness)
    const [first, second] = await Promise.allSettled([
      harness.planService.runPlanTask(planId, tasks[0].id, true),
      harness.planService.runPlanTask(planId, tasks[0].id, true)
    ])
    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled')
    const rejected = [first, second].filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(harness.dshCalls()).toBe(1)
    const task = harness.repos.tasks.listByPlan(planId).find((t) => t.id === tasks[0].id)
    expect(task?.status).toBe('succeeded')
    expect(harness.repos.runs.listByTask(tasks[0].id).length).toBe(1)
  })

  it('F9 已终态子任务不能再次授权执行（不产生重复调用）', async () => {
    const harness = buildService()
    await harness.settings.update({ allowRealModelCalls: true })
    const { planId, tasks } = await createRealPlan(harness)
    await harness.planService.runPlanTask(planId, tasks[0].id, true)
    await expect(harness.planService.runPlanTask(planId, tasks[0].id, true)).rejects.toThrow(
      /只有待执行（pending）的子任务/
    )
    expect(harness.dshCalls()).toBe(1)
    expect(harness.repos.runs.listByTask(tasks[0].id).length).toBe(1)
  })

  it('F10 Mock 计划整计划确认执行不受影响（回归）', async () => {
    const harness = buildService()
    const created = await harness.planService.createPlan('回归：Mock 计划确认执行')
    const planId = created.plan.id
    const confirmed = await harness.planService.confirmPlan(planId)
    expect(confirmed.status).toBe('running')
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const plan = harness.repos.plans.get(planId)
      if (plan && plan.status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(harness.repos.plans.get(planId)?.status).toBe('succeeded')
  })

  it('F11 真实计划的阻断通知与汇总声明不得声称 Mock（按来源选择声明）', async () => {
    const harness = buildService(['fail'])
    await harness.settings.update({ allowRealModelCalls: true })
    const { planId, tasks } = await createRealPlan(harness)
    await harness.planService.runPlanTask(planId, tasks[0].id, true)
    const after = harness.repos.tasks.listByPlan(planId)
    for (const blocked of after.slice(1)) {
      expect(blocked.errorCode).toBe('BLOCKED_BY_DEPENDENCY')
      expect(blocked.userNotice).toContain('被阻断')
      expect(blocked.userNotice).toContain('真实模型（DSH）拆解')
      expect(blocked.userNotice).not.toContain('Mock Planner')
    }
    const plan = harness.repos.plans.get(planId)
    expect(plan?.status).toBe('failed')
    expect(plan?.summary?.report).toContain('真实模型（DSH）拆解')
    expect(plan?.summary?.report).not.toContain('Mock Planner')
  })
})
