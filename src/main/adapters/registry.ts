import type { AgentDescriptor, AppSettings, Capability, CapabilityState } from '../../shared/types'
import { describeSessionPolicy } from './dsh/dshSession'
import { DshAdapter } from './dsh/DshAdapter'
import { HandoffAdapter } from './handoff/HandoffAdapter'
import { MockAdapter } from './mock/MockAdapter'
import type { AgentAdapter } from './types'

export interface AdapterRegistryDeps {
  getSettings: () => AppSettings
  allowRealCall: () => { allowed: boolean; reason: string }
}

/**
 * 适配器注册表。
 *
 * 具备执行路径的适配器：Mock（本地模拟）、DSH（真实模型，headless CLI）、
 * Trae CN / WorkBuddy（handoff 交接单，纯本地、零费用）。
 * Grok 无任何可用入口（应用已卸载），以「暂不可用」形式登记。
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

    // handoff 适配器：纯本地生成交接单，零费用，不受真实调用总开关约束。
    const traeCn = new HandoffAdapter({
      id: 'trae-cn',
      name: 'Trae CN / Trae Work',
      guide:
        '打开 Trae CN（e:\\trae work\\Trae CN），把上方提示词粘贴到内置对话中执行，' +
        '完成后把最终回答复制回来回填。',
      configNote:
        '实测（trae-cn --help，v3.4.4）：CLI 只有窗口/文件/diff/merge 能力，' +
        'chat 无等待完成、输出格式、--json 等回传开关；' +
        '其内部 agent-tool-host 只开本地命名管道且外部监听已关闭，不作为接入点。'
    })
    this.adapters.set(traeCn.id, traeCn)

    const workbuddy = new HandoffAdapter({
      id: 'workbuddy',
      name: 'WorkBuddy',
      guide:
        '打开 WorkBuddy（e:\\develop\\WorkBuddy），把上方提示词粘贴到对话中执行，' +
        '完成后把最终回答复制回来回填。',
      configNote:
        '实测（5.8.3）：名义上的 codebuddy CLI 两次实测均 MODULE_NOT_FOUND（缺少 ../dist/codebuddy），' +
        '该 CLI 必须在 WorkBuddy 自身沙箱内运行，不逆向 asar、不采用私有接口。'
    })
    this.adapters.set(workbuddy.id, workbuddy)
  }

  get(agentId: string): AgentAdapter | undefined {
    return this.adapters.get(agentId)
  }

  runnable(): AgentAdapter[] {
    return [...this.adapters.values()]
  }

  /** 不具备任何执行路径的 Agent（暂不可用）。 */
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
      mode: 'unavailable',
      isRealCall: false,
      description,
      capabilities: {
        submit: 'unsupported',
        result: 'unsupported',
        status: 'unsupported',
        cancel: 'unsupported',
        cost: 'unsupported'
      },
      availability: 'unavailable',
      availabilityDetail: '本机应用已卸载，无法人工交接或自动执行',
      version: null,
      checkedAt: null,
      configNote
    })

    return [
      unavailable(
        'grok',
        'Grok',
        '本机应用已卸载（2026-10-21 探测：安装目录与 grok-app.exe 均不存在，仅剩注册表残留与 WebView2 缓存）。',
        `历史版本（0.2.40）曾发现本机回环 HTTP 接口 + bearer 令牌，但接口未文档化且令牌属凭据，` +
          `本工作台不发送任何请求、不读取任何凭据文件。` +
          `会话目录说明：${describeSessionPolicy(settings.dshHomeDir)}`
      )
    ]
  }

  descriptors(): AgentDescriptor[] {
    return [...this.runnable().map((adapter) => adapter.describe()), ...this.staticDescriptors()]
  }
}

/** 静态 Agent 的能力表（供界面展示，与上面的描述保持一致）。 */
export const STATIC_AGENT_IDS = ['grok'] as const

export const STATIC_AGENT_CAPABILITIES: Record<Capability, CapabilityState> = {
  submit: 'unverified',
  result: 'unsupported',
  status: 'unsupported',
  cancel: 'unsupported',
  cost: 'unsupported'
}
