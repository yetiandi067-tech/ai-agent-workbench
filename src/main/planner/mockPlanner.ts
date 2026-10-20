import type { PlanDraft, PlannedSubTask, SubTaskKind } from '../../shared/types'

/**
 * Mock Planner：确定性的任务规划器，**不调用任何大模型**。
 *
 * 设计目标：
 * 1. 同一输入必然产生同一输出（测试可重复）；
 * 2. 默认生成「research → analysis → writing → review」四段串行链路；
 * 3. 通过目标文本中的关键词决定是否省略某些阶段，或注入 Mock 失败标记；
 * 4. 生成的子任务全部绑定到 Mock 适配器（agentId = 'mock'），不会产生真实费用。
 *
 * 关键词规则（按优先级从高到低）：
 * - 含「只调研 / 仅调研 / 只收集」 → 只生成 research + analysis 两段；
 * - 含「不用审 / 免审」          → 在完整链路中去掉 review 段；
 * - 含「模拟失败」                → 在 research 子任务的 prompt 中注入 `mock:failure`，
 *                                 用于演示 / 测试「依赖失败阻断下游」的行为。
 *
 * 说明：关键词规则是确定性字符串匹配，不是模型推理；
 * 未被识别的目标一律走默认四段链路。
 */

export const MOCK_PLANNER_ID = 'mock-planner'

/** Mock 适配器 ID（与 AdapterRegistry 中注册的一致）。 */
export const MOCK_AGENT_ID = 'mock'

/** 默认执行 Agent：全部子任务都交给 Mock 适配器。 */
const DEFAULT_AGENT_ID = MOCK_AGENT_ID

/** 关键词：只调研（省略 writing + review）。 */
const RESEARCH_ONLY_KEYWORDS = ['只调研', '仅调研', '只收集', '仅收集']

/** 关键词：不需要审校（省略 review）。 */
const NO_REVIEW_KEYWORDS = ['不用审', '免审', '不审', '跳过审']

/** 关键词：要求演示「失败 → 阻断下游」的场景。 */
const SIMULATE_FAILURE_KEYWORDS = ['模拟失败', '演示失败', 'mock:failure']

function containsAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase()
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()))
}

function buildPrompt(params: {
  kind: SubTaskKind
  goal: string
  simulateFailure: boolean
}): string {
  const { kind, goal, simulateFailure } = params
  const marker = simulateFailure && kind === 'research' ? ' mock:failure' : ''
  return `[${kind}] ${goal}${marker}`
}

function buildSubTask(params: {
  seq: number
  kind: SubTaskKind
  title: string
  description: string
  goal: string
  simulateFailure: boolean
  dependsOnSeq: number[]
}): PlannedSubTask {
  const { seq, kind, title, description, goal, simulateFailure, dependsOnSeq } = params
  return {
    seq,
    kind,
    title,
    description,
    prompt: buildPrompt({ kind, goal, simulateFailure }),
    inputSpec:
      dependsOnSeq.length === 0
        ? '仅依赖用户输入的总目标。'
        : `依赖第 ${dependsOnSeq.join(', ')} 步的输出。`,
    outputSpec: `产出「${title}」阶段的阶段性文本结果。`,
    acceptance: `成功返回「${title}」阶段的输出，且状态为 succeeded。`,
    agentId: DEFAULT_AGENT_ID,
    dependsOnSeq
  }
}

/**
 * 根据用户输入的总目标，生成一份确定性的 Mock 计划草稿。
 *
 * 返回的 `PlanDraft` 还未落库；调用方负责将其持久化并分配 taskId。
 */
export function buildMockPlan(goal: string): PlanDraft {
  const trimmedGoal = goal.trim()
  const title = trimmedGoal.length === 0 ? '未命名目标' : trimmedGoal.slice(0, 40)

  const researchOnly = containsAny(trimmedGoal, RESEARCH_ONLY_KEYWORDS)
  const noReview = containsAny(trimmedGoal, NO_REVIEW_KEYWORDS)
  const simulateFailure = containsAny(trimmedGoal, SIMULATE_FAILURE_KEYWORDS)

  const subtasks: PlannedSubTask[] = []

  // 1) research：始终存在，是整个链路的起点。
  subtasks.push(
    buildSubTask({
      seq: 1,
      kind: 'research',
      title: '资料收集',
      description: '收集与总目标相关的基础信息与背景资料（Mock 模拟）。',
      goal: trimmedGoal,
      simulateFailure,
      dependsOnSeq: []
    })
  )

  // 2) analysis：依赖 research。
  subtasks.push(
    buildSubTask({
      seq: 2,
      kind: 'analysis',
      title: '分析',
      description: '基于上一步收集到的资料进行分析，提炼关键结论（Mock 模拟）。',
      goal: trimmedGoal,
      simulateFailure,
      dependsOnSeq: [1]
    })
  )

  // 3) writing：依赖 analysis；「只调研」模式下省略。
  if (!researchOnly) {
    subtasks.push(
      buildSubTask({
        seq: 3,
        kind: 'writing',
        title: '成文',
        description: '根据分析结果生成阶段性成果文本（Mock 模拟）。',
        goal: trimmedGoal,
        simulateFailure,
        dependsOnSeq: [2]
      })
    )
  }

  // 4) review：依赖 writing；「只调研」或「不用审」模式下省略。
  if (!researchOnly && !noReview) {
    subtasks.push(
      buildSubTask({
        seq: 4,
        kind: 'review',
        title: '审校',
        description: '检查成文质量并给出修改建议与最终结论（Mock 模拟）。',
        goal: trimmedGoal,
        simulateFailure,
        dependsOnSeq: [3]
      })
    )
  }

  return {
    title,
    goal: trimmedGoal,
    planner: MOCK_PLANNER_ID,
    subtasks
  }
}
