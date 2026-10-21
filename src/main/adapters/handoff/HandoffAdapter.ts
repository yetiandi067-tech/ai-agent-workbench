import type {
  AgentDescriptor,
  Capability,
  CapabilityState,
  UsageRecord
} from '../../../shared/types'
import {
  emptyDiagnostics,
  type AgentAdapter,
  type RunHooks,
  type RunInput,
  type RunOutcome
} from '../types'

/**
 * 人工交接（handoff）适配器。
 *
 * 适用对象：本机已安装、但**没有官方 headless / CLI 编程接口**的 Agent
 * （阶段 4 探测结论：Trae CN 的 chat 子命令无结果回传通道；WorkBuddy 的
 * codebuddy CLI 必须在其自身沙箱内运行，无法独立调用）。
 *
 * 行为约定：
 * - `run()` 不启动任何子进程、不调用任何模型、不产生费用（isRealCall=false）；
 * - `run()` 的产物是一份**结构化交接单**：可复制的完整提示词 + 验收标准 +
 *   目标工具指引 + 回填指引；
 * - 任务落为 `needs_confirmation`（待人工确认），等待用户在任务详情中
 *   「回填人工执行结果」（succeeded / failed，见 task-state.ts 的出边）。
 */
export class HandoffAdapter implements AgentAdapter {
  readonly id: string
  readonly name: string
  readonly mode = 'handoff' as const
  readonly isRealCall = false

  constructor(
    private readonly config: {
      id: string
      name: string
      /** 目标工具说明（如何把提示词交给人工作业）。 */
      guide: string
      /** 接入说明 / 已知限制（来自实测探测结论）。 */
      configNote: string
    }
  ) {
    this.id = config.id
    this.name = config.name
  }

  capabilities(): Record<Capability, CapabilityState> {
    return {
      submit: 'verified', // 交接单生成（本地、确定性）本身可验证
      result: 'unsupported', // 结果由人工回填，不走适配器
      status: 'unsupported',
      cancel: 'unsupported',
      cost: 'unsupported'
    }
  }

  describe(): AgentDescriptor {
    return {
      id: this.id,
      name: this.name,
      adapterId: this.id,
      mode: 'handoff',
      isRealCall: false,
      description: `本机已安装，但没有可编程执行入口：只能生成人工交接单，由用户在目标工具中手动完成。${this.config.guide}`,
      capabilities: this.capabilities(),
      availability: 'available',
      availabilityDetail: '本机已安装；仅支持人工交接（无 headless 接口），执行 = 生成交接单。',
      version: null,
      checkedAt: null,
      configNote: this.config.configNote
    }
  }

  async checkAvailability(): Promise<AgentDescriptor> {
    return this.describe()
  }

  async run(input: RunInput, hooks: RunHooks): Promise<RunOutcome> {
    const startedMs = Date.now()
    const handoff = [
      '====== 人工交接单（handoff）======',
      `目标工具：${this.name}`,
      `任务标题：${input.taskTitle ?? '（未命名）'}`,
      '',
      '—— 任务提示词（复制到目标工具）——',
      input.prompt,
      '',
      '—— 验收标准 ——',
      input.acceptance?.trim() ? input.acceptance : '以任务提示词中的要求为准。',
      '',
      '—— 目标工具说明 ——',
      this.config.guide,
      '',
      '—— 回填指引 ——',
      '在目标工具中完成本任务后，回到工作台的任务详情，',
      '把最终结果粘贴到「回填人工执行结果」并选择 成功 / 失败。',
      '本任务不启动任何子进程、不调用任何模型、不产生费用。'
    ].join('\n')

    hooks.onEvent({
      type: 'status',
      rawType: 'workbench.handoff_sheet_generated',
      payload: { phase: 'handoff_sheet_generated', agentId: this.id, taskId: input.taskId },
      receivedAt: new Date().toISOString()
    })

    return {
      status: 'needs_confirmation',
      sessionId: null,
      sessionDir: null,
      finalText: handoff,
      exitCode: null,
      errorCode: null,
      errorMessage: null,
      failureKind: null,
      durationMs: Math.max(1, Date.now() - startedMs),
      usage: null,
      diagnostics: emptyDiagnostics(),
      userNotice:
        '交接单已生成：请在目标工具中人工完成，然后回到任务详情回填执行结果（成功 / 失败）。' +
        '本任务不会自动推进。'
    }
  }

  getUsage(_runId: string): UsageRecord | null {
    return null
  }
}
