import { describe, expect, it } from 'vitest'

import {
  classifyDshOutcome,
  DshStreamAccumulator,
  mapDshEventType,
  parseDshNdjson
} from '../src/main/adapters/dsh/ndjson'

/**
 * 夹具来源：第 2.5 步的真实成功输出（原样照抄，仅用于测试，绝不写入生产运行记录）。
 * 见 docs/DSH_ADAPTER_PROBE.md「成功态 stdout」一节。
 */
const REAL_SUCCESS_STDOUT = [
  '{"type":"session","sessionId":"session-811d3a35-1921-41ec-b760-7d351695846f","cwd":"C:\\\\Users\\\\Lenovo\\\\AppData\\\\Local\\\\Temp\\\\agent-workbench-probe"}',
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"status","phase":"step_start","turn":1,"step":1}',
  '{"type":"thinking","text":""}',
  '{"type":"text","text":"AGENT_PROBE_OK"}',
  '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":6068,"outputTokens":6,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":6074}}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
  '{"type":"final","text":"AGENT_PROBE_OK"}'
].join('\n')

/** 夹具来源：第 2 步的失败态输出（MISSING_CREDENTIAL）。 */
const CREDENTIAL_FAILURE_STDOUT = [
  '{"type":"session","sessionId":"session-31412591-0f9c-4afd-90a6-4f9e3ac176d6","cwd":"C:\\\\Temp"}',
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"status","phase":"step_start","turn":1,"step":1}',
  '{"type":"status","phase":"step_end","turn":1,"step":1}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"no API key","code":"MISSING_CREDENTIAL"}}}',
  '{"type":"final","text":""}'
].join('\n')

describe('DSH NDJSON 解析（真实成功夹具）', () => {
  it('解析出会话、最终文本与 token 用量', () => {
    const { state, events } = parseDshNdjson(REAL_SUCCESS_STDOUT)

    expect(state.sessionId).toBe('session-811d3a35-1921-41ec-b760-7d351695846f')
    expect(state.finalText).toBe('AGENT_PROBE_OK')
    expect(state.turnEndKind).toBe('completed')
    expect(state.sawTurnEnd).toBe(true)
    expect(state.lineCount).toBe(8)
    expect(state.invalidLineCount).toBe(0)
    expect(state.usage?.totalTokens).toBe(6074)
    expect(state.usage?.inputTokens).toBe(6068)
    expect(state.usage?.outputTokens).toBe(6)
    // 8 行事件 + 1 个由 step_end.usage 派生出的 usage 事件
    expect(events).toHaveLength(9)
  })

  it('把 step_end 的 usage 派生为独立的 usage 事件', () => {
    const { events } = parseDshNdjson(REAL_SUCCESS_STDOUT)
    const usageEvents = events.filter((event) => event.type === 'usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].rawType).toBe('step_end.usage')
    expect(usageEvents[0].payload.totalTokens).toBe(6074)
  })

  it('classifyDshOutcome 判定为成功', () => {
    const { state } = parseDshNdjson(REAL_SUCCESS_STDOUT)
    const outcome = classifyDshOutcome(state)
    expect(outcome.ok).toBe(true)
    expect(outcome.failureKind).toBeNull()
  })

  it('保留原始事件（原始 type 与 payload 都未改写）', () => {
    const { events } = parseDshNdjson(REAL_SUCCESS_STDOUT)
    const textEvent = events.find((event) => event.type === 'text')
    expect(textEvent?.rawType).toBe('text')
    expect(textEvent?.payload).toEqual({ type: 'text', text: 'AGENT_PROBE_OK' })
  })
})

describe('DSH NDJSON 失败态与边界', () => {
  it('turn_end.reason.kind = error 时判定为失败并保留错误码', () => {
    const { state } = parseDshNdjson(CREDENTIAL_FAILURE_STDOUT)
    expect(state.turnEndKind).toBe('error')
    expect(state.errorCode).toBe('MISSING_CREDENTIAL')
    const outcome = classifyDshOutcome(state)
    expect(outcome.ok).toBe(false)
    expect(outcome.failureKind).toBe('turn_error')
  })

  it('缺少 final.text（但 completed）判定为 missing_final', () => {
    const stdout = [
      '{"type":"status","phase":"turn_start","turn":1}',
      '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
      '{"type":"final","text":""}'
    ].join('\n')
    const { state } = parseDshNdjson(stdout)
    const outcome = classifyDshOutcome(state)
    expect(outcome.ok).toBe(false)
    expect(outcome.failureKind).toBe('missing_final')
  })

  it('没有任何 turn_end 判定为 invalid_output', () => {
    const { state } = parseDshNdjson('{"type":"session","sessionId":"s1"}')
    const outcome = classifyDshOutcome(state)
    expect(outcome.ok).toBe(false)
    expect(outcome.failureKind).toBe('invalid_output')
  })

  it('未知事件类型不会崩溃，且归入 unknown 并保留原始对象', () => {
    const accumulator = new DshStreamAccumulator()
    const events = accumulator.pushLine('{"type":"future_event","payload":{"x":1}}')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('unknown')
    expect(events[0].rawType).toBe('future_event')
    expect(events[0].payload).toEqual({ type: 'future_event', payload: { x: 1 } })
    expect(accumulator.snapshot.unknownTypeCount).toBe(1)
  })

  it('无效行只计数、不抛错，也不丢弃整个流', () => {
    const stdout = ['不是 JSON 的一行', '{"type":"final","text":"OK"}'].join('\n')
    const { state } = parseDshNdjson(stdout)
    expect(state.invalidLineCount).toBe(1)
    expect(state.invalidLines[0]).toContain('不是 JSON')
    expect(state.finalText).toBe('OK')
  })

  it('全是无效行的输出判定为 invalid_output', () => {
    const { state } = parseDshNdjson('not json 1\nnot json 2')
    const outcome = classifyDshOutcome(state)
    expect(outcome.ok).toBe(false)
    expect(outcome.failureKind).toBe('invalid_output')
  })

  it('mapDshEventType 覆盖已知类型并兜底 unknown', () => {
    expect(mapDshEventType('session')).toBe('session')
    expect(mapDshEventType('status')).toBe('status')
    expect(mapDshEventType('thinking')).toBe('thinking')
    expect(mapDshEventType('text')).toBe('text')
    expect(mapDshEventType('final')).toBe('final')
    expect(mapDshEventType('error')).toBe('error')
    expect(mapDshEventType('something-new')).toBe('unknown')
  })
})
