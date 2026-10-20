/**
 * 主进程 / preload / 渲染层 / 适配器 共用的类型契约。
 *
 * 两条不可违反的规则，来自第 2 / 2.5 步的实测结论：
 *
 * 1) token 用量可以信任 —— 它来自 DSH NDJSON 的 `step_end.usage`（已实测成功）；
 *    但**金额无法核验** —— headless 调用不会写入 `~/.dsh/.dshw-usage.json`，
 *    因此 `actualCost` 必须允许为 null，**绝不能用 0 冒充**，也绝不能用历史单价
 *    推算出来的数字冒充真实账单。未知就是未知。
 *
 * 2) 本地进程被终止 **不等于** 远端请求已停止。任何超时 / 取消路径都必须
 *    在数据层保留这个不确定性，而不是直接判定为「已停止」。
 */

/** 统一任务状态。同一任务在任意时刻只能处于其中一个状态。 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'needs_confirmation'

export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'needs_confirmation'
]

/** 终态：进入后不再自动流转（`needs_confirmation` 在本阶段也按终态处理）。 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'needs_confirmation'
]

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '待执行',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  timed_out: '超时',
  cancelled: '已取消',
  needs_confirmation: '待人工确认'
}

/** 统一事件类型（DSH NDJSON 的原始类型会被映射到这里，未知类型落到 unknown）。 */
export type AgentRunEventType =
  | 'session'
  | 'status'
  | 'thinking'
  | 'text'
  | 'final'
  | 'usage'
  | 'error'
  | 'unknown'

export type AgentEventPayload = Record<string, unknown>

/** 适配器上报的、尚未分配序号的事件。 */
export interface AgentRunEventDraft {
  type: AgentRunEventType
  /** 供应商原始 type（便于排查），例如 DSH 的 `status` / `step_end`。 */
  rawType: string
  payload: AgentEventPayload
  receivedAt: string
}

/** 落库后的事件（追加了单调递增的 seq）。 */
export interface AgentRunEvent extends AgentRunEventDraft {
  seq: number
}

export type Capability = 'submit' | 'result' | 'status' | 'cancel' | 'cost'
export const CAPABILITIES: readonly Capability[] = ['submit', 'result', 'status', 'cancel', 'cost']
export const CAPABILITY_LABEL: Record<Capability, string> = {
  submit: '提交任务',
  result: '获取结果',
  status: '状态查询',
  cancel: '取消',
  cost: '成本统计'
}

export type CapabilityState = 'verified' | 'unverified' | 'unsupported'

export const CAPABILITY_STATE_LABEL: Record<CapabilityState, string> = {
  verified: '已验证',
  unverified: '未验证',
  unsupported: '不支持'
}

/** auto = 程序可自动执行；handoff = 只能人工交接；unavailable = 暂不可用。 */
export type AgentMode = 'auto' | 'handoff' | 'unavailable'

export const AGENT_MODE_LABEL: Record<AgentMode, string> = {
  auto: '可自动执行',
  handoff: '需人工交接',
  unavailable: '暂不可用'
}

export type AvailabilityState = 'available' | 'unavailable' | 'unknown'

export const AVAILABILITY_LABEL: Record<AvailabilityState, string> = {
  available: '可用',
  unavailable: '不可用',
  unknown: '未检测'
}

export interface AgentDescriptor {
  id: string
  name: string
  adapterId: string
  mode: AgentMode
  /** true = 会真实调用外部模型（可能产生费用）。 */
  isRealCall: boolean
  description: string
  capabilities: Record<Capability, CapabilityState>
  availability: AvailabilityState
  availabilityDetail: string
  version: string | null
  checkedAt: string | null
  /** 接入说明 / 已知限制，面向用户展示。 */
  configNote: string
}

/**
 * 统一用量结构。
 *
 * - tokens：来自 NDJSON，可信；读不到时为 null。
 * - actualCost：可核验的真实费用。当前 DSH headless 无法核验 → 恒为 null。
 * - estimatedCost：估算费用。**在没有可靠单价来源时保持 null**，不自行编造。
 * - source：金额来源；无法核验时为 'unknown'（即使 token 已经读到）。
 * - verified：**仅表示金额是否已核验**，与 token 是否读到无关。
 */
export interface UsageRecord {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  actualCost: number | null
  estimatedCost: number | null
  currency: string
  source: 'ndjson' | 'ledger' | 'unknown'
  verified: boolean
  recordedAt: string
  note: string
}

/** 金额是否可核验 —— 当前所有真实调用都是 false。 */
export const COST_VERIFIABLE_WITH_CURRENT_ADAPTERS = false

/** 面向用户的费用口径说明（界面与文档统一使用同一句）。 */
export const COST_UNVERIFIED_TEXT = '无法核验'
export const COST_UNVERIFIED_DETAIL =
  'DSH headless 调用不会写入 ~/.dsh/.dshw-usage.json，本地账本差值恒为 0，' +
  '因此本次真实费用无法核验。token 用量可信，但金额不作为账单。'

/** 本阶段硬编码关闭：不自动重试（避免重复计费）。 */
export const AUTO_RETRY_ENABLED = false

/** 本地进程终止后的统一告警（不得声称远端已停止）。 */
export const REMOTE_NOT_STOPPED_WARNING =
  '本地子进程已被终止，但 DSH 没有 cancel 接口：远端请求可能仍在运行，并可能继续产生费用。'

export interface TaskRecord {
  id: string
  title: string
  prompt: string
  agentId: string
  adapterId: string
  isRealCall: boolean
  status: TaskStatus
  createdAt: string
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  exitCode: number | null
  sessionId: string | null
  /** 会话目录（尽力定位；未找到为 null）。只记录，不自动删除。 */
  sessionDir: string | null
  finalText: string | null
  errorCode: string | null
  errorMessage: string | null
  failureKind: FailureKind | null
  usage: UsageRecord | null
  cwd: string | null
  /** 尝试次数。本阶段无自动重试，恒为 1。 */
  attempt: number
  /** 需要显式提醒用户的内容（例如「远端可能未停止」「本次未发生真实调用」）。 */
  userNotice: string | null
  /** 所属总任务（主管计划）ID；普通单任务为 null。 */
  planId: string | null
  /** 在计划内的顺序（稳定，从 1 开始）。 */
  planSeq: number | null
  /** 主管计划里的子任务类型；普通单任务为 null。 */
  taskKind: SubTaskKind | null
  /** 依赖的同计划子任务 ID 列表（全部成功后才可执行）。 */
  dependsOn: string[]
  /** 验收标准（计划预览时展示给用户）。 */
  acceptance: string | null
  /** 因依赖失败被阻断时的原因说明。 */
  blockedReason: string | null
}

/** 主管计划中的子任务类型（第 4 步·阶段 1 的 Mock Planner 只产出这四种）。 */
export type SubTaskKind = 'research' | 'analysis' | 'writing' | 'review'

export const SUB_TASK_KINDS: readonly SubTaskKind[] = ['research', 'analysis', 'writing', 'review']

export const SUB_TASK_KIND_LABEL: Record<SubTaskKind, string> = {
  research: '资料收集',
  analysis: '分析',
  writing: '成文',
  review: '审校'
}

/** 总任务（主管计划）状态。 */
export type PlanStatus = 'draft' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

export const PLAN_STATUSES: readonly PlanStatus[] = [
  'draft',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled'
]

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  draft: '待确认（预览）',
  running: '执行中',
  succeeded: '全部成功',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消'
}

/** 总任务完成判定：全部子任务成功才算成功；有成功也有失败/阻断 → 部分完成；零成功 → 失败。 */
export type PlanConclusion = 'all_succeeded' | 'partial' | 'all_blocked_or_failed'

/** 计划汇总报告中的单个子任务摘要。 */
export interface PlanTaskSummary {
  taskId: string
  seq: number
  kind: SubTaskKind
  title: string
  agentId: string
  status: TaskStatus
  /** 成功时取 finalText 的截断摘要；失败/阻断时为 null。 */
  outputExcerpt: string | null
  errorCode: string | null
  errorMessage: string | null
  blockedReason: string | null
}

/** 总任务汇总报告（落库在 plans.summary_json）。 */
export interface PlanSummary {
  conclusion: PlanConclusion
  totalCount: number
  succeededCount: number
  failedCount: number
  blockedCount: number
  /** 面向用户的结论文字（明确标注 Mock 演示）。 */
  report: string
  perTask: PlanTaskSummary[]
  generatedAt: string
}

/** 总任务（主管 Agent 生成的一份计划）。 */
export interface PlanRecord {
  id: string
  title: string
  /** 用户输入的总目标。 */
  goal: string
  status: PlanStatus
  /** 规划器标识；本阶段恒为 mock-planner（确定性、不使用大模型）。 */
  planner: string
  createdAt: string
  /** 用户点击「确认执行」的时间；null = 仅预览，不会被执行。 */
  confirmedAt: string | null
  startedAt: string | null
  endedAt: string | null
  summary: PlanSummary | null
  /** 计划级阻断/失败原因（例如启动恢复、无任务可推进）。 */
  blockedReason: string | null
  taskCount: number
}

/** Planner 输出的子任务草稿（落库前，尚未分配 taskId 之外的信息）。 */
export interface PlannedSubTask {
  seq: number
  kind: SubTaskKind
  title: string
  description: string
  /** 传给执行 Adapter 的 prompt。 */
  prompt: string
  inputSpec: string
  outputSpec: string
  acceptance: string
  agentId: string
  /** 依赖的兄弟子任务 seq（同一计划内）。 */
  dependsOnSeq: number[]
}

export interface PlanDraft {
  title: string
  goal: string
  planner: string
  subtasks: PlannedSubTask[]
}

/** 计划 + 其子任务（预览 / 详情接口返回）。 */
export interface PlanWithTasks {
  plan: PlanRecord
  tasks: TaskRecord[]
}

/** 计划列表过滤。 */
export interface PlanFilter {
  status?: PlanStatus | 'all'
  limit?: number
}

/** 子任务因依赖失败被调度器阻断时使用的错误码（状态机走 pending → failed）。 */
export const BLOCKED_BY_DEPENDENCY_CODE = 'BLOCKED_BY_DEPENDENCY'

/** 主管计划 Mock 链路的统一标识文案（界面必须与之一致）。 */
export const MOCK_PLAN_BADGE = 'Mock 演示结果'
export const MOCK_PLAN_DISCLAIMER =
  '本计划由确定性的 Mock Planner 生成（不调用任何大模型），子任务由 Mock 适配器本地模拟执行，' +
  '不代表真实研究、真实模型推理或外部事实。'

export type FailureKind =
  | 'spawn_failed'
  | 'nonzero_exit'
  | 'invalid_output'
  | 'missing_final'
  | 'turn_error'
  | 'timeout'
  | 'cancelled'
  | 'refused'
  | 'internal_error'

export const FAILURE_KIND_LABEL: Record<FailureKind, string> = {
  spawn_failed: '无法启动子进程',
  nonzero_exit: '非零退出码',
  invalid_output: '输出不是有效 NDJSON',
  missing_final: '缺少最终结果',
  turn_error: 'Agent 内部报错',
  timeout: '超时',
  cancelled: '已取消',
  refused: '被安全护栏拦截',
  internal_error: '工作台内部错误'
}

export interface RunRecord {
  id: string
  taskId: string
  agentId: string
  adapterId: string
  attemptNo: number
  isRealCall: boolean
  exitCode: number | null
  durationMs: number
  stdoutBytes: number
  stdoutLineCount: number
  invalidLineCount: number
  stderrExcerpt: string
  failureKind: FailureKind | null
  startedAt: string
  endedAt: string
}

export interface CreateTaskInput {
  title: string
  prompt: string
  agentId: string
}

export interface TaskFilter {
  status?: TaskStatus | 'all'
  agentId?: string
  limit?: number
}

export interface Overview {
  total: number
  pending: number
  running: number
  succeeded: number
  failed: number
  timedOut: number
  cancelled: number
  needsConfirmation: number
  realRunCount: number
  /** 已知 token 合计（可读到的部分）。 */
  knownTokensTotal: number
  /** 已核验金额合计（当前恒为 0，因为没有一项被核验）。 */
  verifiedCostTotal: number
  /** 估算金额合计（当前恒为 0，因为没有可靠单价来源）。 */
  estimatedCostTotal: number
  /** 金额无法核验的任务数。 */
  costUnverifiedTaskCount: number
  lastActivityAt: string | null
}

/** 系统信息（设置页展示，避免渲染层直接读文件系统）。 */
export interface SystemInfo {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
  platform: string
  userDataDir: string
  database: {
    filePath: string
    /** 'file' = 正常持久化；'memory-fallback' = 文件库不可用，已降级为内存库。 */
    mode: 'file' | 'memory-fallback'
    detail: string
    schemaVersion: number
  }
  logDir: string
  sessionNote: string
}

export type RunTrigger = 'mock' | 'real-confirmed'

/**
 * 应用设置。刻意保持不依赖 electron，便于主进程与渲染层共用同一份类型。
 */
export interface AppSettings {
  /** DSH 可执行文件（注册表里的旧路径已失效，实际在 E:\gsh）。 */
  dshExePath: string
  /** asar 内的 CLI 入口脚本。 */
  dshCliScript: string
  dshProfile: string
  dshHomeDir: string
  /** 任务工作目录（决定 DSH 会话落盘位置）。 */
  taskCwd: string
  taskTimeoutMs: number
  /** 真实任务并发上限。默认 1（第 3 步硬性要求）。 */
  realConcurrencyLimit: number
  /** Mock 任务并发上限（Mock 不产生费用，可以稍宽）。 */
  mockConcurrencyLimit: number
  /**
   * 真实模型调用总开关。默认 **false**：
   * 应用启动、Mock 流程、任何非显式操作都不会触发真实调用。
   */
  allowRealModelCalls: boolean
}

/** 界面展示用的护栏摘要条目。 */
export interface GuardrailItem {
  label: string
  value: string
  detail: string
}

/** 取消操作的结果（必须把「远端可能未停止」原样带给用户）。 */
export interface CancelResult {
  accepted: boolean
  message: string
}
