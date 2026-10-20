import { TERMINAL_STATUSES, type TaskStatus } from './types'

/**
 * 任务状态机。
 *
 * 设计目标（对应第 3 步要求「明确每个状态的合法转换，避免重复执行、状态倒退
 * 或任务同时处于多个终态」）：
 *
 * - 单一状态列 → 同一任务不可能同时处于多个终态；
 * - 终态无出边 → 不可能从终态倒退回 running（也就不会重复执行）；
 * - `pending → running` 是唯一的执行入口 → 拒绝重复提交同一次执行。
 *
 * `needs_confirmation` 在本阶段按终态处理：任务进入该状态后不会自动继续，
 * 必须在后续阶段引入「人工批准」入口后才允许重新执行。
 */
export const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['running', 'cancelled', 'failed'],
  running: ['succeeded', 'failed', 'timed_out', 'cancelled', 'needs_confirmation'],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  needs_confirmation: []
}

export class IllegalTransitionError extends Error {
  readonly from: TaskStatus
  readonly to: TaskStatus

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`非法的任务状态转换：${from} → ${to}。${describeTransition(from, to)}`)
    this.name = 'IllegalTransitionError'
    this.from = from
    this.to = to
  }
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/** 非法转换时给出可诊断的原因，而不是只抛一句「不允许」。 */
export function describeTransition(from: TaskStatus, to: TaskStatus): string {
  if (from === to) {
    return `任务已经是 ${from}，无需再次转换（可能是重复执行请求）。`
  }
  if (isTerminalStatus(from)) {
    return `${from} 是终态，不允许再转换为 ${to}（终态不可倒退，可避免重复执行）。`
  }
  const allowed = ALLOWED_TRANSITIONS[from]
  return `${from} 只允许转换为：${allowed.length > 0 ? allowed.join(' / ') : '（无）'}。`
}

/** 校验并返回目标状态；非法则抛 IllegalTransitionError。 */
export function assertTransition(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to)
  }
  return to
}

/** 执行入口守卫：只有 pending 的任务可以被启动。 */
export function canStart(status: TaskStatus): boolean {
  return status === 'pending'
}

export function explainCannotStart(status: TaskStatus): string {
  if (status === 'pending') return '可以执行。'
  if (status === 'running') return '该任务已经在执行中，已忽略本次重复执行请求。'
  return `任务当前为 ${status}（终态），不再允许执行；如需重新执行请新建任务。`
}
