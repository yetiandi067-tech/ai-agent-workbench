import { randomUUID } from 'node:crypto'

import {
  BLOCKED_BY_DEPENDENCY_CODE,
  MOCK_PLAN_DISCLAIMER,
  type PlanFilter,
  type PlanRecord,
  type PlanSummary,
  type PlanTaskSummary,
  type PlanWithTasks,
  type SubTaskKind,
  type TaskRecord
} from '../../shared/types'
import type { Repositories } from '../db/repositories'
import type { Logger } from '../logger'
import { buildMockPlan } from '../planner/mockPlanner'
import type { WorkbenchService } from './workbenchService'

export interface PlanServiceDeps {
  repos: Repositories
  logger: Logger
  /** 复用工作台的任务执行器（含状态机 / 事件 / 持久化）。 */
  workbench: WorkbenchService
  /** 计划状态变化时回调（用于推送到渲染层）。 */
  onPlanChanged: (plan: PlanRecord) => void
}

/**
 * 主管 Agent 调度服务（第 4 步·阶段 1：Mock 优先）。
 *
 * 职责：
 * 1. 接收用户输入的总目标，调用 Mock Planner 生成结构化的子任务计划；
 * 2. 把计划落库（plans 表 + tasks 表，子任务初始为 pending）；
 * 3. 用户显式确认后，按依赖顺序串行调度子任务（复用 TaskRunner / Mock 适配器）；
 * 4. 子任务失败时阻断所有依赖它的下游任务；
 * 5. 全部子任务终态后生成汇总报告，并更新计划最终状态；
 * 6. 启动时恢复上次遗留的 running 计划（标记为失败，不自动重跑）。
 *
 * 不可违反的规则：
 * - 不调用任何真实模型（本阶段只用 Mock 适配器）；
 * - 不自动重试、不重复执行同一个子任务；
 * - 串行调度（一次只跑一个子任务），不并发；
 * - 总任务完成判定：全部子任务成功 → succeeded；部分成功 → partial；零成功 → failed；
 * - 阻断必须记录原因（blockedReason），不能静默吞掉。
 */
export class PlanService {
  constructor(private readonly deps: PlanServiceDeps) {}

  /** 创建计划草稿（预览用，不会执行）。返回计划 + 子任务。 */
  createPlan(goal: string): PlanWithTasks {
    const trimmedGoal = goal.trim()
    if (trimmedGoal.length === 0) throw new Error('总目标不能为空。')

    const draft = buildMockPlan(trimmedGoal)
    const now = new Date().toISOString()
    const planId = randomUUID()

    const plan: PlanRecord = {
      id: planId,
      title: draft.title,
      goal: draft.goal,
      status: 'draft',
      planner: draft.planner,
      createdAt: now,
      confirmedAt: null,
      startedAt: null,
      endedAt: null,
      summary: null,
      blockedReason: null,
      taskCount: draft.subtasks.length
    }
    this.deps.repos.plans.create(plan)

    // 为每个子任务生成稳定的 taskId，并建立 seq → taskId 的映射
    const taskIdBySeq = new Map<number, string>()
    for (const subtask of draft.subtasks) {
      taskIdBySeq.set(subtask.seq, randomUUID())
    }

    const tasks: TaskRecord[] = draft.subtasks.map((subtask) => {
      const taskId = taskIdBySeq.get(subtask.seq)
      if (!taskId) throw new Error(`内部错误：seq ${subtask.seq} 未分配 taskId`)
      const dependsOn = subtask.dependsOnSeq.map((depSeq) => {
        const depTaskId = taskIdBySeq.get(depSeq)
        if (!depTaskId) throw new Error(`内部错误：依赖的 seq ${depSeq} 未分配 taskId`)
        return depTaskId
      })

      const task: TaskRecord = {
        id: taskId,
        title: subtask.title,
        prompt: subtask.prompt,
        agentId: subtask.agentId,
        adapterId: subtask.agentId, // Mock 适配器的 id 与 agentId 一致
        isRealCall: false,
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
        userNotice: null,
        planId,
        planSeq: subtask.seq,
        taskKind: subtask.kind,
        dependsOn,
        acceptance: subtask.acceptance,
        blockedReason: null
      }
      this.deps.repos.tasks.create(task)
      return task
    })

    this.deps.logger.info('创建主管计划（Mock 预览）', {
      planId,
      goal: trimmedGoal,
      taskCount: tasks.length
    })
    this.deps.onPlanChanged(plan)
    return { plan, tasks }
  }

  /** 用户确认后启动计划（异步调度，立即返回）。 */
  async confirmPlan(planId: string): Promise<PlanRecord> {
    const plan = this.deps.repos.plans.get(planId)
    if (!plan) throw new Error(`计划不存在：${planId}`)
    if (plan.status !== 'draft') {
      throw new Error(
        `计划当前状态为「${plan.status}」，只有「待确认（预览）」状态的计划才能启动执行。`
      )
    }

    const now = new Date().toISOString()
    const updated: PlanRecord = {
      ...plan,
      status: 'running',
      confirmedAt: now,
      startedAt: now
    }
    this.deps.repos.plans.update(updated)
    this.deps.onPlanChanged(updated)
    this.deps.logger.info('启动主管计划（Mock 执行）', { planId })

    // 异步调度，不阻塞返回
    this.runPlan(planId).catch((error) => {
      this.deps.logger.error('计划调度过程中抛出未捕获异常', {
        planId,
        error: error instanceof Error ? error.message : String(error)
      })
    })

    return updated
  }

  /** 列出计划（按创建时间倒序）。 */
  listPlans(filter: PlanFilter = {}): PlanRecord[] {
    return this.deps.repos.plans.list(filter)
  }

  /** 获取计划 + 其子任务（详情 / 预览用）。 */
  getPlanWithTasks(planId: string): PlanWithTasks | null {
    const plan = this.deps.repos.plans.get(planId)
    if (!plan) return null
    const tasks = this.deps.repos.tasks.listByPlan(planId)
    return { plan, tasks }
  }

  /**
   * 启动时恢复：把上次遗留的 running 计划标记为失败。
   * 子任务的 running 状态已由 WorkbenchService.initialize 恢复为 needs_confirmation，
   * 这里只需要更新计划状态并记录原因。
   */
  recoverStalePlans(): number {
    const stalePlans = this.deps.repos.plans.listRunning()
    const now = new Date().toISOString()
    for (const plan of stalePlans) {
      const updated: PlanRecord = {
        ...plan,
        status: 'failed',
        endedAt: plan.endedAt ?? now,
        blockedReason:
          '应用上次退出时该计划仍在执行中，无法确认子任务最终状态。' +
          '为避免重复执行或状态混乱，本计划已标记为失败，不会自动重跑。'
      }
      this.deps.repos.plans.update(updated)
      this.deps.onPlanChanged(updated)
      this.deps.logger.warn('恢复遗留的执行中计划', { planId: plan.id })
    }
    return stalePlans.length
  }

  /**
   * 调度循环：串行执行所有可推进的子任务，直到无可推进或全部终态。
   *
   * 可推进 = pending 且所有依赖都已 succeeded。
   * 子任务失败后，递归阻断所有依赖它的下游 pending 任务。
   */
  private async runPlan(planId: string): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const tasks = this.deps.repos.tasks.listByPlan(planId)
      const taskById = new Map(tasks.map((task) => [task.id, task]))

      // 找出所有可推进的子任务
      const runnable = tasks.filter((task) => {
        if (task.status !== 'pending') return false
        return task.dependsOn.every((depId) => taskById.get(depId)?.status === 'succeeded')
      })

      if (runnable.length === 0) {
        // 无可推进任务：检查是否还有 pending（被阻断的）
        const stillPending = tasks.filter((task) => task.status === 'pending')
        if (stillPending.length > 0) {
          this.deps.logger.warn('计划存在无法推进的子任务（依赖未全部成功）', {
            planId,
            pendingCount: stillPending.length
          })
          // 阻断所有剩余 pending 任务
          for (const task of stillPending) {
            this.blockTask(task, '依赖的上游任务未全部成功，无法继续执行。')
          }
        }
        break
      }

      // 串行执行第一个可推进的子任务
      const next = runnable[0]
      this.deps.logger.info('调度子任务', {
        planId,
        taskId: next.id,
        seq: next.planSeq,
        kind: next.taskKind
      })

      const finished = await this.deps.workbench.runner.runTask(next.id, {
        realCallConfirmed: false
      })

      // 子任务失败 / 超时 / 取消：阻断所有依赖它的下游任务
      if (finished.status !== 'succeeded') {
        this.deps.logger.warn('子任务未成功，阻断下游依赖任务', {
          planId,
          taskId: finished.id,
          status: finished.status,
          errorCode: finished.errorCode
        })
        this.blockDownstreamTasks(planId, finished.id)
      }
    }

    // 全部子任务终态后，生成汇总报告并更新计划状态
    this.finalizePlan(planId)
  }

  /** 阻断单个任务（标记为 failed + BLOCKED_BY_DEPENDENCY）。 */
  private blockTask(task: TaskRecord, reason: string): void {
    if (task.status !== 'pending') return // 只阻断 pending 任务
    const now = new Date().toISOString()
    const blocked: TaskRecord = {
      ...task,
      status: 'failed',
      endedAt: now,
      errorCode: BLOCKED_BY_DEPENDENCY_CODE,
      errorMessage: reason,
      blockedReason: reason,
      userNotice: `该子任务因依赖失败被阻断，未实际执行。${MOCK_PLAN_DISCLAIMER}`
    }
    this.deps.repos.tasks.update(blocked)
    this.deps.logger.warn('阻断子任务', { taskId: task.id, reason })

    // 记录阻断事件（便于审计）
    try {
      this.deps.repos.events.append(
        task.id,
        'no-run',
        {
          type: 'error',
          rawType: 'workbench.blocked_by_dependency',
          payload: {
            phase: 'blocked_by_dependency',
            code: BLOCKED_BY_DEPENDENCY_CODE,
            reason
          },
          receivedAt: now
        },
        this.deps.repos.events.countByTask(task.id) + 1
      )
    } catch {
      // 事件写入失败不影响主流程
    }
  }

  /** 递归阻断所有依赖 failedTaskId 的下游任务。 */
  private blockDownstreamTasks(planId: string, failedTaskId: string): void {
    const tasks = this.deps.repos.tasks.listByPlan(planId)
    const failedTask = tasks.find((task) => task.id === failedTaskId)
    if (!failedTask) return

    const failedTaskTitle = failedTask.title
    const reason = `依赖的上游任务「${failedTaskTitle}」未成功（${failedTask.status}），本任务被阻断。`

    // 找出所有直接依赖 failedTaskId 的 pending 任务
    const directDependents = tasks.filter(
      (task) => task.status === 'pending' && task.dependsOn.includes(failedTaskId)
    )

    for (const dependent of directDependents) {
      this.blockTask(dependent, reason)
      // 递归阻断更下游
      this.blockDownstreamTasks(planId, dependent.id)
    }
  }

  /** 全部子任务终态后，生成汇总报告并更新计划最终状态。 */
  private finalizePlan(planId: string): void {
    const plan = this.deps.repos.plans.get(planId)
    if (!plan) {
      this.deps.logger.error('finalizePlan 时计划不存在', { planId })
      return
    }

    const tasks = this.deps.repos.tasks.listByPlan(planId)
    const summary = this.generatePlanSummary(tasks)

    let finalStatus: PlanRecord['status']
    if (summary.succeededCount === summary.totalCount) {
      finalStatus = 'succeeded'
    } else if (summary.succeededCount > 0) {
      finalStatus = 'partial'
    } else {
      finalStatus = 'failed'
    }

    const updated: PlanRecord = {
      ...plan,
      status: finalStatus,
      endedAt: new Date().toISOString(),
      summary
    }
    this.deps.repos.plans.update(updated)
    this.deps.onPlanChanged(updated)
    this.deps.logger.info('计划执行结束', {
      planId,
      status: finalStatus,
      succeeded: summary.succeededCount,
      failed: summary.failedCount,
      blocked: summary.blockedCount
    })
  }

  /** 生成汇总报告（含结论、统计、各子任务摘要）。 */
  private generatePlanSummary(tasks: TaskRecord[]): PlanSummary {
    const totalCount = tasks.length
    const succeededCount = tasks.filter((task) => task.status === 'succeeded').length
    const failedCount = tasks.filter(
      (task) => task.status === 'failed' && task.errorCode !== BLOCKED_BY_DEPENDENCY_CODE
    ).length
    const blockedCount = tasks.filter(
      (task) => task.errorCode === BLOCKED_BY_DEPENDENCY_CODE
    ).length

    let conclusion: PlanSummary['conclusion']
    let report: string
    if (succeededCount === totalCount) {
      conclusion = 'all_succeeded'
      report = `全部 ${totalCount} 个子任务已成功完成。${MOCK_PLAN_DISCLAIMER}`
    } else if (succeededCount > 0) {
      conclusion = 'partial'
      report =
        `部分完成：${succeededCount}/${totalCount} 个子任务成功，` +
        `${failedCount} 个失败，${blockedCount} 个被阻断。${MOCK_PLAN_DISCLAIMER}`
    } else {
      conclusion = 'all_blocked_or_failed'
      report =
        `计划未能完成：所有子任务均失败或被阻断（失败 ${failedCount} 个，阻断 ${blockedCount} 个）。` +
        MOCK_PLAN_DISCLAIMER
    }

    const perTask: PlanTaskSummary[] = tasks.map((task) => ({
      taskId: task.id,
      seq: task.planSeq ?? 0,
      kind: task.taskKind as SubTaskKind,
      title: task.title,
      agentId: task.agentId,
      status: task.status,
      outputExcerpt:
        task.status === 'succeeded' && task.finalText
          ? task.finalText.slice(0, 100)
          : null,
      errorCode: task.errorCode,
      errorMessage: task.errorMessage,
      blockedReason: task.blockedReason
    }))

    return {
      conclusion,
      totalCount,
      succeededCount,
      failedCount,
      blockedCount,
      report,
      perTask,
      generatedAt: new Date().toISOString()
    }
  }
}
