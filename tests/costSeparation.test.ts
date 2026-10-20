import { describe, expect, it } from 'vitest'

import { buildUsage } from '../src/main/adapters/dsh/DshAdapter'
import { parseDshNdjson } from '../src/main/adapters/dsh/ndjson'
import {
  AUTO_RETRY_ENABLED,
  COST_UNVERIFIED_TEXT,
  COST_VERIFIABLE_WITH_CURRENT_ADAPTERS,
  REMOTE_NOT_STOPPED_WARNING
} from '../src/shared/types'

/**
 * 费用与用量分离测试。
 *
 * 这一组断言的目的是把第 2.5 步的实测结论**固化进代码**，防止以后有人「顺手」
 * 把账本差值 0 当成免费、或把历史单价推算的金额写进真实费用字段。
 */
const REAL_SUCCESS_STDOUT = [
  '{"type":"session","sessionId":"session-811d3a35-1921-41ec-b760-7d351695846f","cwd":"C:\\\\Temp"}',
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"status","phase":"step_start","turn":1,"step":1}',
  '{"type":"text","text":"AGENT_PROBE_OK"}',
  '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":6068,"outputTokens":6,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":6074}}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
  '{"type":"final","text":"AGENT_PROBE_OK"}'
].join('\n')

describe('token 用量：可信', () => {
  it('token 数来自 NDJSON 的 step_end.usage', () => {
    const { state } = parseDshNdjson(REAL_SUCCESS_STDOUT)
    const usage = buildUsage(state.usage, '2026-10-20T18:00:00.000Z')
    expect(usage.inputTokens).toBe(6068)
    expect(usage.outputTokens).toBe(6)
    expect(usage.totalTokens).toBe(6074)
  })
})

describe('实际费用：无法核验，绝不用 0 冒充', () => {
  it('actualCost 必须是 null（而不是 0，也不是历史单价推算值）', () => {
    const { state } = parseDshNdjson(REAL_SUCCESS_STDOUT)
    const usage = buildUsage(state.usage, '2026-10-20T18:00:00.000Z')

    expect(usage.actualCost).toBeNull()
    expect(usage.actualCost).not.toBe(0)
    expect(usage.source).toBe('unknown')
    expect(usage.verified).toBe(false)
    expect(COST_VERIFIABLE_WITH_CURRENT_ADAPTERS).toBe(false)
    expect(COST_UNVERIFIED_TEXT).toBe('无法核验')
  })

  it('没有可靠单价来源时不生成估算金额', () => {
    const { state } = parseDshNdjson(REAL_SUCCESS_STDOUT)
    const usage = buildUsage(state.usage, '2026-10-20T18:00:00.000Z')
    expect(usage.estimatedCost).toBeNull()
  })

  it('note 明确说明账本差值不能解释为免费', () => {
    const { state } = parseDshNdjson(REAL_SUCCESS_STDOUT)
    const usage = buildUsage(state.usage, '2026-10-20T18:00:00.000Z')
    expect(usage.note).toContain('不能把该差值解释为「免费」')
  })

  it('即使读不到 usage，金额仍为 null，token 为 null', () => {
    const usage = buildUsage(null, '2026-10-20T18:00:00.000Z')
    expect(usage.totalTokens).toBeNull()
    expect(usage.actualCost).toBeNull()
    expect(usage.estimatedCost).toBeNull()
    expect(usage.verified).toBe(false)
  })

  it('金额来源只允许 ndjson / ledger / unknown 三种取值', () => {
    const { state } = parseDshNdjson(REAL_SUCCESS_STDOUT)
    const usage = buildUsage(state.usage, '2026-10-20T18:00:00.000Z')
    expect(['ndjson', 'ledger', 'unknown']).toContain(usage.source)
  })
})

describe('安全护栏常量', () => {
  it('自动重试固定关闭', () => {
    expect(AUTO_RETRY_ENABLED).toBe(false)
  })

  it('本地终止的告警明确说明远端可能未停止', () => {
    expect(REMOTE_NOT_STOPPED_WARNING).toContain('远端请求可能仍在运行')
  })
})
