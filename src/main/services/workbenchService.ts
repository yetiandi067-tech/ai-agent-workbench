import { randomUUID } from 'node:crypto'

import {
  AUTO_RETRY_ENABLED,
  BUILT_IN_TEMPLATE_IDS,
  REMOTE_NOT_STOPPED_WARNING,
  type AgentDescriptor,
  type AgentRunEvent,
  type CreateTaskInput,
  type CreateTemplateInput,
  type Overview,
  type RunRecord,
  type SystemInfo,
  type TaskFilter,
  type TaskRecord,
  type TaskStatus,
  type TaskTemplate,
  type UpdateTemplateInput
} from '../../shared/types'
import type { Repositories } from '../db/repositories'
import type { Logger } from '../logger'
import type { AppSettings, SettingsStore } from '../settings'
import type { AdapterRegistry } from '../adapters/registry'
import { describeSessionPolicy } from '../adapters/dsh/dshSession'
import { TaskRunner } from '../scheduler/taskRunner'
import { assertTransition } from '../../shared/task-state'

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

  /**
   * handoff 任务人工回填后的计划恢复回调（index.ts 装配时注入 PlanService.resumePlan）。
   * 回填属于任务级操作，但回填结果可能解除计划下游依赖，因此需通知计划调度层继续推进。
   */
  onHandoffResolved: ((planId: string) => void) | null = null

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
          : '该 Agent 在本阶段没有自动执行路径，只能人工交接；创建任务不会自动执行。',
      // 普通单任务：不属于任何主管计划
      planId: null,
      planSeq: null,
      taskKind: null,
      dependsOn: [],
      acceptance: null,
      blockedReason: null
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

  /**
   * 人工回填 handoff 任务执行结果（needs_confirmation → succeeded / failed）。
   *
   * 这是 needs_confirmation 唯一的出边：只有用户显式提交结果才会离开该状态，
   * 不存在任何自动转换路径。回填会作为事件记录（可审计），且若该任务属于
   * 某个 running 计划，将通知计划调度层继续推进下游子任务。
   */
  submitHandoffResult(taskId: string, resultText: string, succeeded: boolean): TaskRecord {
    const { repos, logger } = this.deps
    const task = repos.tasks.get(taskId)
    if (!task) throw new Error(`任务不存在：${taskId}`)

    if (task.status !== 'needs_confirmation') {
      throw new Error(
        `只有「待人工确认」状态的任务可以回填执行结果，当前状态为：${task.status}。`
      )
    }

    if (task.planId) {
      const plan = repos.plans.get(task.planId)
      if (!plan) throw new Error(`任务所属计划不存在：${task.planId}`)
      if (plan.status !== 'running') {
        throw new Error(
          `所属计划已结束（${plan.status}），无法回填。` +
            '计划结束后的任务状态变更需人工检查，工作台不会自动修改。'
        )
      }
    }

    // 状态机校验：needs_confirmation → succeeded / failed
    const nextStatus = assertTransition(task.status, succeeded ? 'succeeded' : 'failed')
    const now = new Date().toISOString()
    const trimmed = resultText.trim()
    const resolved: TaskRecord = {
      ...task,
      status: nextStatus,
      endedAt: now,
      finalText: trimmed
        ? `${task.finalText ?? ''}\n\n—— 人工回填结果（${succeeded ? '成功' : '失败'}）——\n${trimmed}`
        : task.finalText,
      userNotice: succeeded
        ? '人工回填完成：执行成功。'
        : '人工回填完成：执行失败（任务不会自动重试，如需重试请重新创建任务）。'
    }
    repos.tasks.update(resolved)

    const seq = repos.events.countByTask(taskId) + 1
    repos.events.append(
      taskId,
      '',
      {
        type: 'status',
        rawType: 'workbench.handoff_resolved',
        payload: {
          phase: 'handoff_resolved',
          succeeded,
          resultPreview: trimmed.slice(0, 200)
        },
        receivedAt: now
      },
      seq
    )

    logger.info('handoff 任务人工回填', {
      taskId,
      succeeded,
      planId: task.planId,
      resultLength: trimmed.length
    })
    this.deps.onTaskChanged(resolved)

    if (task.planId) this.onHandoffResolved?.(task.planId)
    return resolved
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

  // ========== 任务模板管理 ==========

  /** 初始化内置模板（首次启动时自动创建）。 */
  private ensureBuiltInTemplates(): void {
    const existing = this.deps.repos.templates.list()
    if (existing.length > 0) return
    const now = new Date().toISOString()
    const builtins: TaskTemplate[] = [
      {
        id: BUILT_IN_TEMPLATE_IDS[0],
        name: 'Mock 链路自测',
        description: '用于验证工作台 Mock 执行链路是否正常。',
        agentId: 'mock',
        promptTemplate: 'mock:success 这是一个链路自测任务',
        titleTemplate: 'Mock 链路自测',
        tags: 'mock,test',
        isBuiltIn: true,
        createdAt: now,
        updatedAt: now
      },
      {
        id: BUILT_IN_TEMPLATE_IDS[1],
        name: '代码审查',
        description: '审查指定代码片段的质量、潜在问题与改进建议。',
        agentId: 'dsh',
        promptTemplate: '请审查以下代码：\n\n{{code}}\n\n请从质量、安全、性能三个维度给出评价和改进建议。',
        titleTemplate: '代码审查',
        tags: 'code,review',
        isBuiltIn: true,
        createdAt: now,
        updatedAt: now
      },
      {
        id: BUILT_IN_TEMPLATE_IDS[2],
        name: '文档生成',
        description: '根据代码或需求描述生成结构化文档。',
        agentId: 'dsh',
        promptTemplate: '请根据以下内容生成一份结构化文档：\n\n{{content}}\n\n要求：包含概述、详细说明、使用示例。',
        titleTemplate: '文档生成',
        tags: 'doc,generate',
        isBuiltIn: true,
        createdAt: now,
        updatedAt: now
      },
      {
        id: BUILT_IN_TEMPLATE_IDS[3],
        name: '数据分析',
        description: '分析给定数据并给出洞察。',
        agentId: 'dsh',
        promptTemplate: '请分析以下数据：\n\n{{data}}\n\n请给出趋势分析、异常检测和关键洞察。',
        titleTemplate: '数据分析',
        tags: 'data,analysis',
        isBuiltIn: true,
        createdAt: now,
        updatedAt: now
      }
    ]
    for (const tpl of builtins) this.deps.repos.templates.create(tpl)
    this.deps.logger.info('初始化内置任务模板', { count: builtins.length })
  }

  listTemplates(agentId?: string): TaskTemplate[] {
    this.ensureBuiltInTemplates()
    return this.deps.repos.templates.list(agentId)
  }

  createTemplate(input: CreateTemplateInput): TaskTemplate {
    const now = new Date().toISOString()
    const template: TaskTemplate = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description.trim(),
      agentId: input.agentId.trim(),
      promptTemplate: input.promptTemplate,
      titleTemplate: input.titleTemplate.trim(),
      tags: input.tags.trim(),
      isBuiltIn: false,
      createdAt: now,
      updatedAt: now
    }
    if (template.name.length === 0) throw new Error('模板名称不能为空。')
    if (template.promptTemplate.length === 0) throw new Error('模板内容不能为空。')
    this.deps.repos.templates.create(template)
    this.deps.logger.info('创建任务模板', { id: template.id, name: template.name })
    return template
  }

  updateTemplate(input: UpdateTemplateInput): TaskTemplate {
    const existing = this.deps.repos.templates.get(input.id)
    if (!existing) throw new Error(`模板不存在：${input.id}`)
    if (existing.isBuiltIn) throw new Error('内置模板不可修改。')
    const updated: TaskTemplate = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId.trim() } : {}),
      ...(input.promptTemplate !== undefined ? { promptTemplate: input.promptTemplate } : {}),
      ...(input.titleTemplate !== undefined ? { titleTemplate: input.titleTemplate.trim() } : {}),
      ...(input.tags !== undefined ? { tags: input.tags.trim() } : {}),
      updatedAt: new Date().toISOString()
    }
    if (updated.name.length === 0) throw new Error('模板名称不能为空。')
    if (updated.promptTemplate.length === 0) throw new Error('模板内容不能为空。')
    this.deps.repos.templates.update(updated)
    this.deps.logger.info('更新任务模板', { id: updated.id, name: updated.name })
    return updated
  }

  deleteTemplate(id: string): void {
    const existing = this.deps.repos.templates.get(id)
    if (!existing) throw new Error(`模板不存在：${id}`)
    if (existing.isBuiltIn) throw new Error('内置模板不可删除。')
    this.deps.repos.templates.delete(id)
    this.deps.logger.info('删除任务模板', { id, name: existing.name })
  }

  // ========== 批量操作 ==========

  /**
   * 批量取消任务。仅对 running 状态的任务有效。
   * 返回每个任务的取消结果。
   */
  batchCancelTasks(taskIds: string[]): Array<{ taskId: string; accepted: boolean; message: string }> {
    const results: Array<{ taskId: string; accepted: boolean; message: string }> = []
    for (const taskId of taskIds) {
      try {
        const result = this.cancelTask(taskId)
        results.push({ taskId, ...result })
      } catch (error) {
        results.push({
          taskId,
          accepted: false,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    this.deps.logger.info('批量取消任务', {
      total: taskIds.length,
      accepted: results.filter((r) => r.accepted).length
    })
    return results
  }

  /**
   * 批量删除任务。仅对非 running 状态的任务有效。
   * 返回每个任务的删除结果。
   */
  batchDeleteTasks(taskIds: string[]): Array<{ taskId: string; deleted: boolean; message: string }> {
    const results: Array<{ taskId: string; deleted: boolean; message: string }> = []
    for (const taskId of taskIds) {
      try {
        const task = this.deps.repos.tasks.get(taskId)
        if (!task) {
          results.push({ taskId, deleted: false, message: '任务不存在' })
          continue
        }
        if (task.status === 'running') {
          results.push({ taskId, deleted: false, message: '运行中的任务不可删除，请先取消' })
          continue
        }
        // 删除关联的运行记录和事件
        this.deps.repos.events.deleteByTaskId(taskId)
        this.deps.repos.runs.deleteByTaskId(taskId)
        this.deps.repos.tasks.delete(taskId)
        results.push({ taskId, deleted: true, message: '已删除' })
      } catch (error) {
        results.push({
          taskId,
          deleted: false,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    this.deps.logger.info('批量删除任务', {
      total: taskIds.length,
      deleted: results.filter((r) => r.deleted).length
    })
    return results
  }
}
