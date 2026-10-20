import { randomUUID } from 'node:crypto'

import {
  AUTO_RETRY_ENABLED,
  REMOTE_NOT_STOPPED_WARNING,
  type AgentDescriptor,
  type AgentRunEvent,
  type CreateTaskInput,
  type Overview,
  type RunRecord,
  type SystemInfo,
  type TaskFilter,
  type TaskRecord,
  type TaskStatus
} from '../../shared/types'
import type { Repositories } from '../db/repositories'
import type { Logger } from '../logger'
import type { AppSettings, SettingsStore } from '../settings'
import type { AdapterRegistry } from '../adapters/registry'
import { describeSessionPolicy } from '../adapters/dsh/dshSession'
import { TaskRunner } from '../scheduler/taskRunner'

export interface DatabaseInfo {
  filePath: string
  mode: 'file' | 'memory-fallback'
  detail: string
  schemaVersion: number
}

export interface WorkbenchServiceDeps {
  repos: Repositories
  registry: AdapterRegistry
  settings: SettingsStore
  logger: Logger
  databaseInfo: DatabaseInfo
  /** 运行环境信息（由 electron 侧注入，服务层自身不依赖 electron）。 */
  environment: Omit<SystemInfo, 'database' | 'sessionNote'>
  onTaskChanged: (task: TaskRecord) => void
  onRunEvent: (taskId: string, event: AgentRunEvent) => void
}

const STALE_RUNNING_NOTICE =
  '应用上次退出时该任务仍在执行中，其本地子进程已随进程消失，无法确认远端是否仍在运行。' +
  '为避免在状态不明时重复计费，本任务已标记为「待人工确认」，不会自动重跑。' +
  REMOTE_NOT_STOPPED_WARNING

export class WorkbenchService {
  readonly runner: TaskRunner

  constructor(private readonly deps: WorkbenchServiceDeps) {
    this.runner = new TaskRunner({
      repos: deps.repos,
      registry: deps.registry,
      getSettings: () => deps.settings.get(),
      logger: deps.logger,
      onTaskChanged: deps.onTaskChanged,
      onRunEvent: deps.onRunEvent
    })
  }

  /** 启动时同步 Agent 描述，并把上次遗留的 running 任务转入待人工确认。 */
  initialize(): { staleRunningRecovered: number; agentCount: number } {
    const descriptors = this.deps.registry.descriptors()
    for (const descriptor of descriptors) this.deps.repos.agents.upsert(descriptor)
    const recovered = this.deps.repos.tasks.recoverStaleRunning(STALE_RUNNING_NOTICE)
    if (recovered.length > 0) {
      this.deps.logger.warn('检测到上次遗留的执行中任务，已转入待人工确认', {
        count: recovered.length
      })
      for (const task of recovered) this.deps.onTaskChanged(task)
    }
    return { staleRunningRecovered: recovered.length, agentCount: descriptors.length }
  }

  listAgents(): AgentDescriptor[] {
    return this.deps.registry.descriptors()
  }

  /** 只读探活。DSH 只会跑 `--version`，**不提交模型任务**。 */
  async checkAgent(agentId: string): Promise<AgentDescriptor> {
    const adapter = this.deps.registry.get(agentId)
    if (!adapter) {
      const staticAgent = this.deps.registry
        .staticDescriptors()
        .find((descriptor) => descriptor.id === agentId)
      if (!staticAgent) throw new Error(`未知 Agent：${agentId}`)
      return staticAgent
    }
    const descriptor = await adapter.checkAvailability()
    this.deps.repos.agents.upsert(descriptor)
    return descriptor
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const title = input.title.trim()
    const prompt = input.prompt.trim()
    if (prompt.length === 0) throw new Error('任务内容不能为空。')
    if (title.length === 0) throw new Error('任务标题不能为空。')

    const descriptor = this.listAgents().find((agent) => agent.id === input.agentId)
    if (!descriptor) throw new Error(`未知 Agent：${input.agentId}`)

    const now = new Date().toISOString()
    const task: TaskRecord = {
      id: randomUUID(),
      title: title.slice(0, 200),
      prompt,
      agentId: descriptor.id,
      adapterId: descriptor.adapterId,
      isRealCall: descriptor.isRealCall,
      status: 'pending',
      createdAt: now,
      startedAt: null,
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
      cwd: null,
      attempt: 1,
      userNotice:
        descriptor.mode === 'auto'
          ? null
          : '该 Agent 在本阶段没有自动执行路径，只能人工交接；创建任务不会自动执行。'
    }
    this.deps.repos.tasks.create(task)
    this.deps.onTaskChanged(task)
    this.deps.logger.info('创建任务', { taskId: task.id, agentId: task.agentId })
    return task
  }

  listTasks(filter: TaskFilter = {}): TaskRecord[] {
    return this.deps.repos.tasks.list(filter)
  }

  getTask(id: string): TaskRecord | null {
    return this.deps.repos.tasks.get(id)
  }

  getTaskEvents(id: string, limit = 500): AgentRunEvent[] {
    return this.deps.repos.events.listByTask(id, limit)
  }

  listRuns(limit = 200): RunRecord[] {
    return this.deps.repos.runs.listRecent(limit)
  }

  async runTask(taskId: string, realCallConfirmed: boolean): Promise<TaskRecord> {
    return this.runner.runTask(taskId, { realCallConfirmed })
  }

  cancelTask(taskId: string): { accepted: boolean; message: string } {
    const accepted = this.runner.cancelTask(taskId)
    if (!accepted) {
      return { accepted: false, message: '该任务当前不在执行中，无需取消。' }
    }
    return {
      accepted: true,
      message: `已向本地子进程发出终止信号。${REMOTE_NOT_STOPPED_WARNING}`
    }
  }

  overview(): Overview {
    const rows = this.deps.repos.tasks.overviewRows()
    const statusCount: Record<TaskStatus, number> = {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
      needs_confirmation: 0
    }

    let knownTokensTotal = 0
    let verifiedCostTotal = 0
    let estimatedCostTotal = 0
    let costUnverifiedTaskCount = 0
    let realRunCount = 0

    for (const row of rows) {
      statusCount[row.status] = (statusCount[row.status] ?? 0) + 1
      if (row.isRealCall) realRunCount += 1

      const usage = row.usage
      if (!usage) continue
      if (usage.totalTokens !== null) knownTokensTotal += usage.totalTokens
      if (usage.verified && usage.actualCost !== null) verifiedCostTotal += usage.actualCost
      if (usage.estimatedCost !== null) estimatedCostTotal += usage.estimatedCost
      if (row.isRealCall && !usage.verified) costUnverifiedTaskCount += 1
    }

    return {
      total: rows.length,
      pending: statusCount.pending,
      running: statusCount.running,
      succeeded: statusCount.succeeded,
      failed: statusCount.failed,
      timedOut: statusCount.timed_out,
      cancelled: statusCount.cancelled,
      needsConfirmation: statusCount.needs_confirmation,
      realRunCount,
      knownTokensTotal,
      verifiedCostTotal,
      estimatedCostTotal,
      costUnverifiedTaskCount,
      lastActivityAt: this.deps.repos.tasks.lastActivityAt()
    }
  }

  getSettings(): AppSettings {
    return this.deps.settings.get()
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const updated = this.deps.settings.update(patch)
    this.deps.registry.refresh()
    const descriptors = this.deps.registry.descriptors()
    for (const descriptor of descriptors) this.deps.repos.agents.upsert(descriptor)
    this.deps.logger.info('更新设置', { keys: Object.keys(patch) })
    return updated
  }

  systemInfo(): SystemInfo {
    return {
      ...this.deps.environment,
      database: this.deps.databaseInfo,
      sessionNote: describeSessionPolicy(this.deps.settings.get().dshHomeDir)
    }
  }

  /** 界面展示用的护栏摘要（让「限制」在 UI 上可见，而不是只写在文档里）。 */
  guardrails(): Array<{ label: string; value: string; detail: string }> {
    const settings = this.deps.settings.get()
    const stats = this.runner.stats()
    return [
      {
        label: '真实任务并发上限',
        value: `${settings.realConcurrencyLimit}`,
        detail: '超过上限时任务保持「待执行」，不会自动排队后偷偷开跑。'
      },
      {
        label: 'Mock 任务并发上限',
        value: `${settings.mockConcurrencyLimit}`,
        detail: 'Mock 不产生费用，因此并发可以稍宽。'
      },
      {
        label: '自动重试',
        value: AUTO_RETRY_ENABLED ? '开启' : '禁止',
        detail: '本阶段固定禁止自动重试，避免重复计费。'
      },
      {
        label: '真实调用总开关',
        value: settings.allowRealModelCalls ? '已开启' : '已关闭',
        detail: '关闭时任何路径都不会触发真实模型调用。'
      },
      {
        label: '当前执行中',
        value: `${stats.activeTasks} 个任务（其中真实 ${stats.realActive}/${stats.realLimit}）`,
        detail: '本地进程数，不代表远端任务数。'
      },
      {
        label: '任务超时',
        value: `${Math.round(settings.taskTimeoutMs / 1000)} 秒`,
        detail: '超时只终止本地进程，不保证远端请求停止。'
      }
    ]
  }
}
