import type { ReactNode } from 'react'

import {
  AGENT_MODE_LABEL,
  AVAILABILITY_LABEL,
  CAPABILITY_LABEL,
  CAPABILITY_STATE_LABEL,
  CAPABILITIES,
  COST_UNVERIFIED_DETAIL,
  TASK_STATUS_LABEL,
  type AgentDescriptor,
  type AvailabilityState,
  type CapabilityState,
  type TaskStatus,
  type UsageRecord
} from '../../../shared/types'
import { formatMoney } from '../api'

export function Card({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}): ReactNode {
  return <div className={`card ${className}`}>{children}</div>
}

export function Section({
  title,
  children,
  extra
}: {
  title: string
  children: ReactNode
  extra?: ReactNode
}): ReactNode {
  return (
    <div className="section">
      <div className="flex-between">
        <h3>{title}</h3>
        {extra}
      </div>
      {children}
    </div>
  )
}

const STATUS_TONE: Record<TaskStatus, string> = {
  succeeded: 'ok',
  running: 'running',
  pending: 'muted',
  needs_confirmation: 'warn',
  timed_out: 'warn',
  failed: 'err',
  cancelled: 'muted'
}

export function StatusBadge({ status }: { status: TaskStatus }): ReactNode {
  return <span className={`badge ${STATUS_TONE[status]}`}>{TASK_STATUS_LABEL[status]}</span>
}

export function StatCard({
  label,
  value,
  hint,
  tone
}: {
  label: string
  value: ReactNode
  hint?: string
  tone?: 'ok' | 'err' | 'warn'
}): ReactNode {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  )
}

export function AvailabilityBadge({
  availability
}: {
  availability: AvailabilityState
}): ReactNode {
  const tone =
    availability === 'available' ? 'ok' : availability === 'unavailable' ? 'err' : 'muted'
  return <span className={`badge ${tone}`}>{AVAILABILITY_LABEL[availability]}</span>
}

export function CapabilityBadge({ state }: { state: CapabilityState }): ReactNode {
  const tone = state === 'verified' ? 'ok' : state === 'unverified' ? 'muted' : 'err'
  return <span className={`badge ${tone}`}>{CAPABILITY_STATE_LABEL[state]}</span>
}

export function AgentMeta({ agent }: { agent: AgentDescriptor }): ReactNode {
  return (
    <div className="btn-row" style={{ marginBottom: 10 }}>
      <AvailabilityBadge availability={agent.availability} />
      <span className="badge muted">{AGENT_MODE_LABEL[agent.mode]}</span>
      {agent.isRealCall ? (
        <span className="badge warn">真实调用（可能产生费用）</span>
      ) : (
        <span className="badge ok">不产生费用</span>
      )}
      {agent.version ? <span className="badge muted">v{agent.version}</span> : null}
    </div>
  )
}

export function CapabilityTable({ agent }: { agent: AgentDescriptor }): ReactNode {
  return (
    <table className="cap-table">
      <thead>
        <tr>
          <th>能力</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        {CAPABILITIES.map((capability) => (
          <tr key={capability}>
            <td>{CAPABILITY_LABEL[capability]}</td>
            <td>
              <CapabilityBadge state={agent.capabilities[capability]} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * 用量面板。
 *
 * 界面纪律：金额无法核验时必须显示「无法核验」，**绝不显示 ¥0.000000 或「免费」**；
 * token 与金额分两行展示，让「token 可信、金额未知」这件事一眼可见。
 */
export function UsagePanel({ usage }: { usage: UsageRecord | null }): ReactNode {
  if (!usage) {
    return (
      <p className="muted small">
        本任务没有用量记录（未发生模型调用，或被安全护栏拦截，因此不产生费用）。
      </p>
    )
  }

  const tokensKnown = usage.totalTokens !== null

  return (
    <div className="usage">
      <div className="usage-row">
        <span>token 用量（来自 NDJSON step_end.usage）</span>
        <b>
          {tokensKnown
            ? `${usage.totalTokens}（输入 ${usage.inputTokens ?? '—'} / 输出 ${
                usage.outputTokens ?? '—'
              }）`
            : '未读取到'}
        </b>
      </div>
      <div className="usage-row">
        <span>实际费用</span>
        <b className={usage.actualCost === null ? 'cost-unknown' : undefined}>
          {usage.actualCost === null ? '无法核验' : formatMoney(usage.actualCost)}
        </b>
      </div>
      <div className="usage-row">
        <span>估算费用</span>
        <b>
          {usage.estimatedCost === null
            ? '—（无可靠单价来源，本阶段不生成估算）'
            : `${formatMoney(usage.estimatedCost)}（估算值，非实际账单）`}
        </b>
      </div>
      <div className="usage-row">
        <span>金额来源 / 是否已核验</span>
        <b>
          {usage.source} / {usage.verified ? '已核验' : '未核验'}
        </b>
      </div>
      <p className="inline-note">{usage.note}</p>
    </div>
  )
}

/** 全站通用的费用口径提示。 */
export function CostNotice(): ReactNode {
  return (
    <div className="alert warn">
      <b>费用口径：金额无法核验，token 用量可信。</b>
      <div className="small" style={{ marginTop: 4 }}>
        {COST_UNVERIFIED_DETAIL}
      </div>
    </div>
  )
}
