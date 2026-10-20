import { randomUUID } from 'node:crypto'

import { redactAndTruncate } from '../../shared/redact'
import {
  AUTO_RETRY_ENABLED,
  type AgentRunEvent,
  type AgentRunEventDraft,
  type RunRecord,
  type TaskRecord,
  type TaskStatus
} from '../../shared/types'
import { assertTransition, canStart, explainCannotStart } from '../../shared/task-state'
import type { Repositories } from '../db/repositories'
import type { Logger } from '../logger'
import type { AppSettings } from '../settings'
import type { AdapterRegistry } from '../adapters/registry'
import { CANCEL_REASON, TIMEOUT_REASON, emptyDiagnostics } from '../adapters/types'
import { ConcurrencyGate } from './concurrency'

export interface RunTaskOptions {
  /** 是否已由用户在界面上显式确认「本次会产生真实调用」。默认 false。 */
  realCallConfirmed: boolean
}

export interface TaskRunnerDeps {
  repos: Repositories
  registry: AdapterRegistry
  getSettings: () => AppSettings
  logger: Logger
  /** 任务状态 / 结果变化时回调（用于推送到渲染层）。 */
  onTaskChanged: (task: TaskRecord) => void
  /** 增量事件回调（流式展示用）。 */
  onRunEvent: (taskId: string, event: AgentRunEvent) => void
}

/**
 * 任务调度与状态机执行器。
 *
 * 不可违反的规则：
 * - **不自动重试**：`attempt` 恒为 1，代码里没有任何重试循环。失败就是终态。
 * - **不重复执行**：只有 `pending` 任务能被启动；终态任务直接拒绝。
 * - **真实调用需要显式确认**：除「界面上的显式操作 + 全局开关打开」外，
 *   任何路径（含应用启动、Mock 流程）都不会触发真实模型调用。
 * - **不谎报远端状态**：超时 / 取消只终止本地进程，并把「远端可能未停止」写进任务记录。
 */
export class TaskRunner {
  private readonly realGate: ConcurrencyGate
  private readonly mockGate: ConcurrencyGate
  private readonly activeControllers = new Map<string, AbortController>()

  constructor(private readonly deps: TaskRunnerDeps) {
    this.realGate = new ConcurrencyGate(() => this.deps.getSettings().realConcurrencyLimit)
    this.mockGate = new ConcurrencyGate(() => this.deps.getSettings().mockConcurrencyLimit)
  }

  get runningCount(): number {
    return this.activeControllers.size
  }

  get activeTaskIds(): string[] {
    return [...this.activeControllers.keys()]
  }

  /** 取消：只发出中止信号，真正的判定交给适配器。 */
  cancelTask(taskId: string): boolean {
    const controller = this.activeControllers.get(taskId)
    if (!controller) return false
    controller.abort(CANCEL_REASON)
    return true
  }

  async runTask(taskId: string, options: RunTaskOptions): Promise<TaskRecord> {
    const { repos, logger } = this.deps

    const task = repos.tasks.get(taskId)
    if (!task) throw new Error(`任务不存在：${taskId}`)

    // 1) 环境与授权检查 —— 不通过就完全不启动任何子进程
    const adapter = this.deps.registry.get(task.agentId)
    if (!adapter) {
      return this.rejectWithoutRunning(task, 'NO_ADAPTER', `Agent「${task.agentId}」在本阶段没有可执行的适配器（只有人工交接说明），已拒绝执行。`)
    }

    const settings = this.deps.getSettings()
    if (adapter.isRealCall && !settings.allowRealModelCalls) {
      return this.rejectWithoutRunning(
        task,
        'REAL_CALLS_DISABLED',
        '真实模型调用总开关当前为关闭状态（设置页可开启）。为避免意外消耗额度，本次未启动执行。'
      )
    }
    if (adapter.isRealCall && !options.realCallConfirmed) {
      return this.rejectWithoutRunning(
        task,
        'REAL_CALL_NOT_CONFIRMED',
        '这是一个真实调用任务，必须由用户在界面上显式确认后才会执行。本次未启动执行。'
      )
    }

    // 2) 状态机守卫 —— 避免重复执行
    if (!canStart(task.status)) {
      logger.warn('忽略重复执行请求', { taskId, status: task.status })
      return this.rejectWithoutRunning(task, 'NOT_PENDING', explainCannotStart(task.status))
    }

    // 3) 并发闸门
    const gate = adapter.isRealCall ? this.realGate : this.mockGate
    if (!gate.acquire()) {
      return this.rejectWithoutRunning(
        task,
        'CONCURRENCY_LIMIT',
        `${adapter.isRealCall ? '真实' : 'Mock'}任务并发已达上限（${gate.limit}），本次未启动。` +
          '为避免在用户不知情的情况下排队后自动产生费用，这里不会自动排队，请稍后手动再次执行。'
      )
    }

    const runId = randomUUID()
    const controller = new AbortController()
    this.activeControllers.set(task.id, controller)

    let seq = 0
    const emit = (draft: AgentRunEventDraft, runIdForEvent: string = runId): void => {
      seq += 1
      repos.events.append(task.id, runIdForEvent, draft, seq)
      const event: AgentRunEvent = { ...draft, seq }
      this.deps.onRunEvent(task.id, event)
    }

    const startedAt = new Date().toISOString()
    const startedMs = Date.now()

    // 4) 先写事件、再改状态（崩溃后仍可从事件回放出「曾经要执行」）
    emit({
      type: 'status',
      rawType: 'workbench.task_status',
      payload: { phase: 'task_status', status: 'running', taskId: task.id, runId },
      receivedAt: startedAt
    })

    const running: TaskRecord = {
      ...task,
      status: 'running',
      startedAt,
      endedAt: null,
      durationMs: null,
      exitCode: null,
      sessionId: null,
      sessionDir: null,
      finalText: null,
      errorCode: null,
      errorMessage: null,
      failureKind: null,
      usage: null,
      cwd: settings.taskCwd,
      attempt: 1,
      userNotice: adapter.isRealCall
        ? '这是一次真实模型调用：本地可确认 token 用量，但**金额无法核验**。'
        : '这是一次本地模拟（Mock）执行，未调用任何外部模型。'
    }
    repos.tasks.update(running)
    this.deps.onTaskChanged(running)

    // 5) 超时：由调度器统一用 AbortSignal 触发（适配器负责终止自己的子进程）
    const timeoutMs = settings.taskTimeoutMs
    const timer = setTimeout(() => {
      controller.abort(TIMEOUT_REASON)
    }, timeoutMs)

    try {
      const outcome = await adapter.run(
        {
          taskId: task.id,
          runId,
          prompt: task.prompt,
          cwd: settings.taskCwd,
          timeoutMs
        },
        { onEvent: (draft) => emit(draft), signal: controller.signal }
      )

      // 6) 状态转换走状态机（running → 终态），非法转换直接抛错而不是静默写库
      const nextStatus: TaskStatus = assertTransition('running', outcome.status)

      const endedAt = new Date().toISOString()
      const finished: TaskRecord = {
        ...running,
        status: nextStatus,
        endedAt,
        durationMs: outcome.durationMs,
        exitCode: outcome.exitCode,
        sessionId: outcome.sessionId,
        sessionDir: outcome.sessionDir,
        finalText: outcome.finalText,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        failureKind: outcome.failureKind,
        usage: outcome.usage,
        userNotice: outcome.userNotice ?? running.userNotice
      }

      repos.tasks.update(finished)

      emit(
        {
          type: 'status',
          rawType: 'workbench.task_status',
          payload: {
            phase: 'task_status',
            status: nextStatus,
            failureKind: outcome.failureKind,
            errorCode: outcome.errorCode
          },
          receivedAt: endedAt
        },
        runId
      )

      const run: RunRecord = {
        id: runId,
        taskId: task.id,
        agentId: adapter.id,
        adapterId: adapter.id,
        attemptNo: 1,
        isRealCall: adapter.isRealCall,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        stdoutBytes: outcome.diagnostics.stdoutBytes,
        stdoutLineCount: outcome.diagnostics.stdoutLineCount,
        invalidLineCount: outcome.diagnostics.invalidLineCount,
        stderrExcerpt: outcome.diagnostics.stderrExcerpt,
        failureKind: outcome.failureKind,
        startedAt,
        endedAt
      }
      repos.runs.create(run)

      logger.info('任务执行结束', {
        taskId: task.id,
        adapter: adapter.id,
        status: nextStatus,
        failureKind: outcome.failureKind,
        durationMs: outcome.durationMs,
        exitCode: outcome.exitCode,
        totalTokens: outcome.usage?.totalTokens ?? null,
        costVerified: outcome.usage?.verified ?? false
      })

      this.deps.onTaskChanged(finished)
      return finished
    } catch (error) {
      // 适配器自身抛错（不应发生，但必须有明确失败分支）
      const endedAt = new Date().toISOString()
      const durationMs = Date.now() - startedMs
      const failed: TaskRecord = {
        ...running,
        status: 'failed',
        endedAt,
        durationMs,
        errorCode: 'INTERNAL_ERROR',
        errorMessage: redactAndTruncate(
          error instanceof Error ? error.message : String(error),
          800
        ),
        failureKind: 'internal_error',
        usage: null,
        userNotice: '工作台内部错误，任务未能完成。'
      }
      repos.tasks.update(failed)
      repos.runs.create({
        id: runId,
        taskId: task.id,
        agentId: adapter.id,
        adapterId: adapter.id,
        attemptNo: 1,
        isRealCall: adapter.isRealCall,
        exitCode: null,
        durationMs,
        stdoutBytes: 0,
        stdoutLineCount: 0,
        invalidLineCount: 0,
        stderrExcerpt: redactAndTruncate(failed.errorMessage ?? '', 1000),
        failureKind: 'internal_error',
        startedAt,
        endedAt
      })
      emit(
        {
          type: 'error',
          rawType: 'workbench.internal_error',
          payload: { phase: 'internal_error', message: failed.errorMessage },
          receivedAt: endedAt
        },
        runId
      )
      logger.error('任务执行抛出内部错误', { taskId: task.id, error: failed.errorMessage })
      this.deps.onTaskChanged(failed)
      return failed
    } finally {
      clearTimeout(timer)
      this.activeControllers.delete(task.id)
      gate.release()
    }
  }

  /** 被护栏拦截时：任务保持原状态，只记录原因（不伪造失败，也不静默吞掉）。 */
  private rejectWithoutRunning(task: TaskRecord, code: string, message: string): TaskRecord {
    const now = new Date().toISOString()
    const blocked: TaskRecord = {
      ...task,
      errorCode: code,
      errorMessage: message,
      userNotice: message
    }
    this.deps.repos.tasks.update(blocked)
    try {
      // 记录到事件流：便于事后审计「为什么这次没有执行」
      this.deps.repos.events.append(
        task.id,
        'no-run',
        {
          type: 'error',
          rawType: 'workbench.blocked',
          payload: { phase: 'blocked', code, message, autoRetryEnabled: AUTO_RETRY_ENABLED },
          receivedAt: now
        },
        this.deps.repos.events.countByTask(task.id) + 1
      )
    } catch {
      // 事件写入失败不影响主流程
    }
    this.deps.logger.warn('任务被护栏拦截，未启动', { taskId: task.id, code })
    this.deps.onTaskChanged(blocked)
    return blocked
  }

  /** 供界面展示：当前是否有真实任务在跑。 */
  stats(): { activeTasks: number; realActive: number; realLimit: number } {
    return {
      activeTasks: this.activeControllers.size,
      realActive: this.realGate.activeCount,
      realLimit: this.realGate.limit
    }
  }

  /** 失败分支兜底用的空诊断（导出以便测试复用）。 */
  static emptyDiagnostics = emptyDiagnostics
}
