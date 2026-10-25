import type {
  AgentDescriptor,
  AgentRunEvent,
  AppSettings,
  CancelResult,
  Conversation,
  CreateTaskInput,
  CreateTemplateInput,
  GuardrailItem,
  Message,
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
  taskHandoffResult: 'workbench:tasks:handoff-result',
  runsList: 'workbench:runs:list',
  settingsGet: 'workbench:settings:get',
  settingsUpdate: 'workbench:settings:update',
  systemInfo: 'workbench:system:info',
  planCreate: 'workbench:plans:create',
  planConfirm: 'workbench:plans:confirm',
  planRunTask: 'workbench:plans:run-task',
  planList: 'workbench:plans:list',
  planGet: 'workbench:plans:get',
  templateList: 'workbench:templates:list',
  templateCreate: 'workbench:templates:create',
  templateUpdate: 'workbench:templates:update',
  templateDelete: 'workbench:templates:delete',
  batchCancelTasks: 'workbench:tasks:batch-cancel',
  batchDeleteTasks: 'workbench:tasks:batch-delete',
  taskStats: 'workbench:stats:task-stats',
  skillList: 'workbench:skills:list',
  skillExecute: 'workbench:skills:execute',
  conversationCreate: 'workbench:conversations:create',
  conversationList: 'workbench:conversations:list',
  conversationGet: 'workbench:conversations:get',
  conversationDelete: 'workbench:conversations:delete',
  messageList: 'workbench:messages:list',
  messageSend: 'workbench:messages:send',
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
  /** 人工回填 handoff 任务执行结果（needs_confirmation → succeeded / failed）。 */
  submitHandoffResult(taskId: string, resultText: string, succeeded: boolean): Promise<TaskRecord>

  listRuns(limit?: number): Promise<RunRecord[]>

  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getSystemInfo(): Promise<SystemInfo>

  /** 主管计划：创建计划草稿（预览，不执行）。plannerId 缺省为 mock-planner。 */
  planCreate(goal: string, plannerId?: string): Promise<PlanWithTasks>
  /** 主管计划：用户确认后启动 Mock 执行。 */
  planConfirm(planId: string): Promise<PlanRecord>
  /** 主管计划：逐任务授权执行单个子任务（真实来源计划的唯一执行入口）。 */
  planRunTask(planId: string, taskId: string, realCallConfirmed: boolean): Promise<TaskRecord>
  /** 主管计划：列出历史计划。 */
  planList(filter?: PlanFilter): Promise<PlanRecord[]>
  /** 主管计划：获取计划 + 子任务详情。 */
  planGet(planId: string): Promise<PlanWithTasks | null>

  /** 任务模板：列出全部模板（可按 Agent 筛选）。 */
  listTemplates(agentId?: string): Promise<TaskTemplate[]>
  /** 任务模板：创建用户模板。 */
  createTemplate(input: CreateTemplateInput): Promise<TaskTemplate>
  /** 任务模板：更新模板（内置模板不可改）。 */
  updateTemplate(input: UpdateTemplateInput): Promise<TaskTemplate>
  /** 任务模板：删除用户模板（内置模板不可删）。 */
  deleteTemplate(id: string): Promise<void>

  /** 批量取消任务（仅 running 状态有效）。 */
  batchCancelTasks(taskIds: string[]): Promise<Array<{ taskId: string; accepted: boolean; message: string }>>
  /** 批量删除任务（仅非 running 状态有效）。 */
  batchDeleteTasks(taskIds: string[]): Promise<Array<{ taskId: string; deleted: boolean; message: string }>>

  /** 获取任务统计信息。 */
  getTaskStats(createdAfter?: string, createdBefore?: string): Promise<TaskStats>

  /** 列出所有可用技能。 */
  listSkills(): Promise<
    Array<{
      id: string
      name: string
      description: string
      category: string
      params: Array<{ name: string; type: string; description: string; required: boolean; default?: string }>
    }>
  >
  /** 执行技能。 */
  executeSkill(skillId: string, params: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }>

  /** 创建对话。 */
  createConversation(title?: string): Promise<Conversation>
  /** 列出所有对话。 */
  listConversations(): Promise<Conversation[]>
  /** 获取对话详情。 */
  getConversation(id: string): Promise<Conversation | null>
  /** 删除对话。 */
  deleteConversation(id: string): Promise<void>
  /** 列出对话的所有消息。 */
  listMessages(conversationId: string): Promise<Message[]>
  /** 发送消息。 */
  sendMessage(conversationId: string, content: string): Promise<Message[]>

  /** 返回取消订阅函数。 */
  onTaskChanged(listener: (task: TaskRecord) => void): () => void
  onRunEvent(listener: (payload: RunEventPush) => void): () => void
  onPlanChanged(listener: (plan: PlanRecord) => void): () => void
}
