import { useCallback, useEffect, useState, type ReactNode } from 'react'

import type { AgentDescriptor } from '../../../shared/types'
import { api, errorMessage, formatTime } from '../api'
import { AgentMeta, CapabilityTable, Card, Section } from '../components/ui'

export default function AgentsPage(): ReactNode {
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [checking, setChecking] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setAgents(await api.listAgents())
      setError(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const check = async (agentId: string): Promise<void> => {
    setChecking(agentId)
    setError(null)
    setNotice(null)
    try {
      const descriptor = await api.checkAgent(agentId)
      setNotice(
        `${descriptor.name}：${descriptor.availabilityDetail}${
          descriptor.version ? `（版本 ${descriptor.version}）` : ''
        }`
      )
      await refresh()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setChecking(null)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Agent 管理</h2>
          <p>
            能力状态取自实测审计结论：已实测成功 = 已验证；有线索未端到端确认 = 未验证；明确没有该能力 = 不支持。
          </p>
        </div>
        <button className="btn" onClick={() => void refresh()} type="button">
          刷新
        </button>
      </div>

      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert info">{notice}</div> : null}

      <div className="alert info">
        <b>「检测连接」不会调用模型。</b>
        <div className="small" style={{ marginTop: 4 }}>
          对 DSH 它只跑一次 <span className="mono">--version</span>
          （本地进程探活，不提交任务、不产生费用）。
        </div>
      </div>

      <div className="stack">
        {agents.map((agent) => (
          <Card key={agent.id}>
            <div className="flex-between">
              <div>
                <b style={{ fontSize: 15 }}>{agent.name}</b>
                <div className="muted small mono">{agent.id}</div>
              </div>
              <div className="btn-row">
                {agent.mode === 'auto' ? (
                  <button
                    className="btn small"
                    type="button"
                    disabled={checking === agent.id}
                    onClick={() => void check(agent.id)}
                  >
                    {checking === agent.id ? '检测中…' : '检测连接'}
                  </button>
                ) : (
                  <span className="badge muted">无自动执行路径</span>
                )}
              </div>
            </div>

            <AgentMeta agent={agent} />

            <p className="small" style={{ marginTop: 0 }}>
              {agent.description}
            </p>
            <p className="muted small">检测说明：{agent.availabilityDetail}</p>
            {agent.checkedAt ? (
              <p className="muted small">最近检测：{formatTime(agent.checkedAt)}</p>
            ) : null}

            <div className="grid cols-2" style={{ marginTop: 8 }}>
              <div>
                <b className="small">能力矩阵</b>
                <CapabilityTable agent={agent} />
              </div>
              <div>
                <b className="small">接入说明与已知限制</b>
                <p className="muted small" style={{ whiteSpace: 'pre-wrap' }}>
                  {agent.configNote}
                </p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Section title="关于「不支持」的含义">
        <Card>
          <p className="muted small">
            DSH 的「取消 / 状态查询」标为未验证：CLI 没有 cancel / status 子命令，工作台只能终止本地进程，
            <b>不代表远端请求停止</b>。成本能力标为未验证：token 可读，但金额无法核验。
          </p>
        </Card>
      </Section>
    </div>
  )
}
