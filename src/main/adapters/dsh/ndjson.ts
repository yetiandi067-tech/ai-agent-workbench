import type { AgentEventPayload, AgentRunEventDraft, AgentRunEventType } from '../../../shared/types'

/**
 * DSH `--json` 的 NDJSON 解析器。
 *
 * 这是纯函数模块 —— 不碰文件系统、不起子进程，因此可以直接用字符串夹具做单元测试。
 *
 * 已实测的事件流契约（第 2 / 2.5 步）：
 *   session → status(turn_start) → status(step_start) → thinking → text* →
 *   status(step_end, 携带 usage) → status(turn_end, 携带 reason.kind) → final
 *
 * 三条硬性要求：
 * 1. 未知事件类型**不得让任务崩溃** → 归入 `unknown` 并保留原始对象；
 * 2. 无效行（非 JSON）不得丢弃整个流 → 计数 + 保留前若干行样本；
 * 3. 原始事件必须完整保留，便于排查。
 */

export interface DshTokenUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}

export interface DshStreamState {
  sessionId: string | null
  cwd: string | null
  finalText: string | null
  textChunks: string[]
  turnEndKind: string | null
  turnCount: number
  stepCount: number
  errorCode: string | null
  errorMessage: string | null
  usage: DshTokenUsage | null
  lineCount: number
  invalidLineCount: number
  invalidLines: string[]
  unknownTypeCount: number
  sawFinal: boolean
  sawTurnEnd: boolean
}

export function createEmptyDshState(): DshStreamState {
  return {
    sessionId: null,
    cwd: null,
    finalText: null,
    textChunks: [],
    turnEndKind: null,
    turnCount: 0,
    stepCount: 0,
    errorCode: null,
    errorMessage: null,
    usage: null,
    lineCount: 0,
    invalidLineCount: 0,
    invalidLines: [],
    unknownTypeCount: 0,
    sawFinal: false,
    sawTurnEnd: false
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** DSH 原始 type → 统一事件类型（未知类型不抛错）。 */
export function mapDshEventType(rawType: string): AgentRunEventType {
  switch (rawType) {
    case 'session':
      return 'session'
    case 'status':
      return 'status'
    case 'thinking':
      return 'thinking'
    case 'text':
      return 'text'
    case 'final':
      return 'final'
    case 'usage':
      return 'usage'
    case 'error':
      return 'error'
    default:
      return 'unknown'
  }
}

export function extractDshUsage(payload: AgentEventPayload): DshTokenUsage | null {
  const raw = asRecord(payload.usage)
  if (!raw) return null
  return {
    inputTokens: asNumber(raw.inputTokens),
    outputTokens: asNumber(raw.outputTokens),
    totalTokens: asNumber(raw.totalTokens),
    cacheReadTokens: asNumber(raw.cacheReadTokens),
    cacheWriteTokens: asNumber(raw.cacheWriteTokens)
  }
}

/**
 * 增量累积器：子进程逐行喂进来，逐行得到「需要上报的事件」。
 * 派生事件：`step_end` 里携带的 usage 会额外产出一个 `usage` 事件，
 * 这样 UI 与落库都能统一按 `usage` 类型处理，不必再去理解 `status.phase`。
 */
export class DshStreamAccumulator {
  private readonly state: DshStreamState = createEmptyDshState()

  get snapshot(): DshStreamState {
    return this.state
  }

  pushLine(line: string, receivedAt: string = new Date().toISOString()): AgentRunEventDraft[] {
    const trimmed = line.replace(/\r$/, '').trim()
    if (trimmed.length === 0) return []

    this.state.lineCount += 1

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      this.state.invalidLineCount += 1
      if (this.state.invalidLines.length < 5) {
        this.state.invalidLines.push(truncate(trimmed, 200))
      }
      return []
    }

    const payload = asRecord(parsed)
    if (!payload) {
      this.state.invalidLineCount += 1
      if (this.state.invalidLines.length < 5) {
        this.state.invalidLines.push(truncate(trimmed, 200))
      }
      return []
    }

    const rawType = asString(payload.type) ?? '(missing-type)'
    const mapped = mapDshEventType(rawType)
    if (mapped === 'unknown') this.state.unknownTypeCount += 1

    const events: AgentRunEventDraft[] = [
      { type: mapped, rawType, payload, receivedAt }
    ]

    switch (rawType) {
      case 'session': {
        this.state.sessionId = asString(payload.sessionId) ?? this.state.sessionId
        this.state.cwd = asString(payload.cwd) ?? this.state.cwd
        break
      }
      case 'text': {
        const chunk = asString(payload.text)
        if (chunk !== null && chunk.length > 0) this.state.textChunks.push(chunk)
        break
      }
      case 'final': {
        this.state.finalText = asString(payload.text)
        this.state.sawFinal = true
        break
      }
      case 'status': {
        this.applyStatus(payload, receivedAt, events)
        break
      }
      default:
        break
    }

    return events
  }

  private applyStatus(
    payload: AgentEventPayload,
    receivedAt: string,
    events: AgentRunEventDraft[]
  ): void {
    const phase = asString(payload.phase)

    if (phase === 'turn_start') {
      this.state.turnCount += 1
      return
    }

    if (phase === 'step_start') {
      this.state.stepCount += 1
      return
    }

    if (phase === 'step_end') {
      const usage = extractDshUsage(payload)
      if (usage) {
        this.state.usage = usage
        events.push({
          type: 'usage',
          rawType: 'step_end.usage',
          payload: usage as unknown as AgentEventPayload,
          receivedAt
        })
      }
      return
    }

    if (phase === 'turn_end') {
      this.state.sawTurnEnd = true
      const reason = asRecord(payload.reason)
      this.state.turnEndKind = reason ? asString(reason.kind) : null

      const error = reason ? asRecord(reason.error) : null
      if (error) {
        this.state.errorCode = asString(error.code) ?? this.state.errorCode
        this.state.errorMessage = asString(error.message) ?? this.state.errorMessage
      }
      return
    }
  }
}

export interface ParsedDshStream {
  state: DshStreamState
  events: AgentRunEventDraft[]
}

/** 一次性解析整段 stdout（测试与离线复算用；线上走增量累积器）。 */
export function parseDshNdjson(stdout: string): ParsedDshStream {
  const accumulator = new DshStreamAccumulator()
  const events: AgentRunEventDraft[] = []
  for (const line of stdout.split(/\r?\n/)) {
    events.push(...accumulator.pushLine(line))
  }
  return { state: accumulator.snapshot, events }
}

/**
 * 由累积状态推导执行结果。
 * 判定顺序刻意「先失败后成功」，保证任何可疑情况都不会被当成成功。
 */
export function classifyDshOutcome(state: DshStreamState): {
  ok: boolean
  failureKind:
    | 'nonzero_exit'
    | 'invalid_output'
    | 'missing_final'
    | 'turn_error'
    | null
  reason: string
} {
  if (state.turnEndKind === 'error') {
    return {
      ok: false,
      failureKind: 'turn_error',
      reason: `turn_end.reason.kind = "error"（${state.errorCode ?? 'UNKNOWN'}）：${
        state.errorMessage ?? '无错误详情'
      }`
    }
  }

  if (state.invalidLineCount > 0 && !state.sawTurnEnd) {
    return {
      ok: false,
      failureKind: 'invalid_output',
      reason: `stdout 中有 ${state.invalidLineCount} 行不是有效 JSON，且没有观察到 turn_end 事件`
    }
  }

  if (!state.sawTurnEnd) {
    return {
      ok: false,
      failureKind: 'invalid_output',
      reason: '未观察到 turn_end 事件，无法确认这一轮执行是否结束'
    }
  }

  if (state.turnEndKind !== 'completed') {
    return {
      ok: false,
      failureKind: 'invalid_output',
      reason: `turn_end.reason.kind = ${state.turnEndKind ?? '(缺失)'}，既不是 completed 也不是 error`
    }
  }

  if (state.finalText === null || state.finalText.length === 0) {
    return {
      ok: false,
      failureKind: 'missing_final',
      reason: 'turn_end 为 completed，但 final.text 为空或缺失'
    }
  }

  return { ok: true, failureKind: null, reason: 'turn_end.reason.kind = "completed" 且 final.text 非空' }
}
