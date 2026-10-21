import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS, type RunEventPush, type WorkbenchApi } from '../shared/api'
import type {
  AgentDescriptor,
  AgentRunEvent,
  AppSettings,
  CancelResult,
  CreateTaskInput,
  CreateTemplateInput,
  GuardrailItem,
  Overview,
  PlanFilter,
  PlanRecord,
  PlanWithTasks,
  RunRecord,
  SystemInfo,
  TaskFilter,
  TaskRecord,
  TaskStats,
  TaskTemplate,
  UpdateTemplateInput
} from '../shared/types'

/**
 * 预加载桥。
 *
 * 只暴露一份**白名单 API**：渲染层拿不到 ipcRenderer、拿不到 Node、也不能
 * 自己拼命令去起子进程。所有真正的执行能力都由主进程在受控通道里实现。
 */
const api: WorkbenchApi = {
  getOverview: (): Promise<Overview> => ipcRenderer.invoke(IPC_CHANNELS.overview),
  listAgents: (): Promise<AgentDescriptor[]> => ipcRenderer.invoke(IPC_CHANNELS.agentsList),
  checkAgent: (agentId: string): Promise<AgentDescriptor> =>
    ipcRenderer.invoke(IPC_CHANNELS.agentCheck, agentId),
  getGuardrails: (): Promise<GuardrailItem[]> => ipcRenderer.invoke(IPC_CHANNELS.guardrails),

  listTasks: (filter?: TaskFilter): Promise<TaskRecord[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.tasksList, filter ?? {}),
  createTask: (input: CreateTaskInput): Promise<TaskRecord> =>
    ipcRenderer.invoke(IPC_CHANNELS.taskCreate, input),
  getTask: (id: string): Promise<TaskRecord | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.taskGet, id),
  getTaskEvents: (id: string, limit?: number): Promise<AgentRunEvent[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.taskEvents, id, limit ?? 500),
  runTask: (id: string, realCallConfirmed: boolean): Promise<TaskRecord> =>
    ipcRenderer.invoke(IPC_CHANNELS.taskRun, id, realCallConfirmed),
  cancelTask: (id: string): Promise<CancelResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.taskCancel, id),
  submitHandoffResult: (taskId: string, resultText: string, succeeded: boolean): Promise<TaskRecord> =>
    ipcRenderer.invoke(IPC_CHANNELS.taskHandoffResult, taskId, resultText, succeeded),

  listRuns: (limit?: number): Promise<RunRecord[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.runsList, limit ?? 200),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch),
  getSystemInfo: (): Promise<SystemInfo> => ipcRenderer.invoke(IPC_CHANNELS.systemInfo),

  planCreate: (goal: string, plannerId?: string): Promise<PlanWithTasks> =>
    ipcRenderer.invoke(IPC_CHANNELS.planCreate, goal, plannerId),
  planConfirm: (planId: string): Promise<PlanRecord> =>
    ipcRenderer.invoke(IPC_CHANNELS.planConfirm, planId),
  planRunTask: (planId: string, taskId: string, realCallConfirmed: boolean): Promise<TaskRecord> =>
    ipcRenderer.invoke(IPC_CHANNELS.planRunTask, planId, taskId, realCallConfirmed),
  planList: (filter?: PlanFilter): Promise<PlanRecord[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.planList, filter ?? {}),
  planGet: (planId: string): Promise<PlanWithTasks | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.planGet, planId),

  listTemplates: (agentId?: string): Promise<TaskTemplate[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.templateList, agentId),
  createTemplate: (input: CreateTemplateInput): Promise<TaskTemplate> =>
    ipcRenderer.invoke(IPC_CHANNELS.templateCreate, input),
  updateTemplate: (input: UpdateTemplateInput): Promise<TaskTemplate> =>
    ipcRenderer.invoke(IPC_CHANNELS.templateUpdate, input),
  deleteTemplate: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.templateDelete, id),

  batchCancelTasks: (taskIds: string[]): Promise<Array<{ taskId: string; accepted: boolean; message: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.batchCancelTasks, taskIds),
  batchDeleteTasks: (taskIds: string[]): Promise<Array<{ taskId: string; deleted: boolean; message: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.batchDeleteTasks, taskIds),

  getTaskStats: (createdAfter?: string, createdBefore?: string): Promise<TaskStats> =>
    ipcRenderer.invoke(IPC_CHANNELS.taskStats, createdAfter, createdBefore),

  onTaskChanged: (listener: (task: TaskRecord) => void): (() => void) => {
    const handler = (_event: unknown, task: TaskRecord): void => listener(task)
    ipcRenderer.on(IPC_CHANNELS.evtTaskChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.evtTaskChanged, handler)
    }
  },

  onRunEvent: (listener: (payload: RunEventPush) => void): (() => void) => {
    const handler = (_event: unknown, payload: RunEventPush): void => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.evtRunEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.evtRunEvent, handler)
    }
  },

  onPlanChanged: (listener: (plan: PlanRecord) => void): (() => void) => {
    const handler = (_event: unknown, plan: PlanRecord): void => listener(plan)
    ipcRenderer.on(IPC_CHANNELS.evtPlanChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.evtPlanChanged, handler)
    }
  }
}

contextBridge.exposeInMainWorld('workbench', api)
