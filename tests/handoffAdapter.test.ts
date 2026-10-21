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
import { buildMockPlan, MockPlanner } from '../src/main/planner/mockPlanner'
import type { Planner, PlannerContext } from '../src/main/planner/types'
import { PlanService } from '../src/main/services/planService'
import { WorkbenchService } from '../src/main/services/workbenchService'
import { SettingsStore } from '../src/main/settings'
import type { Capability, CapabilityState } from '../src/shared/types'

/** 测试桩能力表（占位，不参与业务判断）。 */
const STUB_CAPABILITIES: Record<Capability, CapabilityState> = {
  submit: 'unverified',
  result: 'unsupported',
  status: 'unsupported',
  cancel: 'unsupported',
  cost: 'unsupported'
}

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
  registry: AdapterRegistry
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
    planners: {
      'mock-planner': new MockPlanner(),
      'stub-handoff': handoffPlanner,
      'stub-mixed': mixedPlanner
    },
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
  return { workbench, planService, repos, settings, registry }
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

/** handoff + real 混合计划桩：#1 handoff（trae-cn），#2 real（stub-real），#3+ mock。 */
const mixedPlanner: Planner = {
  id: 'stub-mixed',
  name: 'stub mixed planner（测试桩）',
  isRealCall: false,
  plan: async (goal: string, _ctx: PlannerContext) => {
    const draft = buildMockPlan(goal)
    return {
      draft: {
        ...draft,
        planner: 'stub-mixed',
        subtasks: draft.subtasks.map((sub, index) => ({
          ...sub,
          agentId: index === 0 ? 'trae-cn' : index === 1 ? 'stub-real' : 'mock'
        }))
      },
      usage: null,
      modelOutputExcerpt: null
    }
  }
}

/** 真实调用桩适配器：isRealCall=true，run 直接返回成功（不启动子进程）。 */
function stubRealAdapter(): AgentAdapter {
  return {
    id: 'stub-real',
    name: 'stub-real（测试桩）',
    mode: 'auto',
    isRealCall: true,
    capabilities: () => ({ ...STUB_CAPABILITIES }),
    describe: () => ({
      id: 'stub-real',
      name: 'stub-real（测试桩）',
      adapterId: 'stub-real',
      mode: 'auto',
      isRealCall: true,
      description: '测试桩：isRealCall=true，run 直接返回成功。',
      capabilities: { ...STUB_CAPABILITIES },
      availability: 'available',
      availabilityDetail: '测试桩',
      version: 'stub',
      checkedAt: null,
      configNote: '仅用于测试'
    }),
    checkAvailability: async () => stubRealAdapter().describe(),
    run: async (_input): Promise<RunOutcome> => ({
      status: 'succeeded',
      sessionId: 'stub-session',
      sessionDir: join(tempDir, 'stub-session'),
      finalText: 'STUB_REAL_OK',
      exitCode: 0,
      errorCode: null,
      errorMessage: null,
      failureKind: null,
      durationMs: 1,
      usage: null,
      diagnostics: emptyDiagnostics(),
      userNotice: null
    }),
    getUsage: () => null
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

  it('H9 混合 handoff + real 计划：回填 handoff 后不无限循环，real 任务保持 pending 等待授权', async () => {
    const harness = buildService()
    // 注入真实调用桩适配器（isRealCall=true，不启动子进程）
    ;(harness.registry as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      'stub-real',
      stubRealAdapter()
    )

    const created = await harness.planService.createPlan('测试：混合计划', 'stub-mixed')
    const planId = created.plan.id

    // 含 real 任务的计划不能整计划执行（confirmPlan 守卫）
    await expect(harness.planService.confirmPlan(planId)).rejects.toThrow(/逐个子任务/)

    // 逐任务授权执行 #1（handoff）→ 生成交接单，计划保持 running
    const tasks = harness.repos.tasks.listByPlan(planId)
    const handoffTask = tasks.find((t) => t.agentId === 'trae-cn')!
    await harness.planService.runPlanTask(planId, handoffTask.id, false)
    expect(harness.repos.tasks.get(handoffTask.id)?.status).toBe('needs_confirmation')
    expect(harness.planService.getPlanWithTasks(planId)?.plan.status).toBe('running')

    // 回填 #1 成功 → resumePlan 推进：碰到 #2（real）时跳过，不无限循环
    harness.workbench.submitHandoffResult(handoffTask.id, 'done', true)
    // 给 resumePlan 一个执行窗口（异步 fire-and-forget）
    await new Promise((resolve) => setTimeout(resolve, 300))

    const after = harness.repos.tasks.listByPlan(planId)
    const realTask = after.find((t) => t.agentId === 'stub-real')!
    // real 任务保持 pending（等待用户显式授权），没有被门控拦截反复执行
    expect(realTask.status).toBe('pending')
    expect(realTask.errorCode).toBe(null)
    // 计划仍 running（等待 real 任务授权），没有 finalize
    expect(harness.planService.getPlanWithTasks(planId)?.plan.status).toBe('running')
  })

  it('H10 应用重启恢复：含 needs_confirmation 子任务的计划保持 running，可继续回填', async () => {
    const harness1 = buildService()
    const created = await harness1.planService.createPlan('测试：重启恢复', 'stub-handoff')
    const planId = created.plan.id
    await harness1.planService.confirmPlan(planId)
    await waitForPlanStatus(harness1.planService, planId, ['running'])
    const tasksBefore = harness1.repos.tasks.listByPlan(planId)
    expect(tasksBefore[0].status).toBe('needs_confirmation')
    const handoffTaskId = tasksBefore[0].id

    // 模拟重启：用同一数据库文件重建服务（不重新建库，数据保留）
    const dbDir = tempDir
    const dbSeq = seq // 当前 buildService 已用 seq 个 db，复用最后一个路径
    const dbPath = join(dbDir, `db-${dbSeq}.db`)

    const settings2 = new SettingsStore({
      filePath: join(dbDir, `settings-${dbSeq}-2.json`),
      projectRoot: dbDir
    })
    const database2 = openDatabase(dbPath)
    opened.push(database2)
    const repos2 = createRepositories(database2.db)
    const registry2 = new AdapterRegistry({
      getSettings: () => settings2.get(),
      allowRealCall: () => ({ allowed: true, reason: '' })
    })
    const logger2 = new Logger(join(dbDir, `logs-${dbSeq}-2`, 'app.log'))
    const workbench2 = new WorkbenchService({
      repos: repos2,
      registry: registry2,
      settings: settings2,
      logger: logger2,
      databaseInfo: {
        filePath: database2.filePath,
        mode: database2.mode,
        detail: database2.detail,
        schemaVersion: database2.schemaVersion
      },
      environment: {
        appVersion: 'test',
        electronVersion: 'test',
        nodeVersion: process.versions.node,
        chromeVersion: 'test',
        platform: 'test',
        userDataDir: dbDir,
        logDir: join(dbDir, `logs-${dbSeq}-2`)
      },
      onTaskChanged: () => undefined,
      onRunEvent: () => undefined
    })
    workbench2.initialize()
    const planService2 = new PlanService({
      repos: repos2,
      logger: logger2,
      workbench: workbench2,
      registry: registry2,
      planners: { 'mock-planner': new MockPlanner(), 'stub-handoff': handoffPlanner },
      onPlanChanged: () => undefined,
      plannerContext: {
        getSettings: () => settings2.get(),
        allowRealCall: () => ({ allowed: true, reason: '' }),
        cwd: dbDir,
        timeoutMs: 30000
      }
    })
    workbench2.onHandoffResolved = (pid) => {
      void planService2.resumePlan(pid)
    }

    // 启动恢复：含 needs_confirmation 的计划应保持 running，不被置 failed
    const recovered = planService2.recoverStalePlans()
    expect(recovered).toBe(1)
    const planAfterRecover = planService2.getPlanWithTasks(planId)?.plan
    expect(planAfterRecover?.status).toBe('running')

    // pending 子任务被标注为「上次运行被中断」（failed + INTERRUPTED_LAST_RUN）
    const tasksAfterRecover = repos2.tasks.listByPlan(planId)
    expect(tasksAfterRecover[0].status).toBe('needs_confirmation') // 交接单任务保留
    expect(tasksAfterRecover.slice(1).every((t) => t.status === 'failed')).toBe(true)
    expect(
      tasksAfterRecover.slice(1).every((t) => t.errorCode === 'INTERRUPTED_LAST_RUN')
    ).toBe(true)

    // 用户仍可回填 handoff 子任务，回填后计划继续推进并收尾
    workbench2.submitHandoffResult(handoffTaskId, 'done after restart', true)
    const finalStatus = await waitForPlanStatus(planService2, planId, [
      'succeeded',
      'failed',
      'partial'
    ])
    expect(finalStatus).toBe('partial') // #1 成功，但 #2+ 已被中断标记为 failed → partial
  })
})
