import { useCallback, useEffect, useState, type ReactNode } from 'react'

import type { AgentDescriptor, GuardrailItem, Overview, SystemInfo } from '../../../shared/types'
import { api, errorMessage, formatTime } from '../api'
import { AgentMeta, Card, CostNotice, Section, StatCard } from '../components/ui'
import type { TabId } from '../App'

export default function OverviewPage({
  onNavigate
}: {
  onNavigate: (tab: TabId) => void
}): ReactNode {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [guardrails, setGuardrails] = useState<GuardrailItem[]>([])
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextOverview, nextAgents, nextGuardrails, nextInfo] = await Promise.all([
        api.getOverview(),
        api.listAgents(),
        api.getGuardrails(),
        api.getSystemInfo()
      ])
      setOverview(nextOverview)
      setAgents(nextAgents)
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

  useEffect(() => api.onTaskChanged(() => void refresh()), [refresh])

  if (error) {
    return <div className="alert error">{error}</div>
  }
  if (!overview) {
    return <p className="muted">加载中…</p>
  }

  const runnable = agents.filter((agent) => agent.mode === 'auto')

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>总览</h2>
          <p>第 3 步范围：任务队列 / 状态机 / 持久化 / Mock + 真实 DSH 适配器 / 基础护栏。</p>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => void refresh()} type="button">
            刷新
          </button>
          <button className="btn primary" onClick={() => onNavigate('tasks')} type="button">
            去任务中心
          </button>
        </div>
      </div>

      {info?.database.mode === 'memory-fallback' ? (
        <div className="alert error">
          <b>数据库已降级为内存库：</b>
          {info.database.detail}
        </div>
      ) : null}

      <CostNotice />

      <Section title="任务状态">
        <div className="grid cols-4">
          <StatCard label="任务总数" value={overview.total} hint={`最近活动：${formatTime(overview.lastActivityAt)}`} />
          <StatCard label="执行中" value={overview.running} hint={`待执行 ${overview.pending}`} />
          <StatCard label="成功" value={overview.succeeded} tone="ok" hint={`真实调用任务 ${overview.realRunCount} 个`} />
          <StatCard
            label="失败 / 超时"
            value={`${overview.failed} / ${overview.timedOut}`}
            tone={overview.failed + overview.timedOut > 0 ? 'err' : undefined}
            hint={`已取消 ${overview.cancelled}`}
          />
        </div>
        <div className="grid cols-4" style={{ marginTop: 12 }}>
          <StatCard
            label="待人工确认"
            value={overview.needsConfirmation}
            tone={overview.needsConfirmation > 0 ? 'warn' : undefined}
            hint="上次异常退出遗留的任务会落到这里"
          />
          <StatCard
            label="已知 token 合计（可信）"
            value={overview.knownTokensTotal || '—'}
            hint="来自 NDJSON step_end.usage"
          />
          <StatCard
            label="已核验真实费用"
            value={overview.verifiedCostTotal === 0 ? '无法核验' : `¥${overview.verifiedCostTotal.toFixed(6)}`}
            tone="warn"
            hint={`当前可核验项：0 项；无法核验任务：${overview.costUnverifiedTaskCount} 个`}
          />
          <StatCard
            label="估算金额合计"
            value={overview.estimatedCostTotal === 0 ? '—' : `¥${overview.estimatedCostTotal.toFixed(6)}`}
            hint="本阶段无可靠单价来源，不生成估算"
          />
        </div>
      </Section>

      <Section title="安全护栏现状">
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

      <Section title="Agent 接入状态">
        <div className="grid cols-2">
          <Card>
            <b>可自动执行</b>
            <p className="muted small">这些 Agent 在本阶段有真实可用的执行路径。</p>
            <div className="stack" style={{ gap: 10 }}>
              {runnable.map((agent) => (
                <div key={agent.id}>
                  <div>
                    <b>{agent.name}</b>
                  </div>
                  <AgentMeta agent={agent} />
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <b>本阶段不可自动执行</b>
            <p className="muted small">保持「人工交接」，避免出现「看起来能用其实不能」的假象。</p>
            <div className="stack" style={{ gap: 10 }}>
              {agents
                .filter((agent) => agent.mode !== 'auto')
                .map((agent) => (
                  <div key={agent.id}>
                    <div>
                      <b>{agent.name}</b>
                    </div>
                    <AgentMeta agent={agent} />
                  </div>
                ))}
            </div>
          </Card>
        </div>
      </Section>

      <Section title="明确未实现（后续阶段）">
        <Card>
          <ul className="todo-list">
            <li>主管 Agent 自动拆解任务、项目小组、子任务依赖与结果汇总 —— 未实现</li>
            <li>多 Agent 自动分工、Agent 之间互相调用、自动并发执行 —— 未实现</li>
            <li>自动重试、自动循环修复代码、自动提交代码 —— 未实现（且当前固定禁止自动重试）</li>
            <li>Trae CN / WorkBuddy 的人工交接闭环（生成提示词、一键唤起、回贴结果）—— 部分未实现</li>
            <li>Grok 本机 HTTP 接口接入 —— 未实现（未验证接口，本阶段不发送任何请求）</li>
            <li>预算闸门与金额核验 —— 未实现（金额口径仍为「无法核验」）</li>
          </ul>
        </Card>
      </Section>
    </div>
  )
}
