import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { FAILURE_KIND_LABEL, type RunRecord } from '../../../shared/types'
import { api, errorMessage, formatDuration, formatTime } from '../api'
import { Card, Section } from '../components/ui'

export default function RunsPage(): ReactNode {
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await api.listRuns(200)
      setRuns(next)
      setError(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => api.onTaskChanged(() => void refresh()), [refresh])

  const selected = runs.find((run) => run.id === selectedId) ?? null

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>运行记录</h2>
          <p>每次真实执行对应一条运行记录，保留退出码、stdout 行数、无效行数与脱敏后的 stderr 摘要。</p>
        </div>
        <button className="btn" onClick={() => void refresh()} type="button">
          刷新
        </button>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      {runs.length === 0 ? (
        <Card>
          <p className="muted small">还没有运行记录。到「任务中心」创建并执行一个 Mock 任务即可产生记录。</p>
        </Card>
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>开始时间</th>
                <th>Agent</th>
                <th>类型</th>
                <th>结果</th>
                <th>退出码</th>
                <th>耗时</th>
                <th>stdout</th>
                <th>无效行</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  className={selectedId === run.id ? 'selected' : ''}
                  onClick={() => setSelectedId(run.id)}
                >
                  <td>{formatTime(run.startedAt)}</td>
                  <td className="mono">{run.agentId}</td>
                  <td>
                    <span className={`badge ${run.isRealCall ? 'warn' : 'ok'}`}>
                      {run.isRealCall ? '真实调用' : 'Mock'}
                    </span>
                  </td>
                  <td>
                    {run.failureKind === null ? (
                      <span className="badge ok">正常结束</span>
                    ) : (
                      <span className="badge err">{FAILURE_KIND_LABEL[run.failureKind]}</span>
                    )}
                  </td>
                  <td>{run.exitCode ?? '—'}</td>
                  <td>{formatDuration(run.durationMs)}</td>
                  <td>
                    {run.stdoutLineCount} 行 / {run.stdoutBytes} B
                  </td>
                  <td>{run.invalidLineCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {selected ? (
        <Section title="运行详情">
          <Card>
            <div className="kv">
              <span className="k">运行 ID</span>
              <span className="mono">{selected.id}</span>
              <span className="k">任务 ID</span>
              <span className="mono">{selected.taskId}</span>
              <span className="k">适配器</span>
              <span className="mono">{selected.adapterId}</span>
              <span className="k">尝试次数</span>
              <span>{selected.attemptNo}（本阶段禁止自动重试，恒为 1）</span>
              <span className="k">开始 / 结束</span>
              <span>
                {formatTime(selected.startedAt)} → {formatTime(selected.endedAt)}
              </span>
              <span className="k">退出码</span>
              <span>{selected.exitCode ?? '—'}</span>
              <span className="k">stdout 行数 / 字节</span>
              <span>
                {selected.stdoutLineCount} / {selected.stdoutBytes}
              </span>
              <span className="k">无效 NDJSON 行</span>
              <span>{selected.invalidLineCount}</span>
              <span className="k">失败分类</span>
              <span>
                {selected.failureKind ? FAILURE_KIND_LABEL[selected.failureKind] : '无（正常结束）'}
              </span>
            </div>

            <p className="inline-note" style={{ marginTop: 12 }}>
              以下 stderr 摘要在入库前已做脱敏处理（凭据不会出现在这里）。
            </p>
            <pre className="block">
              {selected.stderrExcerpt.trim().length > 0 ? selected.stderrExcerpt : '(空)'}
            </pre>
          </Card>
        </Section>
      ) : null}
    </div>
  )
}
