import type {
  AgentDescriptor,
  AgentRunEvent,
  AppSettings,
  CancelResult,
  CreateTaskInput,
  GuardrailItem,
  Overview,
  PlanFilter,
  PlanRecord,
  PlanWithTasks,
  RunRecord,
  SystemInfo,
  TaskFilter,
  TaskRecord
} from './types'

/**
 * 主进程 ↔ 渲染层 的唯一通信契约。
 *
 * 渲染层不直接拥有 Node 权限，所有能力都必须经过这里登记的通道。
 */
export const IPC_CHANNELS = {
  overview: 'workbench:overview',
  agentsList: 'workbench:agents:list',
  agentCheck: 'workbench:agents:check',
  guardrails: 'workbench:guardrails',
  tasksList: 'workbench:tasks:list',
  taskCreate: 'workbench:tasks:create',
  taskGet: 'workbench:tasks:get',
  taskEvents: 'workbench:tasks:events',
  taskRun: 'workbench:tasks:run',
  taskCancel: 'workbench:tasks:cancel',
  runsList: 'workbench:runs:list',
  settingsGet: 'workbench:settings:get',
  settingsUpdate: 'workbench:settings:update',
  systemInfo: 'workbench:system:info',
  planCreate: 'workbench:plans:create',
  planConfirm: 'workbench:plans:confirm',
  planList: 'workbench:plans:list',
  planGet: 'workbench:plans:get',
  evtTaskChanged: 'workbench:event:task-changed',
  evtRunEvent: 'workbench:event:run-event',
  evtPlanChanged: 'workbench:event:plan-changed'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

export interface RunEventPush {
  taskId: string
  event: AgentRunEvent
}

export interface WorkbenchApi {
  getOverview(): Promise<Overview>
  listAgents(): Promise<AgentDescriptor[]>
  checkAgent(agentId: string): Promise<AgentDescriptor>
  getGuardrails(): Promise<GuardrailItem[]>

  listTasks(filter?: TaskFilter): Promise<TaskRecord[]>
  createTask(input: CreateTaskInput): Promise<TaskRecord>
  getTask(id: string): Promise<TaskRecord | null>
  getTaskEvents(id: string, limit?: number): Promise<AgentRunEvent[]>
  runTask(id: string, realCallConfirmed: boolean): Promise<TaskRecord>
  cancelTask(id: string): Promise<CancelResult>

  listRuns(limit?: number): Promise<RunRecord[]>

  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getSystemInfo(): Promise<SystemInfo>

  /** 主管计划：创建 Mock 计划草稿（预览，不执行）。 */
  planCreate(goal: string): Promise<PlanWithTasks>
  /** 主管计划：用户确认后启动 Mock 执行。 */
  planConfirm(planId: string): Promise<PlanRecord>
  /** 主管计划：列出历史计划。 */
  planList(filter?: PlanFilter): Promise<PlanRecord[]>
  /** 主管计划：获取计划 + 子任务详情。 */
  planGet(planId: string): Promise<PlanWithTasks | null>

  /** 返回取消订阅函数。 */
  onTaskChanged(listener: (task: TaskRecord) => void): () => void
  onRunEvent(listener: (payload: RunEventPush) => void): () => void
  onPlanChanged(listener: (plan: PlanRecord) => void): () => void
}
