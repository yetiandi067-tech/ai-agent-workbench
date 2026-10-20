import type {
  AgentDescriptor,
  AgentRunEventDraft,
  Capability,
  CapabilityState,
  UsageRecord
} from '../../../shared/types'
import {
  TIMEOUT_REASON,
  emptyDiagnostics,
  type AgentAdapter,
  type RunHooks,
  type RunInput,
  type RunOutcome
} from '../types'

/**
 * Mock 适配器：完全不接触外部模型，用来把「任务 → 状态机 → 事件 → 持久化 → 界面」
 * 这条链路跑通，且**不产生任何费用**。
 *
 * 场景通过在 prompt 里写标记来选择，例如 `mock:timeout`。
 * 没有标记时默认 success。
 */
export type MockScenario =
  | 'success'
  | 'streaming'
  | 'failure'
  | 'timeout'
  | 'missing_final'
  | 'usage_estimated'

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  'success',
  'streaming',
  'failure',
  'timeout',
  'missing_final',
  'usage_estimated'
]

export const MOCK_SCENARIO_LABEL: Record<MockScenario, string> = {
  success: '成功返回',
  streaming: '流式文本',
  failure: '模型侧失败',
  timeout: '超时（等待调度器超时中止）',
  missing_final: '缺少最终结果',
  usage_estimated: '带模拟估算金额'
}

const SCENARIO_MARKERS: Array<[string, MockScenario]> = [
  ['mock:streaming', 'streaming'],
  ['mock:failure', 'failure'],
  ['mock:timeout', 'timeout'],
  ['mock:missing_final', 'missing_final'],
  ['mock:missing-final', 'missing_final'],
  ['mock:usage_estimated', 'usage_estimated'],
  ['mock:usage-estimated', 'usage_estimated'],
  ['mock:success', 'success']
]

export function parseMockScenario(prompt: string): MockScenario {
  const lower = prompt.toLowerCase()
  for (const [marker, scenario] of SCENARIO_MARKERS) {
    if (lower.includes(marker)) return scenario
  }
  return 'success'
}

/** 等待 ms 毫秒；若中途被中止则返回 true。 */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(true)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function mockUsage(params: {
  totalTokens: number
  outputTokens: number
  estimatedCost: number | null
  note: string
}): UsageRecord {
  return {
    inputTokens: params.totalTokens - params.outputTokens,
    outputTokens: params.outputTokens,
    totalTokens: params.totalTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    actualCost: null,
    estimatedCost: params.estimatedCost,
    currency: 'CNY',
    source: 'unknown',
    verified: false,
    recordedAt: new Date().toISOString(),
    note: params.note
  }
}

export class MockAdapter implements AgentAdapter {
  readonly id = 'mock'
  readonly name = 'Mock 适配器（本地模拟，无外部调用）'
  readonly mode = 'auto' as const
  readonly isRealCall = false

  private readonly usageByRun = new Map<string, UsageRecord>()

  capabilities(): Record<Capability, CapabilityState> {
    return {
      submit: 'verified',
      result: 'verified',
      status: 'verified',
      cancel: 'verified',
      cost: 'unverified'
    }
  }

  describe(): AgentDescriptor {
    return {
      id: this.id,
      name: this.name,
      adapterId: this.id,
      mode: this.mode,
      isRealCall: false,
      description:
        '本地模拟执行：不启动任何外部进程、不访问网络、不调用任何模型，因此不产生真实费用。' +
        '用于验证任务链路与状态机（支持成功 / 流式 / 失败 / 超时 / 缺少最终结果 / 带估算金额）。',
      capabilities: this.capabilities(),
      availability: 'available',
      availabilityDetail: '内置适配器，随时可用',
      version: 'mock-1.0.0',
      checkedAt: new Date().toISOString(),
      configNote: '场景开关写在任务内容里，例如 mock:timeout、mock:failure、mock:missing_final。'
    }
  }

  async checkAvailability(): Promise<AgentDescriptor> {
    return this.describe()
  }

  async run(input: RunInput, hooks: RunHooks): Promise<RunOutcome> {
    const startedAt = Date.now()
    const scenario = parseMockScenario(input.prompt)
    const sessionId = `mock-session-${input.runId}`

    const emit = (
      type: AgentRunEventDraft['type'],
      rawType: string,
      payload: Record<string, unknown>
    ): void => {
      hooks.onEvent({ type, rawType, payload, receivedAt: new Date().toISOString() })
    }

    const tokenUsage = mockUsage({
      totalTokens: 160,
      outputTokens: 32,
      estimatedCost: scenario === 'usage_estimated' ? 0.0012 : null,
      note:
        (scenario === 'usage_estimated'
          ? '本地模拟数据。金额为**模拟估算值（Mock），非真实账单**，仅用于验证界面如何区分「估算」与「实际」。'
          : '本地模拟数据：token 数为模拟值；未调用外部模型，不产生真实费用。金额仍标注为无法核验。')
    })

    const finish = (
      status: RunOutcome['status'],
      options: {
        finalText?: string | null
        errorCode?: string | null
        errorMessage?: string | null
        failureKind?: RunOutcome['failureKind']
        usage: UsageRecord | null
        userNotice?: string | null
      }
    ): RunOutcome => {
      if (options.usage) this.usageByRun.set(input.runId, options.usage)
      return {
        status,
        sessionId,
        // Mock 不落任何会话目录，避免与真实 DSH 会话目录混淆
        sessionDir: null,
        finalText: options.finalText ?? null,
        exitCode: status === 'succeeded' ? 0 : 1,
        errorCode: options.errorCode ?? null,
        errorMessage: options.errorMessage ?? null,
        failureKind: options.failureKind ?? null,
        durationMs: Date.now() - startedAt,
        usage: options.usage,
        diagnostics: emptyDiagnostics({
          stdoutBytes: 0,
          stdoutLineCount: 0,
          exitCode: status === 'succeeded' ? 0 : 1
        }),
        userNotice: options.userNotice ?? null
      }
    }

    const abortedOutcome = (): RunOutcome => {
      const isTimeout = hooks.signal.reason === TIMEOUT_REASON
      return finish(isTimeout ? 'timed_out' : 'cancelled', {
        errorCode: isTimeout ? 'TIMEOUT' : 'CANCELLED_BY_USER',
        errorMessage: isTimeout
          ? `任务在 ${input.timeoutMs} ms 内未结束（Mock 场景按调度器超时中止）。`
          : '用户取消了本任务（Mock 场景）。',
        failureKind: isTimeout ? 'timeout' : 'cancelled',
        usage: tokenUsage,
        userNotice:
          'Mock 不产生真实费用；但真实 DSH 任务在同样情形下，本地终止并不等于远端停止。'
      })
    }

    emit('session', 'session', { type: 'session', sessionId, cwd: input.cwd, mock: true })
    emit('status', 'status', { type: 'status', phase: 'turn_start', turn: 1, mock: true })
    if (await delay(20, hooks.signal)) return abortedOutcome()
    emit('status', 'status', { type: 'status', phase: 'step_start', turn: 1, step: 1, mock: true })
    emit('thinking', 'thinking', { type: 'thinking', text: '', mock: true })

    if (scenario === 'timeout') {
      // 一直等到调度器触发超时中止为止（可通过把超时时间调小来快速验证）
      while (!(await delay(250, hooks.signal))) {
        emit('thinking', 'thinking', { type: 'thinking', text: '.', mock: true })
      }
      return abortedOutcome()
    }

    const chunks =
      scenario === 'streaming'
        ? ['MOCK', '_STREAM', '_CHUNK_1', '_CHUNK_2', '_CHUNK_3', '_OK']
        : ['MOCK_OK']

    for (const chunk of chunks) {
      if (await delay(scenario === 'streaming' ? 60 : 20, hooks.signal)) return abortedOutcome()
      emit('text', 'text', { type: 'text', text: chunk, mock: true })
    }

    if (scenario === 'failure') {
      emit('status', 'status', {
        type: 'status',
        phase: 'step_end',
        turn: 1,
        step: 1,
        usage: { inputTokens: 128, outputTokens: 32, totalTokens: 160, mock: true }
      })
      emit('usage', 'step_end.usage', {
        inputTokens: 128,
        outputTokens: 32,
        totalTokens: 160,
        mock: true
      })
      emit('error', 'error', {
        type: 'error',
        code: 'MOCK_LLM_ERROR',
        message: '模拟的模型侧错误',
        mock: true
      })
      emit('status', 'status', {
        type: 'status',
        phase: 'turn_end',
        turn: 1,
        reason: { kind: 'error', error: { code: 'MOCK_LLM_ERROR', message: '模拟的模型侧错误' } }
      })
      emit('final', 'final', { type: 'final', text: '' })
      return finish('failed', {
        finalText: '',
        errorCode: 'MOCK_LLM_ERROR',
        errorMessage: '模拟的模型侧错误（Mock 场景：failure）',
        failureKind: 'turn_error',
        usage: tokenUsage
      })
    }

    emit('status', 'status', {
      type: 'status',
      phase: 'step_end',
      turn: 1,
      step: 1,
      usage: { inputTokens: 128, outputTokens: 32, totalTokens: 160, mock: true }
    })
    emit('usage', 'step_end.usage', {
      inputTokens: 128,
      outputTokens: 32,
      totalTokens: 160,
      mock: true
    })
    emit('status', 'status', {
      type: 'status',
      phase: 'turn_end',
      turn: 1,
      reason: { kind: 'completed' }
    })

    if (scenario === 'missing_final') {
      return finish('failed', {
        finalText: null,
        errorCode: 'MISSING_FINAL',
        errorMessage: 'turn_end.reason.kind = "completed"，但 final.text 为空或缺失（Mock 场景：missing_final）',
        failureKind: 'missing_final',
        usage: tokenUsage
      })
    }

    const finalText =
      `MOCK_OK — 这是本地模拟结果，未调用任何外部模型。任务标题：${input.taskId}`

    emit('final', 'final', { type: 'final', text: finalText, mock: true })

    return finish('succeeded', {
      finalText,
      usage: tokenUsage,
      userNotice: '本次为 Mock 执行，未发生任何真实模型调用。'
    })
  }

  getUsage(runId: string): UsageRecord | null {
    return this.usageByRun.get(runId) ?? null
  }
}
