import { useCallback, useEffect, useState, type ReactNode } from 'react'

import {
  AUTO_RETRY_ENABLED,
  COST_UNVERIFIED_DETAIL,
  COST_UNVERIFIED_TEXT,
  type AppSettings,
  type GuardrailItem,
  type SystemInfo
} from '../../../shared/types'
import { api, errorMessage } from '../api'
import { SkillsPanel } from '../components/SkillsPanel'
import { Card, Section } from '../components/ui'

interface FormState {
  dshExePath: string
  dshCliScript: string
  dshProfile: string
  dshHomeDir: string
  taskCwd: string
  taskTimeoutMs: string
  realConcurrencyLimit: string
  mockConcurrencyLimit: string
  allowRealModelCalls: boolean
}

function toForm(settings: AppSettings): FormState {
  return {
    dshExePath: settings.dshExePath,
    dshCliScript: settings.dshCliScript,
    dshProfile: settings.dshProfile,
    dshHomeDir: settings.dshHomeDir,
    taskCwd: settings.taskCwd,
    taskTimeoutMs: String(settings.taskTimeoutMs),
    realConcurrencyLimit: String(settings.realConcurrencyLimit),
    mockConcurrencyLimit: String(settings.mockConcurrencyLimit),
    allowRealModelCalls: settings.allowRealModelCalls
  }
}

/** 解析非负整数，非法时回退到 fallback（由主进程再做一次范围收敛）。 */
function parseIntOr(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

export default function SettingsPage(): ReactNode {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [guardrails, setGuardrails] = useState<GuardrailItem[]>([])
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextSettings, nextGuardrails, nextInfo] = await Promise.all([
        api.getSettings(),
        api.getGuardrails(),
        api.getSystemInfo()
      ])
      setSettings(nextSettings)
      setForm(toForm(nextSettings))
      setGuardrails(nextGuardrails)
      setInfo(nextInfo)
      setError(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function patchForm(partial: Partial<FormState>): void {
    setForm((prev) => (prev ? { ...prev, ...partial } : prev))
  }

  async function handleSave(): Promise<void> {
    if (!form || !settings) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const patch: Partial<AppSettings> = {
        dshExePath: form.dshExePath.trim(),
        dshCliScript: form.dshCliScript.trim(),
        dshProfile: form.dshProfile.trim(),
        dshHomeDir: form.dshHomeDir.trim(),
        taskCwd: form.taskCwd.trim(),
        taskTimeoutMs: parseIntOr(form.taskTimeoutMs, settings.taskTimeoutMs),
        realConcurrencyLimit: parseIntOr(form.realConcurrencyLimit, settings.realConcurrencyLimit),
        mockConcurrencyLimit: parseIntOr(form.mockConcurrencyLimit, settings.mockConcurrencyLimit),
        allowRealModelCalls: form.allowRealModelCalls
      }
      const updated = await api.updateSettings(patch)
      setSettings(updated)
      setForm(toForm(updated))
      setGuardrails(await api.getGuardrails())
      setNotice('设置已保存。真实任务并发上限、超时时间等限制已按主进程规则收敛。')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  if (error && !form) {
    return <div className="alert error">{error}</div>
  }
  if (!form || !settings) {
    return <p className="muted">加载中…</p>
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>设置</h2>
          <p>工作目录、DSH CLI 路径、超时与安全限制。修改 DSH 路径只影响工作台调用，不会改动 DSH 安装目录或配置。</p>
        </div>
        <div className="btn-row">
          <button className="btn" type="button" onClick={() => void refresh()}>
            重新加载
          </button>
          <button className="btn primary" type="button" disabled={saving} onClick={() => void handleSave()}>
            保存设置
          </button>
        </div>
      </div>

      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert ok">{notice}</div> : null}

      {info?.database.mode === 'memory-fallback' ? (
        <div className="alert error">
          <b>数据库已降级为内存库（重启后任务与运行记录会丢失）：</b>
          {info.database.detail}
        </div>
      ) : null}

      <Section title="技能系统">
        <Card>
          <p className="inline-note" style={{ marginTop: 0 }}>
            内置技能可在对话中自动调用，也可手动执行。
          </p>
          <SkillsPanel />
        </Card>
      </Section>

      <Section title="真实调用总开关">
        <Card>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.allowRealModelCalls}
              onChange={(event) => patchForm({ allowRealModelCalls: event.target.checked })}
            />
            <span>
              允许真实模型调用（默认<b>关闭</b>）。关闭时，应用启动、Mock 流程以及任何非显式操作
              都不会触发真实 DSH 调用，因此不会消耗额度。
            </span>
          </label>
          <p className="inline-note">
            即使打开此开关，真实任务仍需在「任务中心」对具体任务再次勾选确认后才会执行。
          </p>
          <div className="alert warn" style={{ marginBottom: 0 }}>
            <b>费用口径：金额{COST_UNVERIFIED_TEXT}，token 用量可信。</b>
            <div className="small" style={{ marginTop: 4 }}>
              {COST_UNVERIFIED_DETAIL}
            </div>
          </div>
        </Card>
      </Section>

      <Section title="DSH 调用配置">
        <Card>
          <label className="field">
            <span>DSH 可执行文件路径（dshExePath）</span>
            <input
              type="text"
              className="mono-input"
              value={form.dshExePath}
              onChange={(event) => patchForm({ dshExePath: event.target.value })}
            />
          </label>
          <label className="field">
            <span>CLI 入口脚本（asar 内路径，勿用 Test-Path 判断是否存在）</span>
            <input
              type="text"
              value={form.dshCliScript}
              onChange={(event) => patchForm({ dshCliScript: event.target.value })}
            />
          </label>
          <div className="grid cols-2">
            <label className="field">
              <span>profile（当前为 headless，已实测可用）</span>
              <input
                type="text"
                value={form.dshProfile}
                onChange={(event) => patchForm({ dshProfile: event.target.value })}
              />
            </label>
            <label className="field">
              <span>DSH_HOME（默认 C:\Users\&lt;你&gt;\.dsh，仅用于定位会话目录）</span>
              <input
                type="text"
                value={form.dshHomeDir}
                onChange={(event) => patchForm({ dshHomeDir: event.target.value })}
              />
            </label>
          </div>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>任务工作目录（taskCwd，决定 DSH 会话落盘位置）</span>
            <input
              type="text"
              value={form.taskCwd}
              onChange={(event) => patchForm({ taskCwd: event.target.value })}
            />
          </label>
          <p className="inline-note">
            工作台只读取以上路径，<b>不会修改</b> DSH 安装目录、桌面 profile、其他 Agent 配置或现有的
            cordis.patch.yml。
          </p>
        </Card>
      </Section>

      <Section title="安全限制">
        <Card>
          <div className="grid cols-3">
            <label className="field">
              <span>任务超时（毫秒，5000–600000）</span>
              <input
                type="number"
                value={form.taskTimeoutMs}
                onChange={(event) => patchForm({ taskTimeoutMs: event.target.value })}
              />
            </label>
            <label className="field">
              <span>真实任务并发上限（1–4）</span>
              <input
                type="number"
                value={form.realConcurrencyLimit}
                onChange={(event) => patchForm({ realConcurrencyLimit: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Mock 任务并发上限（1–8）</span>
              <input
                type="number"
                value={form.mockConcurrencyLimit}
                onChange={(event) => patchForm({ mockConcurrencyLimit: event.target.value })}
              />
            </label>
          </div>
          <ul className="todo-list">
            <li>自动重试：{AUTO_RETRY_ENABLED ? '开启' : '禁止'}（固定值，避免重复计费）</li>
            <li>超时只终止本地子进程，<b>不代表远端请求已停止</b>，远端仍可能继续运行并产生费用</li>
            <li>并发超限时不排队，任务保持「待执行」，需要手动再次执行</li>
            <li>不自动删除 DSH 会话目录，只记录位置，清理策略留待后续可审查的步骤</li>
          </ul>
        </Card>
      </Section>

      <Section title="当前生效的护栏">
        <Card>
          <table>
            <thead>
              <tr>
                <th>项</th>
                <th>当前值</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {guardrails.map((item) => (
                <tr key={item.label} style={{ cursor: 'default' }}>
                  <td>{item.label}</td>
                  <td>
                    <b>{item.value}</b>
                  </td>
                  <td className="muted small">{item.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </Section>

      <Section title="系统信息">
        <Card>
          <div className="kv">
            <span className="k">应用版本</span>
            <span>{info?.appVersion ?? '—'}</span>
            <span className="k">Electron / Node / Chrome</span>
            <span className="mono">
              {info ? `${info.electronVersion} / ${info.nodeVersion} / ${info.chromeVersion}` : '—'}
            </span>
            <span className="k">平台</span>
            <span>{info?.platform ?? '—'}</span>
            <span className="k">数据目录</span>
            <span className="mono">{info?.userDataDir ?? '—'}</span>
            <span className="k">数据库文件</span>
            <span className="mono">{info?.database.filePath ?? '—'}</span>
            <span className="k">数据库模式 / schema 版本</span>
            <span>
              {info ? `${info.database.mode} / v${info.database.schemaVersion}` : '—'}
            </span>
            <span className="k">日志目录</span>
            <span className="mono">{info?.logDir ?? '—'}</span>
            <span className="k">会话目录策略</span>
            <span className="small">{info?.sessionNote ?? '—'}</span>
          </div>
        </Card>
      </Section>

      <Section title="本阶段未实现（后续阶段）">
        <Card>
          <ul className="todo-list">
            <li>预算闸门与金额自动核验 —— 未实现（金额口径仍为「无法核验」）</li>
            <li>消息通知 / 托盘 / 自动启动 —— 未实现</li>
            <li>多 Agent 编排、主管 Agent 的真实智能拆解与真实 Agent 自动匹配 —— 未实现（当前为 Mock 主管调度）</li>
          </ul>
        </Card>
      </Section>
    </div>
  )
}
