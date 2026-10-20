import type { AgentDescriptor, AppSettings, Capability, CapabilityState } from '../../shared/types'
import { describeSessionPolicy } from './dsh/dshSession'
import { DshAdapter } from './dsh/DshAdapter'
import { MockAdapter } from './mock/MockAdapter'
import type { AgentAdapter } from './types'

export interface AdapterRegistryDeps {
  getSettings: () => AppSettings
  allowRealCall: () => { allowed: boolean; reason: string }
}

/**
 * 适配器注册表。
 *
 * 只有 Mock 与 DSH 具备真正可执行的适配器；其余已审计的客户端在本阶段
 * **没有执行路径**，以「仅描述」的形式登记，避免出现「看起来能用其实不能」的假象。
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>()

  constructor(private readonly deps: AdapterRegistryDeps) {
    this.refresh()
  }

  /** 设置变更后重建适配器（例如 CLI 路径改了）。 */
  refresh(): void {
    const settings = this.deps.getSettings()
    this.adapters.clear()

    const mock = new MockAdapter()
    this.adapters.set(mock.id, mock)

    const dsh = new DshAdapter({
      exePath: settings.dshExePath,
      cliScript: settings.dshCliScript,
      profile: settings.dshProfile,
      dshHomeDir: settings.dshHomeDir,
      allowRealCall: this.deps.allowRealCall
    })
    this.adapters.set(dsh.id, dsh)
  }

  get(agentId: string): AgentAdapter | undefined {
    return this.adapters.get(agentId)
  }

  runnable(): AgentAdapter[] {
    return [...this.adapters.values()]
  }

  /** 不具备执行路径的 Agent（人工交接 / 暂不可用）。 */
  staticDescriptors(): AgentDescriptor[] {
    const settings = this.deps.getSettings()
    const unavailable = (
      id: string,
      name: string,
      description: string,
      configNote: string
    ): AgentDescriptor => ({
      id,
      name,
      adapterId: id,
      mode: 'handoff',
      isRealCall: true,
      description,
      capabilities: {
        submit: 'unverified',
        result: 'unsupported',
        status: 'unsupported',
        cancel: 'unsupported',
        cost: 'unsupported'
      },
      availability: 'unavailable',
      availabilityDetail: '本阶段未实现执行路径（需人工交接）',
      version: null,
      checkedAt: null,
      configNote
    })

    return [
      unavailable(
        'trae-cn',
        'Trae CN / Trae Work',
        '本机已安装（VS Code 1.107.1 内核），CLI 有 `chat` 子命令，但没有任何结果回传通道。',
        '只能做「复制提示词 → 人工粘贴」，帮助里没有等待完成 / 输出格式 / --json 等开关；' +
          '其内部 agent-tool-host 只开本地命名管道且外部监听已关闭，不作为接入点。'
      ),
      unavailable(
        'workbuddy',
        'WorkBuddy',
        '本机已安装（5.8.3），名义上有 codebuddy CLI，但实测**不可独立调用**。',
        '两次实测均 MODULE_NOT_FOUND（缺少 ../dist/codebuddy）：该 CLI 必须在 WorkBuddy 自身沙箱内运行，' +
          '不建议逆向 asar。'
      ),
      unavailable(
        'grok',
        'Grok',
        '本机已安装（0.2.40），发现本机回环 HTTP 接口 + bearer 令牌，但接口未文档化、端口与令牌随进程变化。',
        `接口未文档化且令牌属凭据，本阶段不发送任何请求、不读取任何凭据文件。` +
          `会话目录说明：${describeSessionPolicy(settings.dshHomeDir)}`
      )
    ]
  }

  descriptors(): AgentDescriptor[] {
    return [...this.runnable().map((adapter) => adapter.describe()), ...this.staticDescriptors()]
  }
}

/** 静态 Agent 的能力表（供界面展示，与上面的描述保持一致）。 */
export const STATIC_AGENT_IDS = ['trae-cn', 'workbuddy', 'grok'] as const

export const STATIC_AGENT_CAPABILITIES: Record<Capability, CapabilityState> = {
  submit: 'unverified',
  result: 'unsupported',
  status: 'unsupported',
  cancel: 'unsupported',
  cost: 'unsupported'
}
