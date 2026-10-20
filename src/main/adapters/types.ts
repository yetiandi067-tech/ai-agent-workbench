import type {
  AgentDescriptor,
  AgentRunEventDraft,
  Capability,
  CapabilityState,
  FailureKind,
  TaskStatus,
  UsageRecord
} from '../../shared/types'

/** 超时中止的标记（放在 AbortSignal.reason 里，避免用异常类型区分）。 */
export const TIMEOUT_REASON = 'workbench:timeout' as const
export const CANCEL_REASON = 'workbench:cancel' as const

export type AbortReason = typeof TIMEOUT_REASON | typeof CANCEL_REASON

export interface RunInput {
  taskId: string
  runId: string
  prompt: string
  /** 任务工作目录（决定 DSH 会话落盘位置，只记录不删除）。 */
  cwd: string
  /** 参考用；真正的超时由调度器统一用 AbortSignal 触发。 */
  timeoutMs: number
}

/** 适配器诊断信息 —— 一律先脱敏再落库。 */
export interface AdapterDiagnostics {
  stdoutBytes: number
  stdoutLineCount: number
  invalidLineCount: number
  /** 已脱敏、已截断的 stderr 摘要。 */
  stderrExcerpt: string
  exitCode: number | null
  spawnErrorCode: string | null
}

export interface RunHooks {
  /** 每产生一个事件回调一次（含流式 text）。 */
  onEvent: (event: AgentRunEventDraft) => void
  /** 调度器用它触发超时 / 取消。适配器必须响应它并清理自己的子进程。 */
  signal: AbortSignal
}

export interface RunOutcome {
  status: TaskStatus
  sessionId: string | null
  sessionDir: string | null
  finalText: string | null
  exitCode: number | null
  errorCode: string | null
  errorMessage: string | null
  failureKind: FailureKind | null
  durationMs: number
  /** 金额恒为无法核验（见 shared/types.ts 的说明）。 */
  usage: UsageRecord | null
  diagnostics: AdapterDiagnostics
  /** 需要显式提示给用户的内容（例如「远端可能未停止」）。 */
  userNotice: string | null
}

/**
 * 统一 Agent 适配器接口。
 *
 * 约定：
 * - `isRealCall === true` 的适配器在真实执行前必须由调度器获得用户显式确认；
 *   适配器自身再做一次「允许」校验（纵深防御），不允许时直接拒绝且不启动子进程。
 * - `getUsage()` 只返回**执行期观测到的**用量；工作台不替适配器编造金额。
 */
export interface AgentAdapter {
  readonly id: string
  readonly name: string
  readonly mode: AgentDescriptor['mode']
  readonly isRealCall: boolean
  capabilities(): Record<Capability, CapabilityState>
  describe(): AgentDescriptor
  /** 只读探活。实现方必须保证这一步**不提交模型任务**。 */
  checkAvailability(): Promise<AgentDescriptor>
  run(input: RunInput, hooks: RunHooks): Promise<RunOutcome>
  getUsage(runId: string): UsageRecord | null
}

/** 空诊断的默认值，便于测试与失败分支复用。 */
export function emptyDiagnostics(overrides: Partial<AdapterDiagnostics> = {}): AdapterDiagnostics {
  return {
    stdoutBytes: 0,
    stdoutLineCount: 0,
    invalidLineCount: 0,
    stderrExcerpt: '',
    exitCode: null,
    spawnErrorCode: null,
    ...overrides
  }
}
