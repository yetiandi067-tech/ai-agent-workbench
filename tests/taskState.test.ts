import { describe, expect, it } from 'vitest'

import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canStart,
  canTransition,
  describeTransition,
  explainCannotStart,
  IllegalTransitionError,
  isTerminalStatus
} from '../src/shared/task-state'
import { TERMINAL_STATUSES, type TaskStatus } from '../src/shared/types'

describe('任务状态机 —— 合法转换', () => {
  it('pending 只能进入 running / cancelled / failed', () => {
    expect(canTransition('pending', 'running')).toBe(true)
    expect(canTransition('pending', 'cancelled')).toBe(true)
    expect(canTransition('pending', 'failed')).toBe(true)
    expect(canTransition('pending', 'succeeded')).toBe(false)
  })

  it('running 可以进入所有终态', () => {
    for (const target of ['succeeded', 'failed', 'timed_out', 'cancelled', 'needs_confirmation'] as TaskStatus[]) {
      expect(canTransition('running', target)).toBe(true)
    }
  })

  it('终态没有出边（不会倒退、也不会重复执行）；needs_confirmation 例外：仅允许人工回填', () => {
    for (const terminal of TERMINAL_STATUSES) {
      if (terminal === 'needs_confirmation') {
        // 人工回填出边：只允许显式转为 succeeded / failed
        expect(canTransition('needs_confirmation', 'succeeded')).toBe(true)
        expect(canTransition('needs_confirmation', 'failed')).toBe(true)
        expect(canTransition('needs_confirmation', 'running')).toBe(false)
        expect(canTransition('needs_confirmation', 'pending')).toBe(false)
        expect(canTransition('needs_confirmation', 'timed_out')).toBe(false)
        continue
      }
      expect(ALLOWED_TRANSITIONS[terminal]).toHaveLength(0)
      for (const target of ['running', 'pending'] as TaskStatus[]) {
        expect(canTransition(terminal, target)).toBe(false)
      }
    }
  })
})

describe('任务状态机 —— 非法转换与守卫', () => {
  it('assertTransition 合法时返回目标状态', () => {
    expect(assertTransition('pending', 'running')).toBe('running')
    expect(assertTransition('running', 'succeeded')).toBe('succeeded')
  })

  it('从终态转换会抛 IllegalTransitionError', () => {
    expect(() => assertTransition('succeeded', 'running')).toThrow(IllegalTransitionError)
  })

  it('相同状态之间的转换被拒绝（重复执行请求）', () => {
    expect(() => assertTransition('running', 'running')).toThrow(IllegalTransitionError)
  })

  it('describeTransition 给出可诊断原因', () => {
    expect(describeTransition('succeeded', 'running')).toContain('终态')
    expect(describeTransition('running', 'running')).toContain('重复执行')
  })

  it('只有 pending 允许被启动', () => {
    expect(canStart('pending')).toBe(true)
    expect(canStart('running')).toBe(false)
    expect(canStart('succeeded')).toBe(false)
    expect(explainCannotStart('running')).toContain('已经在执行中')
    expect(explainCannotStart('failed')).toContain('终态')
  })

  it('isTerminalStatus 与 TERMINAL_STATUSES 一致', () => {
    expect(isTerminalStatus('pending')).toBe(false)
    expect(isTerminalStatus('running')).toBe(false)
    for (const terminal of TERMINAL_STATUSES) expect(isTerminalStatus(terminal)).toBe(true)
  })
})
