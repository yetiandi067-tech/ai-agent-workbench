import type { AgentDescriptor, PlanDraft, UsageRecord } from '../../shared/types'
import type { AdapterRegistry } from '../adapters/registry'
import type { Logger } from '../logger'
import type { AppSettings } from '../settings'

/**
 * 规划器运行上下文。
 *
 * 规划器可以复用 AdapterRegistry 里已注册的适配器（当前阶段只有 DSH 是真实可用的），
 * 以及全局设置与「真实调用是否允许」的门控判断。
 */
export interface PlannerContext {
  logger: Logger
  getSettings: () => AppSettings
  /** 真实调用总开关 + 显式确认的统一判断（与 TaskRunner 的门控一致）。 */
  allowRealCall: () => { allowed: boolean; reason: string }
  registry: AdapterRegistry
  /** 当前已注册的 Agent 描述（用于校验模型返回的 agentId 是否存在）。 */
  agents: () => AgentDescriptor[]
  /** 任务工作目录（决定 DSH 会话落盘位置）。 */
  cwd: string
  /** 单次规划的超时时间。 */
  timeoutMs: number
}

/**
 * 规划器的一次执行结果。
 *
 * - `draft`：解析并校验通过的子任务计划（未落库）。
 * - `usage`：规划阶段真实模型调用的用量（Mock 规划器恒为 null）。
 * - `modelOutputExcerpt`：模型原始输出的截断摘要，仅用于排错（不写入任务内容）。
 */
export interface PlannerResult {
  draft: PlanDraft
  usage: UsageRecord | null
  modelOutputExcerpt: string | null
}

/**
 * 主管 Agent 的规划器接口。
 *
 * 实现约束：
 * - `isRealCall === true` 的规划器在调用前必须先通过 ctx.allowRealCall 校验；
 * - 任何输出解析 / 校验失败都应抛出带错误码的异常，由调用方决定是否落库；
 * - 规划器**只负责拆解**，不负责执行子任务，也不直接写数据库。
 */
export interface Planner {
  readonly id: string
  readonly name: string
  readonly isRealCall: boolean
  plan(goal: string, ctx: PlannerContext): Promise<PlannerResult>
}
