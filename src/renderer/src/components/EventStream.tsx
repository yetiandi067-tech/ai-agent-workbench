import { useMemo, useState, type ReactNode } from 'react'

import type { AgentRunEvent } from '../../../shared/types'
import { formatTime } from '../api'

/**
 * 原始事件流查看器。
 *
 * 保留**原始事件**是排查问题的前提，所以这里展示的是未经改写的 payload；
 * 未知类型也不会被过滤掉（它们在采集阶段已被归入 unknown 并保留原始对象）。
 */
export function EventStream({
  events,
  live = false
}: {
  events: AgentRunEvent[]
  live?: boolean
}): ReactNode {
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null)
  const [showRaw, setShowRaw] = useState(false)

  const rows = useMemo(() => events, [events])

  if (rows.length === 0) {
    return <p className="muted small">暂无事件。</p>
  }

  return (
    <div>
      <div className="btn-row" style={{ marginBottom: 8 }}>
        <button className="btn small" onClick={() => setShowRaw((value) => !value)}>
          {showRaw ? '隐藏原始 JSON' : '显示原始 JSON'}
        </button>
        <span className="muted small">
          共 {rows.length} 个事件{live ? '（执行中，实时追加）' : ''}
        </span>
      </div>
      <div>
        {rows.map((event) => {
          const expanded = expandedSeq === event.seq
          return (
            <div
              key={event.seq}
              className={`event-row${expanded ? ' expanded' : ''}`}
              onClick={() => setExpandedSeq(expanded ? null : event.seq)}
            >
              <span className="seq">#{event.seq}</span>
              <span className="type">{event.type}</span>
              <span className="muted">{event.rawType}</span>
              <span className="payload">
                {showRaw || expanded
                  ? JSON.stringify(event.payload)
                  : summarize(event)}
              </span>
            </div>
          )
        })}
      </div>
      <p className="inline-note">
        最近的接收时间：{formatTime(rows[rows.length - 1]?.receivedAt ?? null)}（点击任意行可展开）
      </p>
    </div>
  )
}

function summarize(event: AgentRunEvent): string {
  const payload = event.payload
  if (event.type === 'text') return `文本增量：${String(payload.text ?? '')}`
  if (event.type === 'thinking') return `思考事件（DSH 可能为空）：${String(payload.text ?? '')}`
  if (event.type === 'final') return `最终文本：${String(payload.text ?? '')}`
  if (event.type === 'session') return `会话：${String(payload.sessionId ?? '')}`
  if (event.type === 'usage') {
    return `用量：totalTokens=${String(payload.totalTokens ?? '')}`
  }
  if (event.type === 'status') {
    return `阶段：${String(payload.phase ?? '')}`
  }
  return JSON.stringify(payload).slice(0, 160)
}
