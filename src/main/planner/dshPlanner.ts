import { randomUUID } from 'node:crypto'

import {
  SUB_TASK_KINDS,
  type PlanDraft,
  type PlannedSubTask,
  type SubTaskKind,
  type UsageRecord
} from '../../shared/types'
import { TIMEOUT_REASON, type RunInput } from '../adapters/types'
import { redactAndTruncate } from '../../shared/redact'
import type { Planner, PlannerContext, PlannerResult } from './types'

export const DSH_PLANNER_ID = 'dsh-planner'
export const DSH_PLANNER_NAME = 'DeepSeek Harness 真实规划器'

/** 单个计划最多允许的子任务数量（避免模型输出过大的计划）。 */
export const MAX_PLAN_SUBTASKS = 8
/** 最少子任务数量。 */
export const MIN_PLAN_SUBTASKS = 1

/** 模型输出校验失败时使用的错误码（调用方据此拒绝落库）。 */
export const PLAN_OUTPUT_INVALID_CODE = 'PLAN_OUTPUT_INVALID'
export const PLAN_DSH_FAILED_CODE = 'PLAN_DSH_FAILED'
export const PLAN_DSH_TIMEOUT_CODE = 'PLAN_DSH_TIMEOUT'

/** 模型原始 JSON 中单个子任务的形状。 */
interface RawSubTask {
  seq?: unknown
  kind?: unknown
  title?: unknown
  description?: unknown
  prompt?: unknown
  acceptance?: unknown
  agentId?: unknown
  dependsOnSeq?: unknown
}

interface RawPlan {
  title?: unknown
  subtasks?: unknown
}

/**
 * 从 DSH 输出文本中抽取 JSON。
 *
 * 模型可能把 JSON 包在 ```json 代码块里，或前后夹杂解释文字。
 * 这里优先尝试直接 JSON.parse，失败再剥 markdown 围栏，最后兜底取首个 `{...}`。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error(`${PLAN_OUTPUT_INVALID_CODE}: 模型输出为空。`)

  try {
    return JSON.parse(trimmed)
  } catch {
    // 尝试去掉 markdown 代码围栏
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {
      // 继续兜底
    }
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1))
    } catch (error) {
      throw new Error(
        `${PLAN_OUTPUT_INVALID_CODE}: 无法从模型输出中解析 JSON：${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  throw new Error(`${PLAN_OUTPUT_INVALID_CODE}: 模型输出中未找到 JSON 对象。`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${PLAN_OUTPUT_INVALID_CODE}: 字段「${field}」必须是非空字符串。`)
  }
  return value
}

/**
 * 校验模型输出并转换为 PlanDraft。
 *
 * 校验规则（任何一条不满足都抛 PLAN_OUTPUT_INVALID，调用方据此拒绝落库）：
 * 1. 顶层必须是含 subtasks 数组的对象；
 * 2. subtasks 长度在 [MIN_PLAN_SUBTASKS, MAX_PLAN_SUBTASKS]；
 * 3. seq 必须是 1..N 的连续整数；
 * 4. kind 必须属于 SUB_TASK_KINDS；
 * 5. title / prompt / acceptance 非空；
 * 6. agentId 必须是已注册的 agent（agents 列表）；
 * 7. dependsOnSeq 只能引用比自身 seq 更小的序号（排除循环依赖与前向依赖）。
 */
export function validatePlannerOutput(
  raw: unknown,
  agents: Array<{ id: string }>
): PlanDraft {
  if (!isPlainObject(raw)) {
    throw new Error(`${PLAN_OUTPUT_INVALID_CODE}: 顶层必须是 JSON 对象。`)
  }

  const plan = raw as RawPlan
  const title = asNonEmptyString(plan.title, 'title')
  const rawSubtasks = plan.subtasks
  if (!Array.isArray(rawSubtasks)) {
    throw new Error(`${PLAN_OUTPUT_INVALID_CODE}: 字段「subtasks」必须是数组。`)
  }
  if (
    rawSubtasks.length < MIN_PLAN_SUBTASKS ||
    rawSubtasks.length > MAX_PLAN_SUBTASKS
  ) {
    throw new Error(
      `${PLAN_OUTPUT_INVALID_CODE}: 子任务数量必须在 ${MIN_PLAN_SUBTASKS}–${MAX_PLAN_SUBTASKS} 之间，当前为 ${rawSubtasks.length}。`
    )
  }

  const allowedAgentIds = new Set(agents.map((a) => a.id))
  const seenSeqs = new Set<number>()
  const subtasks: PlannedSubTask[] = []

  for (let i = 0; i < rawSubtasks.length; i++) {
    const rawTask = rawSubtasks[i] as RawSubTask
    if (!isPlainObject(rawTask)) {
      throw new Error(`${PLAN_OUTPUT_INVALID_CODE}: 第 ${i + 1} 个子任务不是对象。`)
    }

    const seq = rawTask.seq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) {
      throw new Error(`${PLAN_OUTPUT_INVALID_CODE}: 子任务 seq 必须是正整数。`)
    }
    if (seenSeqs.has(seq)) {
      throw new Error(`${PLAN_OUTPUT_INVALID_CODE}: 子任务 seq 重复：${seq}。`)
    }
    seenSeqs.add(seq)

    const kind = rawTask.kind
    if (typeof kind !== 'string' || !(SUB_TASK_KINDS as readonly string[]).includes(kind)) {
      throw new Error(
        `${PLAN_OUTPUT_INVALID_CODE}: 子任务 #${seq} 的 kind 必须是 ${SUB_TASK_KINDS.join(
          ' / '
        )} 之一，当前为 ${JSON.stringify(kind)}。`
      )
    }

    const dependsOnRaw = rawTask.dependsOnSeq
    const dependsOnSeq: number[] = []
    if (dependsOnRaw !== undefined && dependsOnRaw !== null) {
      if (!Array.isArray(dependsOnRaw)) {
        throw new Error(`${PLAN_OUTPUT_INVALID_CODE}: 子任务 #${seq} 的 dependsOnSeq 必须是数组。`)
      }
      for (const dep of dependsOnRaw) {
        if (typeof dep !== 'number' || !Number.isInteger(dep) || dep <= 0) {
          throw new Error(
            `${PLAN_OUTPUT_INVALID_CODE}: 子任务 #${seq} 的 dependsOnSeq 只能包含正整数。`
          )
        }
        // 只允许依赖已出现（更小 seq）的任务 → 自动排除循环与前向依赖
        if (dep >= seq) {
          throw new Error(
            `${PLAN_OUTPUT_INVALID_CODE}: 子任务 #${seq} 不能依赖 #${dep}（只能依赖更小的 seq）。`
          )
        }
        dependsOnSeq.push(dep)
      }
    }

    const agentId = asNonEmptyString(rawTask.agentId, `#${seq}.agentId`)
    if (!allowedAgentIds.has(agentId)) {
      throw new Error(
        `${PLAN_OUTPUT_INVALID_CODE}: 子任务 #${seq} 的 agentId「${agentId}」未在已注册 Agent 列表中。`
      )
    }

    subtasks.push({
      seq,
      kind: kind as SubTaskKind,
      title: asNonEmptyString(rawTask.title, `#${seq}.title`),
      description: asNonEmptyString(rawTask.description, `#${seq}.description`),
      prompt: asNonEmptyString(rawTask.prompt, `#${seq}.prompt`),
      inputSpec:
        dependsOnSeq.length === 0
          ? '仅依赖用户输入的总目标。'
          : `依赖第 ${dependsOnSeq.join(', ')} 步的输出。`,
      outputSpec: `产出「${asNonEmptyString(rawTask.title, `#${seq}.title`)}」阶段的阶段性结果。`,
      acceptance: asNonEmptyString(rawTask.acceptance, `#${seq}.acceptance`),
      agentId,
      dependsOnSeq
    })
  }

  // seq 必须是 1..N 连续整数
  const expected = Array.from({ length: subtasks.length }, (_, i) => i + 1)
  const actual = [...seenSeqs].sort((a, b) => a - b)
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `${PLAN_OUTPUT_INVALID_CODE}: 子任务 seq 必须是 1..${subtasks.length} 的连续整数，当前为 ${actual.join(', ')}。`
    )
  }

  return {
    title: title.slice(0, 80),
    goal: '', // 由调用方（PlanService）填入用户原始 goal
    planner: DSH_PLANNER_ID,
    subtasks
  }
}

/** 给 DSH 的规划提示词：明确要求只输出符合约束的 JSON。 */
export function buildDshPlanPrompt(goal: string, agentIds: string[]): string {
  return [
    `你是一个任务规划助手。请把下面的总目标拆分为 ${MIN_PLAN_SUBTASKS}–${MAX_PLAN_SUBTASKS} 个有序子任务。`,
    '',
    '总目标：',
    goal,
    '',
    '输出要求（严格遵守）：',
    '1. 只输出一个 JSON 对象，不要输出任何解释、注释或 markdown 代码围栏；',
    '2. JSON 顶层结构：{ "title": string, "subtasks": SubTask[] }；',
    `3. 每个 SubTask 字段：seq (正整数，从 1 开始连续), kind (只能是 ${SUB_TASK_KINDS.join(
      ' / '
    )} 之一), title (字符串), description (字符串), prompt (字符串，执行该子任务时传给模型的完整指令), acceptance (字符串，验收标准), agentId (字符串，只能从下列已注册 Agent 中选择: ${agentIds.join(
      ', '
    )}), dependsOnSeq (数字数组，只能引用比自身 seq 更小的序号，表示依赖)；`,
    '4. seq 必须是 1..N 的连续整数；dependsOnSeq 不允许循环或前向依赖；',
    '5. 不要编造未在列表中出现的 agentId。'
  ].join('\n')
}

/**
 * 基于已验证的 DSH Adapter 的真实规划器。
 *
 * 安全约束：
 * - 调用前必须通过 ctx.allowRealCall()（真实调用总开关）；
 * - 不直接写数据库，只返回解析后的草稿 + 用量；
 * - 输出校验失败时抛出 PLAN_OUTPUT_INVALID，由调用方决定是否落库；
 * - 超时由 AbortSignal 控制，适配器负责终止子进程。
 */
export class DshPlanner implements Planner {
  readonly id = DSH_PLANNER_ID
  readonly name = DSH_PLANNER_NAME
  readonly isRealCall = true

  async plan(goal: string, ctx: PlannerContext): Promise<PlannerResult> {
    const permission = ctx.allowRealCall()
    if (!permission.allowed) {
      throw new Error(`${PLAN_DSH_FAILED_CODE}: ${permission.reason}`)
    }

    const adapter = ctx.registry.get('dsh')
    if (!adapter) {
      throw new Error(`${PLAN_DSH_FAILED_CODE}: DSH 适配器未注册，无法进行真实规划。`)
    }

    const agents = ctx.agents()
    const agentIds = agents.map((a) => a.id)
    const prompt = buildDshPlanPrompt(goal, agentIds)

    const runId = randomUUID()
    const taskId = `plan-${runId}`
    const input: RunInput = {
      taskId,
      runId,
      prompt,
      cwd: ctx.cwd,
      timeoutMs: ctx.timeoutMs
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(TIMEOUT_REASON), ctx.timeoutMs)

    try {
      const outcome = await adapter.run(input, {
        signal: controller.signal,
        onEvent: () => {
          // 规划阶段的增量事件暂时只用于日志，不推送到任务事件流。
        }
      })

      ctx.logger.info('DSH 规划调用结束', {
        runId,
        status: outcome.status,
        totalTokens: outcome.usage?.totalTokens ?? null
      })

      if (outcome.status === 'timed_out') {
        throw new Error(
          `${PLAN_DSH_TIMEOUT_CODE}: DSH 规划在 ${ctx.timeoutMs} ms 内未完成，已终止本地子进程。`
        )
      }
      if (outcome.status !== 'succeeded' || !outcome.finalText) {
        throw new Error(
          `${PLAN_DSH_FAILED_CODE}: DSH 规划失败：${outcome.errorCode ?? outcome.status} — ${
            outcome.errorMessage ?? '无错误信息'
          }`
        )
      }

      const raw = extractJson(outcome.finalText)
      const draft = validatePlannerOutput(raw, agents)
      draft.goal = goal.trim()

      const usage: UsageRecord | null = outcome.usage

      return {
        draft,
        usage,
        modelOutputExcerpt: redactAndTruncate(outcome.finalText, 2000)
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
