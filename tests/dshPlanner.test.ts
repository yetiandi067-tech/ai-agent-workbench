import { describe, expect, it } from 'vitest'

import {
  extractJson,
  validatePlannerOutput
} from '../src/main/planner/dshPlanner'
import { SUB_TASK_KINDS } from '../src/shared/types'

/** 最小合法输出，便于各用例按需改写。 */
function validOutput(overrides: Record<string, unknown> = {}): unknown {
  return {
    title: '调研本地大模型',
    subtasks: [
      {
        seq: 1,
        kind: SUB_TASK_KINDS[0],
        title: '资料收集',
        description: '收集资料',
        prompt: '请收集本地大模型相关资料。',
        acceptance: '输出资料清单',
        agentId: 'mock',
        dependsOnSeq: []
      },
      {
        seq: 2,
        kind: SUB_TASK_KINDS[1],
        title: '分析',
        description: '分析资料',
        prompt: '请分析收集到的资料。',
        acceptance: '输出分析结论',
        agentId: 'mock',
        dependsOnSeq: [1]
      }
    ],
    ...overrides
  }
}

const agents = [{ id: 'mock' }, { id: 'dsh' }]

describe('DshPlanner：输出 JSON 抽取', () => {
  it('纯 JSON 直接解析', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('markdown 代码围栏可剥离', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('前后夹杂文字时兜底取首个对象', () => {
    expect(extractJson('下面是结果：\n{"a":1}\n以上。')).toEqual({ a: 1 })
  })
  it('空文本抛出 PLAN_OUTPUT_INVALID', () => {
    expect(() => extractJson('')).toThrow('PLAN_OUTPUT_INVALID')
  })
  it('非 JSON 文本抛出 PLAN_OUTPUT_INVALID', () => {
    expect(() => extractJson('没有任何 JSON')).toThrow('PLAN_OUTPUT_INVALID')
  })
})

describe('DshPlanner：输出结构校验', () => {
  it('合法输出通过校验', () => {
    const draft = validatePlannerOutput(validOutput(), agents)
    expect(draft.subtasks).toHaveLength(2)
    expect(draft.subtasks[1].dependsOnSeq).toEqual([1])
  })

  it('顶层不是对象被拒绝', () => {
    expect(() => validatePlannerOutput([1, 2], agents)).toThrow('PLAN_OUTPUT_INVALID')
  })

  it('subtasks 不是数组被拒绝', () => {
    expect(() => validatePlannerOutput(validOutput({ subtasks: 'x' }), agents)).toThrow(
      'PLAN_OUTPUT_INVALID'
    )
  })

  it('子任务数量为 0 被拒绝', () => {
    expect(() => validatePlannerOutput(validOutput({ subtasks: [] }), agents)).toThrow(
      'PLAN_OUTPUT_INVALID'
    )
  })

  it('子任务数量超过上限被拒绝', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      seq: i + 1,
      kind: SUB_TASK_KINDS[0],
      title: `t${i}`,
      description: 'd',
      prompt: 'p',
      acceptance: 'a',
      agentId: 'mock',
      dependsOnSeq: []
    }))
    expect(() => validatePlannerOutput(validOutput({ subtasks: many }), agents)).toThrow(
      'PLAN_OUTPUT_INVALID'
    )
  })

  it('seq 重复被拒绝', () => {
    const out = validOutput()
    ;(out as Record<string, unknown>).subtasks = [
      { seq: 1, kind: SUB_TASK_KINDS[0], title: 'a', description: 'd', prompt: 'p', acceptance: 'a', agentId: 'mock', dependsOnSeq: [] },
      { seq: 1, kind: SUB_TASK_KINDS[0], title: 'b', description: 'd', prompt: 'p', acceptance: 'a', agentId: 'mock', dependsOnSeq: [] }
    ]
    expect(() => validatePlannerOutput(out, agents)).toThrow('PLAN_OUTPUT_INVALID')
  })

  it('seq 非连续被拒绝', () => {
    const out = validOutput()
    ;(out as Record<string, unknown>).subtasks = [
      { seq: 1, kind: SUB_TASK_KINDS[0], title: 'a', description: 'd', prompt: 'p', acceptance: 'a', agentId: 'mock', dependsOnSeq: [] },
      { seq: 3, kind: SUB_TASK_KINDS[0], title: 'b', description: 'd', prompt: 'p', acceptance: 'a', agentId: 'mock', dependsOnSeq: [1] }
    ]
    expect(() => validatePlannerOutput(out, agents)).toThrow('PLAN_OUTPUT_INVALID')
  })

  it('非法 kind 被拒绝', () => {
    const out = validOutput()
    const tasks = (out as { subtasks: Array<Record<string, unknown>> }).subtasks
    tasks[0].kind = 'invalid-kind'
    expect(() => validatePlannerOutput(out, agents)).toThrow('PLAN_OUTPUT_INVALID')
  })

  it('前向依赖（依赖更大 seq）被拒绝', () => {
    const out = validOutput()
    const tasks = (out as { subtasks: Array<Record<string, unknown>> }).subtasks
    tasks[0].dependsOnSeq = [2] // #1 依赖 #2
    expect(() => validatePlannerOutput(out, agents)).toThrow('PLAN_OUTPUT_INVALID')
  })

  it('循环依赖被拒绝（通过前向依赖规则自动覆盖）', () => {
    const out = validOutput()
    const tasks = (out as { subtasks: Array<Record<string, unknown>> }).subtasks
    tasks[0].dependsOnSeq = [2]
    expect(() => validatePlannerOutput(out, agents)).toThrow('PLAN_OUTPUT_INVALID')
  })

  it('未注册的 agentId 被拒绝', () => {
    const out = validOutput()
    const tasks = (out as { subtasks: Array<Record<string, unknown>> }).subtasks
    tasks[0].agentId = 'grok'
    expect(() => validatePlannerOutput(out, agents)).toThrow('PLAN_OUTPUT_INVALID')
  })

  it('空 title 被拒绝', () => {
    const out = validOutput()
    const tasks = (out as { subtasks: Array<Record<string, unknown>> }).subtasks
    tasks[0].title = ''
    expect(() => validatePlannerOutput(out, agents)).toThrow('PLAN_OUTPUT_INVALID')
  })
})
