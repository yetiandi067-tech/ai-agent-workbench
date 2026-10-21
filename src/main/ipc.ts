import { BrowserWindow, ipcMain } from 'electron'

import { IPC_CHANNELS } from '../shared/api'
import type {
  AgentRunEvent,
  AppSettings,
  CreateTaskInput,
  PlanFilter,
  TaskFilter,
  TaskRecord
} from '../shared/types'
import type { PlanService } from './services/planService'
import type { WorkbenchService } from './services/workbenchService'

/**
 * IPC 处理器注册。
 *
 * 每个入口都做参数类型校验 —— 渲染层传来的任何东西都视为「不可信输入」，
 * 避免把畸形数据直接灌进数据库或调度器。
 */
function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`参数 ${field} 必须是非空字符串。`)
  }
  return value
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`参数 ${field} 必须是对象。`)
  }
  return value as Record<string, unknown>
}

/** 只挑出设置里已知的键，忽略渲染层可能夹带的其他字段。 */
const SETTING_KEYS: Array<keyof AppSettings> = [
  'dshExePath',
  'dshCliScript',
  'dshProfile',
  'dshHomeDir',
  'taskCwd',
  'taskTimeoutMs',
  'realConcurrencyLimit',
  'mockConcurrencyLimit',
  'allowRealModelCalls'
]

export function makePushHandlers(getWindow: () => BrowserWindow | null): {
  onTaskChanged: (task: TaskRecord) => void
  onRunEvent: (taskId: string, event: AgentRunEvent) => void
  onPlanChanged: (plan: import('../shared/types').PlanRecord) => void
} {
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  return {
    onTaskChanged: (task: TaskRecord) => send(IPC_CHANNELS.evtTaskChanged, task),
    // 渲染层收到的是 { taskId, event }（与 preload 的 RunEventPush 契约一致）。
    onRunEvent: (taskId: string, event: AgentRunEvent) =>
      send(IPC_CHANNELS.evtRunEvent, { taskId, event }),
    onPlanChanged: (plan) => send(IPC_CHANNELS.evtPlanChanged, plan)
  }
}

export function registerWorkbenchIpc(
  service: WorkbenchService,
  planService: PlanService
): void {
  ipcMain.handle(IPC_CHANNELS.overview, () => service.overview())

  ipcMain.handle(IPC_CHANNELS.agentsList, () => service.listAgents())

  ipcMain.handle(IPC_CHANNELS.agentCheck, async (_event, agentId: unknown) =>
    service.checkAgent(assertString(agentId, 'agentId'))
  )

  ipcMain.handle(IPC_CHANNELS.guardrails, () => service.guardrails())

  ipcMain.handle(IPC_CHANNELS.tasksList, (_event, rawFilter: unknown) => {
    const filter = (rawFilter ?? {}) as Record<string, unknown>
    const normalized: TaskFilter = {}
    if (typeof filter.status === 'string') {
      normalized.status = filter.status as TaskFilter['status']
    }
    if (typeof filter.agentId === 'string' && filter.agentId.length > 0) {
      normalized.agentId = filter.agentId
    }
    if (typeof filter.limit === 'number') normalized.limit = filter.limit
    return service.listTasks(normalized)
  })

  ipcMain.handle(IPC_CHANNELS.taskCreate, (_event, rawInput: unknown) => {
    const input = asRecord(rawInput, 'input')
    const createInput: CreateTaskInput = {
      title: assertString(input.title, 'title'),
      prompt: assertString(input.prompt, 'prompt'),
      agentId: assertString(input.agentId, 'agentId')
    }
    return service.createTask(createInput)
  })

  ipcMain.handle(IPC_CHANNELS.taskGet, (_event, taskId: unknown) =>
    service.getTask(assertString(taskId, 'taskId'))
  )

  ipcMain.handle(IPC_CHANNELS.taskEvents, (_event, taskId: unknown, limit: unknown) =>
    service.getTaskEvents(assertString(taskId, 'taskId'), typeof limit === 'number' ? limit : 500)
  )

  ipcMain.handle(
    IPC_CHANNELS.taskRun,
    async (_event, taskId: unknown, realCallConfirmed: unknown) =>
      service.runTask(assertString(taskId, 'taskId'), realCallConfirmed === true)
  )

  ipcMain.handle(IPC_CHANNELS.taskCancel, (_event, taskId: unknown) =>
    service.cancelTask(assertString(taskId, 'taskId'))
  )

  ipcMain.handle(
    IPC_CHANNELS.taskHandoffResult,
    (_event, taskId: unknown, resultText: unknown, succeeded: unknown) =>
      service.submitHandoffResult(
        assertString(taskId, 'taskId'),
        typeof resultText === 'string' ? resultText : '',
        succeeded === true
      )
  )

  ipcMain.handle(IPC_CHANNELS.runsList, (_event, limit: unknown) =>
    service.listRuns(typeof limit === 'number' ? limit : 200)
  )

  ipcMain.handle(IPC_CHANNELS.settingsGet, () => service.getSettings())

  ipcMain.handle(IPC_CHANNELS.settingsUpdate, (_event, rawPatch: unknown) => {
    const source = asRecord(rawPatch, 'patch')
    const patch: Partial<AppSettings> = {}
    for (const key of SETTING_KEYS) {
      const value = source[key]
      if (value === undefined) continue
      if (key === 'allowRealModelCalls') {
        patch.allowRealModelCalls = value === true
        continue
      }
      if (typeof value === 'number') {
        switch (key) {
          case 'taskTimeoutMs':
            patch.taskTimeoutMs = value
            break
          case 'realConcurrencyLimit':
            patch.realConcurrencyLimit = value
            break
          case 'mockConcurrencyLimit':
            patch.mockConcurrencyLimit = value
            break
          default:
            break
        }
        continue
      }
      if (typeof value === 'string') {
        switch (key) {
          case 'dshExePath':
            patch.dshExePath = value
            break
          case 'dshCliScript':
            patch.dshCliScript = value
            break
          case 'dshProfile':
            patch.dshProfile = value
            break
          case 'dshHomeDir':
            patch.dshHomeDir = value
            break
          case 'taskCwd':
            patch.taskCwd = value
            break
          default:
            break
        }
      }
    }
    return service.updateSettings(patch)
  })

  ipcMain.handle(IPC_CHANNELS.systemInfo, () => service.systemInfo())

  // 主管计划相关 IPC
  ipcMain.handle(IPC_CHANNELS.planCreate, (_event, goal: unknown, plannerId: unknown) =>
    planService.createPlan(
      assertString(goal, 'goal'),
      typeof plannerId === 'string' && plannerId.length > 0 ? plannerId : undefined
    )
  )

  ipcMain.handle(IPC_CHANNELS.planConfirm, (_event, planId: unknown) =>
    planService.confirmPlan(assertString(planId, 'planId'))
  )

  ipcMain.handle(
    IPC_CHANNELS.planRunTask,
    (_event, planId: unknown, taskId: unknown, realCallConfirmed: unknown) =>
      planService.runPlanTask(
        assertString(planId, 'planId'),
        assertString(taskId, 'taskId'),
        realCallConfirmed === true
      )
  )

  ipcMain.handle(IPC_CHANNELS.planList, (_event, rawFilter: unknown) => {
    const filter = (rawFilter ?? {}) as Record<string, unknown>
    const normalized: PlanFilter = {}
    if (typeof filter.status === 'string') {
      normalized.status = filter.status as PlanFilter['status']
    }
    if (typeof filter.limit === 'number') normalized.limit = filter.limit
    return planService.listPlans(normalized)
  })

  ipcMain.handle(IPC_CHANNELS.planGet, (_event, planId: unknown) =>
    planService.getPlanWithTasks(assertString(planId, 'planId'))
  )
}
