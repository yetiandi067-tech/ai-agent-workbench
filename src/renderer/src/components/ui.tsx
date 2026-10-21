import type { ReactNode } from 'react'

import {
  AGENT_MODE_LABEL,
  AVAILABILITY_LABEL,
  BLOCKED_BY_DEPENDENCY_CODE,
  BLOCKED_BY_DEPENDENCY_LABEL,
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

/**
 * 依赖阻断：底层任务状态仍是 failed（错误码 BLOCKED_BY_DEPENDENCY）。
 * 界面单独显示为「被阻断」，避免与真正执行失败混淆；此处只做展示判断，不改任何状态。
 */
export function isBlockedByDependency(task: {
  status: TaskStatus
  errorCode: string | null
}): boolean {
  return task.status === 'failed' && task.errorCode === BLOCKED_BY_DEPENDENCY_CODE
}

/** 任务状态展示文案（仅依赖阻断被单独标注，其余与状态机文案一致）。 */
export function taskStatusText(task: { status: TaskStatus; errorCode: string | null }): string {
  return isBlockedByDependency(task) ? BLOCKED_BY_DEPENDENCY_LABEL : TASK_STATUS_LABEL[task.status]
}

export function StatusBadge({
  status,
  errorCode = null
}: {
  status: TaskStatus
  errorCode?: string | null
}): ReactNode {
  if (isBlockedByDependency({ status, errorCode })) {
    return (
      <span
        className="badge warn"
        title="依赖的上游任务未成功，本任务未执行（底层任务状态仍为「失败」）。"
      >
        {BLOCKED_BY_DEPENDENCY_LABEL}
      </span>
    )
  }
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

/** 加载指示器：按钮或区块级 loading 状态。 */
export function Spinner({ size = 'md', label }: { size?: 'sm' | 'md' | 'lg'; label?: string }): ReactNode {
  const px = size === 'sm' ? 14 : size === 'lg' ? 32 : 20
  return (
    <span className={`spinner spinner-${size}`} role="status" aria-label={label ?? '加载中'}>
      <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="30">
          <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
        </circle>
      </svg>
      {label ? <span className="spinner-label">{label}</span> : null}
    </span>
  )
}

/** 空状态：列表或区块无数据时的友好提示。 */
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }): ReactNode {
  return (
    <div className="empty-state">
      <div className="empty-icon">📋</div>
      <div className="empty-title">{title}</div>
      {description ? <div className="empty-desc">{description}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  )
}

/** Toast 通知类型 */
export type ToastKind = 'success' | 'error' | 'info'

/** Toast 通知项 */
export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
  duration?: number
}

/** 全局 Toast 通知容器（自动消失）。 */
export function ToastContainer({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }): ReactNode {
  return (
    <div className="toast-container" role="alert" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`} onClick={() => onDismiss(toast.id)}>
          <span className="toast-icon">
            {toast.kind === 'success' ? '✓' : toast.kind === 'error' ? '✕' : 'ℹ'}
          </span>
          <span className="toast-message">{toast.message}</span>
        </div>
      ))}
    </div>
  )
}

/** 确认对话框：重要操作前的二次确认。 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}): ReactNode {
  if (!open) return null
  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="confirm-dialog">
        <h4 id="confirm-title">{title}</h4>
        <p>{message}</p>
        <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn" type="button" onClick={onCancel}>{cancelLabel}</button>
          <button className="btn primary" type="button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
