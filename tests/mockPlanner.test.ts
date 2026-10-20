import { describe, expect, it } from 'vitest'

import { buildMockPlan, MOCK_AGENT_ID, MOCK_PLANNER_ID } from '../src/main/planner/mockPlanner'
import type { PlanDraft, PlannedSubTask } from '../src/shared/types'

function expectValidPlan(plan: PlanDraft): void {
  expect(plan.planner).toBe(MOCK_PLANNER_ID)
  expect(plan.subtasks.length).toBeGreaterThanOrEqual(2)
  const seqs = plan.subtasks.map((task) => task.seq)
  // seq 必须从 1 开始连续递增
  expect(seqs).toEqual(seqs.map((_, index) => index + 1))
  for (const task of plan.subtasks) {
    expect(task.agentId).toBe(MOCK_AGENT_ID)
    expect(task.title.length).toBeGreaterThan(0)
    expect(task.description.length).toBeGreaterThan(0)
    expect(task.prompt.length).toBeGreaterThan(0)
    expect(task.inputSpec.length).toBeGreaterThan(0)
    expect(task.outputSpec.length).toBeGreaterThan(0)
    expect(task.acceptance.length).toBeGreaterThan(0)
    // 依赖必须指向已存在的、且 seq 更小的兄弟任务
    for (const dep of task.dependsOnSeq) {
      expect(dep).toBeGreaterThanOrEqual(1)
      expect(dep).toBeLessThan(task.seq)
    }
  }
}

describe('Mock Planner', () => {
  it('默认目标生成四段串行链路 research → analysis → writing → review', () => {
    const plan = buildMockPlan('调研 AI 编程助手并写一份报告')
    expectValidPlan(plan)
    expect(plan.subtasks.map((task) => task.kind)).toEqual([
      'research',
      'analysis',
      'writing',
      'review'
    ])
    expect(plan.subtasks[0].dependsOnSeq).toEqual([])
    expect(plan.subtasks[1].dependsOnSeq).toEqual([1])
    expect(plan.subtasks[2].dependsOnSeq).toEqual([2])
    expect(plan.subtasks[3].dependsOnSeq).toEqual([3])
  })

  it('同一输入产生完全相同的输出（确定性，可重复）', () => {
    const goal = '比较两个开源向量数据库'
    const first = buildMockPlan(goal)
    const second = buildMockPlan(goal)
    expect(second).toEqual(first)
  })

  it('「只调研」目标省略 writing 和 review，只保留 research + analysis', () => {
    for (const keyword of ['只调研', '仅调研', '只收集']) {
      const plan = buildMockPlan(`只调研一下本地大模型现状（${keyword}）`)
      expectValidPlan(plan)
      expect(plan.subtasks.map((task) => task.kind)).toEqual(['research', 'analysis'])
    }
  })

  it('「不用审」目标保留 writing 但省略 review', () => {
    for (const keyword of ['不用审', '免审']) {
      const plan = buildMockPlan(`写一段项目介绍（${keyword}）`)
      expectValidPlan(plan)
      expect(plan.subtasks.map((task) => task.kind)).toEqual(['research', 'analysis', 'writing'])
      const writing = plan.subtasks.find((task) => task.kind === 'writing') as PlannedSubTask
      expect(writing.dependsOnSeq).toEqual([2])
    }
  })

  it('「模拟失败」目标在 research 子任务 prompt 中注入 mock:failure 标记', () => {
    const plan = buildMockPlan('模拟失败：测试依赖阻断')
    expectValidPlan(plan)
    const research = plan.subtasks.find((task) => task.kind === 'research') as PlannedSubTask
    expect(research.prompt.toLowerCase()).toContain('mock:failure')
    // 其它子任务不应携带失败标记
    for (const task of plan.subtasks) {
      if (task.kind !== 'research') {
        expect(task.prompt.toLowerCase()).not.toContain('mock:failure')
      }
    }
  })

  it('空白目标也能生成合法计划（标题回退为「未命名目标」）', () => {
    const plan = buildMockPlan('   ')
    expectValidPlan(plan)
    expect(plan.title).toBe('未命名目标')
    expect(plan.subtasks.map((task) => task.kind)).toEqual([
      'research',
      'analysis',
      'writing',
      'review'
    ])
  })

  it('标题被截断到 40 字符以内', () => {
    const longGoal = '这是一个非常非常长的目标描述，'.repeat(10)
    const plan = buildMockPlan(longGoal)
    expectValidPlan(plan)
    expect(plan.title.length).toBeLessThanOrEqual(40)
  })
})
