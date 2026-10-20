import { describe, expect, it } from 'vitest'

import { MockAdapter, parseMockScenario } from '../src/main/adapters/mock/MockAdapter'
import { CANCEL_REASON, TIMEOUT_REASON, type RunHooks, type RunOutcome } from '../src/main/adapters/types'
import type { AgentRunEventDraft } from '../src/shared/types'

/**
 * Mock 适配器测试。
 *
 * 关键约束：Mock **不接触任何外部模型**，因此这些测试不产生任何真实费用，
 * 也不需要凭据 —— 应用启动与基础流程验证都优先走 Mock。
 */
async function runMock(
  adapter: MockAdapter,
  prompt: string,
  options: { timeoutMs?: number; abortAfterMs?: number; abortReason?: string } = {}
): Promise<{ outcome: RunOutcome; events: AgentRunEventDraft[] }> {
  const controller = new AbortController()
  const events: AgentRunEventDraft[] = []
  const hooks: RunHooks = {
    onEvent: (event) => events.push(event),
    signal: controller.signal
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  if (options.abortAfterMs !== undefined) {
    timer = setTimeout(
      () => controller.abort(options.abortReason ?? TIMEOUT_REASON),
      options.abortAfterMs
    )
  }
  try {
    const outcome = await adapter.run(
      {
        taskId: 'task-test',
        runId: 'run-test',
        prompt,
        cwd: 'E:\\ai个人工作台\\workspace',
        timeoutMs: options.timeoutMs ?? 120_000
      },
      hooks
    )
    return { outcome, events }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('Mock 场景识别', () => {
  it('没有标记时默认 success', () => {
    expect(parseMockScenario('随便写点什么')).toBe('success')
  })

  it('识别各类标记', () => {
    expect(parseMockScenario('mock:streaming 流式')).toBe('streaming')
    expect(parseMockScenario('mock:failure')).toBe('failure')
    expect(parseMockScenario('mock:timeout')).toBe('timeout')
    expect(parseMockScenario('mock:missing_final')).toBe('missing_final')
    expect(parseMockScenario('mock:missing-final')).toBe('missing_final')
    expect(parseMockScenario('mock:usage_estimated')).toBe('usage_estimated')
    expect(parseMockScenario('mock:usage-estimated')).toBe('usage_estimated')
  })
})

describe('Mock 适配器 —— 六个场景', () => {
  it('成功返回：状态 succeeded，finalText 含 MOCK_OK，且不产生真实费用', async () => {
    const adapter = new MockAdapter()
    const { outcome, events } = await runMock(adapter, 'mock:success 测试任务')

    expect(outcome.status).toBe('succeeded')
    expect(outcome.finalText).toContain('MOCK_OK')
    expect(outcome.exitCode).toBe(0)
    expect(outcome.failureKind).toBeNull()
    // 与真实调用形状一致：金额为 null，绝不用 0 冒充
    expect(outcome.usage?.actualCost).toBeNull()
    expect(outcome.usage?.estimatedCost).toBeNull()
    expect(outcome.usage?.verified).toBe(false)
    expect(outcome.usage?.source).toBe('unknown')
    // 事件流含 session / status / thinking / text / usage / final
    const types = events.map((event) => event.type)
    expect(types).toContain('session')
    expect(types).toContain('status')
    expect(types).toContain('text')
    expect(types).toContain('final')
  })

  it('流式文本：产生多个 text 事件', async () => {
    const adapter = new MockAdapter()
    const { outcome, events } = await runMock(adapter, 'mock:streaming')
    const textChunks = events.filter((event) => event.type === 'text')
    expect(textChunks.length).toBeGreaterThan(1)
    expect(outcome.status).toBe('succeeded')
    expect(outcome.finalText).toContain('MOCK_OK')
  })

  it('失败：状态 failed，failureKind 为 turn_error', async () => {
    const adapter = new MockAdapter()
    const { outcome, events } = await runMock(adapter, 'mock:failure')

    expect(outcome.status).toBe('failed')
    expect(outcome.failureKind).toBe('turn_error')
    expect(outcome.errorCode).toBe('MOCK_LLM_ERROR')
    expect(outcome.exitCode).toBe(1)
    expect(events.some((event) => event.type === 'error')).toBe(true)
  })

  it('超时：等待调度器中止后标记 timed_out（不谎称远端已停止）', async () => {
    const adapter = new MockAdapter()
    const { outcome } = await runMock(adapter, 'mock:timeout', {
      timeoutMs: 150,
      abortAfterMs: 150,
      abortReason: TIMEOUT_REASON
    })

    expect(outcome.status).toBe('timed_out')
    expect(outcome.failureKind).toBe('timeout')
    expect(outcome.errorCode).toBe('TIMEOUT')
    expect(outcome.userNotice).toContain('远端')
  })

  it('取消：中止信号为 cancel 时标记 cancelled', async () => {
    const adapter = new MockAdapter()
    const { outcome } = await runMock(adapter, 'mock:success', {
      abortAfterMs: 25,
      abortReason: CANCEL_REASON
    })

    expect(outcome.status).toBe('cancelled')
    expect(outcome.failureKind).toBe('cancelled')
  })

  it('缺失最终结果：completed 语义下缺 final，判定 missing_final', async () => {
    const adapter = new MockAdapter()
    const { outcome } = await runMock(adapter, 'mock:missing_final')

    expect(outcome.status).toBe('failed')
    expect(outcome.failureKind).toBe('missing_final')
    expect(outcome.errorCode).toBe('MISSING_FINAL')
    expect(outcome.finalText).toBeNull()
  })

  it('带模拟估算金额：token 存在、金额未知，估算值被明确标注为模拟', async () => {
    const adapter = new MockAdapter()
    const { outcome } = await runMock(adapter, 'mock:usage_estimated')

    expect(outcome.usage?.totalTokens).toBe(160)
    expect(outcome.usage?.actualCost).toBeNull()
    expect(outcome.usage?.verified).toBe(false)
    expect(outcome.usage?.estimatedCost).toBeCloseTo(0.0012, 6)
    expect(outcome.usage?.note).toContain('非真实账单')
  })

  it('getUsage 只能取到执行期观测到的用量', async () => {
    const adapter = new MockAdapter()
    await runMock(adapter, 'mock:success')
    const { outcome } = await runMock(adapter, 'mock:success')
    expect(adapter.getUsage('run-test')?.totalTokens).toBe(outcome.usage?.totalTokens ?? 160)
    expect(adapter.getUsage('不存在的 run')).toBeNull()
  })
})

describe('Mock 适配器 —— 描述与能力', () => {
  it('声明为不产生费用的可自动执行 Agent', () => {
    const adapter = new MockAdapter()
    const descriptor = adapter.describe()
    expect(adapter.isRealCall).toBe(false)
    expect(descriptor.mode).toBe('auto')
    expect(descriptor.isRealCall).toBe(false)
    expect(descriptor.capabilities.submit).toBe('verified')
    // 成本能力仍是未验证：Mock 也不能编造真实账单
    expect(descriptor.capabilities.cost).toBe('unverified')
  })

  it('checkAvailability 不启动任何外部进程，仅返回描述', async () => {
    const adapter = new MockAdapter()
    const descriptor = await adapter.checkAvailability()
    expect(descriptor.availability).toBe('available')
  })
})
