import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import {
  COST_UNVERIFIED_TEXT,
  FAILURE_KIND_LABEL,
  MOCK_PLAN_BADGE,
  MOCK_PLAN_DISCLAIMER,
  PLAN_STATUS_LABEL,
  REMOTE_NOT_STOPPED_WARNING,
  SUB_TASK_KIND_LABEL,
  TASK_STATUS_LABEL,
  type AgentDescriptor,
  type AgentRunEvent,
  type AppSettings,
  type PlanRecord,
  type PlanWithTasks,
  type TaskRecord,
  type TaskStatus
} from '../../../shared/types'
import { api, errorMessage, formatDuration, formatTime } from '../api'
import { EventStream } from '../components/EventStream'
import { Card, Section, StatusBadge, taskStatusText, UsagePanel } from '../components/ui'

/** Mock 场景标记（与主进程 MockAdapter 的标记保持一致）。 */
const MOCK_MARKERS: Array<{ marker: string; label: string }> = [
  { marker: 'mock:success', label: '成功返回' },
  { marker: 'mock:streaming', label: '流式文本' },
  { marker: 'mock:failure', label: '模型侧失败' },
  { marker: 'mock:timeout', label: '超时（需把超时时间调小）' },
  { marker: 'mock:missing_final', label: '缺少最终结果' },
  { marker: 'mock:usage_estimated', label: '带模拟估算金额' }
]

export default function TasksPage(): ReactNode {
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TaskRecord | null>(null)
  const [events, setEvents] = useState<AgentRunEvent[]>([])
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('mock:success 这是一个本地模拟任务')
  const [agentId, setAgentId] = useState('mock')
  const [realConfirm, setRealConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 主管计划相关状态
  const [planGoal, setPlanGoal] = useState('')
  const [planPreview, setPlanPreview] = useState<PlanWithTasks | null>(null)
  const [plans, setPlans] = useState<PlanRecord[]>([])
  const [selectedPlan, setSelectedPlan] = useState<PlanWithTasks | null>(null)

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await api.listTasks({ limit: 200 }))
      setError(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [])

  const refreshPlans = useCallback(async () => {
    try {
      setPlans(await api.planList({ limit: 50 }))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const [nextAgents, nextSettings] = await Promise.all([api.listAgents(), api.getSettings()])
        setAgents(nextAgents)
        setSettings(nextSettings)
      } catch (caught) {
        setError(errorMessage(caught))
      }
    })()
    void refreshTasks()
    void refreshPlans()
  }, [refreshTasks, refreshPlans])

  // 任务状态变化：刷新列表；若正是当前选中项，同步刷新详情与最终结果。
  useEffect(
    () =>
      api.onTaskChanged((task) => {
        void refreshTasks()
        if (task.id === selectedId) setDetail(task)
      }),
    [refreshTasks, selectedId]
  )

  // 执行中的增量事件：只追加到当前选中任务的事件流。
  useEffect(
    () =>
      api.onRunEvent(({ taskId, event }) => {
        if (taskId === selectedId) setEvents((prev) => [...prev, event])
      }),
    [selectedId]
  )

  // 计划状态变化：刷新计划列表与当前选中计划的详情。
  useEffect(
    () =>
      api.onPlanChanged((plan) => {
        void refreshPlans()
        if (selectedPlan?.plan.id === plan.id) {
          void api.planGet(plan.id).then(setSelectedPlan)
        }
      }),
    [refreshPlans, selectedPlan?.plan.id]
  )

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === agentId) ?? null,
    [agents, agentId]
  )

  const realCallsDisabled = settings !== null && !settings.allowRealModelCalls

  async function selectTask(task: TaskRecord): Promise<void> {
    setSelectedId(task.id)
    setDetail(task)
    setRealConfirm(false)
    setError(null)
    setNotice(null)
    try {
      setEvents(await api.getTaskEvents(task.id, 1000))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function handleCreate(): Promise<void> {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const created = await api.createTask({ title, prompt, agentId })
      await refreshTasks()
      await selectTask(created)
      setNotice(`已创建任务「${created.title}」（状态：${TASK_STATUS_LABEL[created.status]}）。`)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function handleRun(task: TaskRecord): Promise<void> {
    if (task.isRealCall) {
      if (realCallsDisabled) {
        setError('请先在「设置」中开启真实调用总开关，才能执行真实任务。')
        return
      }
      if (!realConfirm) {
        setError('真实调用需要先勾选确认（我已确认本次会产生真实调用，且金额无法核验）。')
        return
      }
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const finished = await api.runTask(task.id, task.isRealCall ? realConfirm : false)
      setDetail(finished)
      setNotice(
        `任务已结束：${TASK_STATUS_LABEL[finished.status]}` +
          (finished.userNotice ? ` — ${finished.userNotice}` : '')
      )
      await refreshTasks()
      setEvents(await api.getTaskEvents(task.id, 1000))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function handleCancel(task: TaskRecord): Promise<void> {
    setError(null)
    try {
      const result = await api.cancelTask(task.id)
      setNotice(result.message)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  // ========== 主管计划相关处理函数 ==========

  async function handlePlanPreview(): Promise<void> {
    if (planGoal.trim().length === 0) {
      setError('请输入总目标。')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const preview = await api.planCreate(planGoal)
      setPlanPreview(preview)
      setNotice(
        `已生成 Mock 计划预览：${preview.tasks.length} 个子任务。请确认后点击下方「确认执行」按钮。`
      )
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function handlePlanConfirm(): Promise<void> {
    if (!planPreview) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.planConfirm(planPreview.plan.id)
      setNotice('计划已启动（Mock 执行）。子任务将按依赖顺序串行执行。')
      setPlanPreview(null)
      setPlanGoal('')
      await refreshPlans()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function handleSelectPlan(plan: PlanRecord): Promise<void> {
    setError(null)
    try {
      const detail = await api.planGet(plan.id)
      setSelectedPlan(detail)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>任务中心</h2>
          <p>
            创建任务 → 选择执行 Agent → 查看状态与执行结果。不会自动重试，真实任务并发上限 1，
            超限时任务保持「待执行」而不是自动排队。
          </p>
        </div>
        <button className="btn" onClick={() => void refreshTasks()} type="button">
          刷新
        </button>
      </div>

      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert info">{notice}</div> : null}

      <Section title="创建任务">
        <Card>
          <div className="grid cols-2">
            <label className="field">
              <span>任务标题</span>
              <input
                type="text"
                value={title}
                placeholder="例如：Mock 链路自测"
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="field">
              <span>执行 Agent</span>
              <select
                value={agentId}
                onChange={(event) => {
                  setAgentId(event.target.value)
                  setRealConfirm(false)
                }}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.mode === 'auto' ? '' : '（本阶段无自动执行路径）'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="field">
            <span>任务内容（prompt）</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>

          {agentId === 'mock' ? (
            <div className="btn-row" style={{ marginBottom: 10 }}>
              <span className="muted small">Mock 场景：</span>
              {MOCK_MARKERS.map((item) => (
                <button
                  key={item.marker}
                  className="btn small"
                  type="button"
                  onClick={() => setPrompt(`${item.marker} ${item.label}`)}
                >
                  {item.marker}
                </button>
              ))}
              <span className="muted small">
                标记写在任务内容里，默认 mock:success。
              </span>
            </div>
          ) : null}

          {selectedAgent && selectedAgent.isRealCall ? (
            <div className="alert warn">
              <b>这会是一次真实模型调用。</b>
              <div className="small" style={{ marginTop: 4 }}>
                本地可确认 token 用量，但<b>金额{COST_UNVERIFIED_TEXT}</b>。执行前请先勾选下方确认。
                {realCallsDisabled ? '（当前真实调用总开关为关闭状态，请先到「设置」中开启。）' : ''}
              </div>
              <label className="checkbox" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={realConfirm}
                  onChange={(event) => setRealConfirm(event.target.checked)}
                />
                <span>我已确认本次会产生真实调用，且金额无法核验。</span>
              </label>
            </div>
          ) : (
            <div className="alert ok">
              本地模拟（Mock）执行，不启动任何外部进程、不调用任何模型，因此<b>不产生费用</b>。
            </div>
          )}

          <div className="btn-row">
            <button className="btn primary" type="button" disabled={busy} onClick={() => void handleCreate()}>
              创建任务
            </button>
            <span className="muted small">创建后任务为「待执行」，需要在下方列表中手动触发执行。</span>
          </div>
        </Card>
      </Section>

      <Section title={`主管 Agent（${MOCK_PLAN_BADGE}）`}>
        <Card>
          <div className="alert info" style={{ marginBottom: 12 }}>
            {MOCK_PLAN_DISCLAIMER}
          </div>

          <label className="field">
            <span>总目标</span>
            <textarea
              value={planGoal}
              placeholder="例如：调研本地大模型并写一份报告（或试试「模拟失败：测试依赖阻断」）"
              onChange={(event) => setPlanGoal(event.target.value)}
            />
          </label>

          <div className="btn-row">
            <button className="btn" type="button" disabled={busy} onClick={() => void handlePlanPreview()}>
              生成 Mock 计划预览
            </button>
            {planPreview ? (
              <button
                className="btn primary"
                type="button"
                disabled={busy}
                onClick={() => void handlePlanConfirm()}
              >
                确认执行（Mock）
              </button>
            ) : null}
          </div>

          {planPreview ? (
            <div style={{ marginTop: 14 }}>
              <b className="small">计划预览（{planPreview.tasks.length} 个子任务）</b>
              <div style={{ marginTop: 8 }}>
                {planPreview.tasks.map((task) => (
                  <div
                    key={task.id}
                    style={{
                      padding: 10,
                      marginBottom: 8,
                      border: '1px solid #2a2f3a',
                      borderRadius: 6,
                      background: '#1a1d24'
                    }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <span className="badge ok">#{task.planSeq}</span>
                      <span className="badge">{task.taskKind ? SUB_TASK_KIND_LABEL[task.taskKind] : '—'}</span>
                      <b>{task.title}</b>
                      <span className="muted small mono">{task.agentId}</span>
                    </div>
                    <div className="small muted" style={{ marginBottom: 4 }}>
                      {task.prompt}
                    </div>
                    <div className="small">
                      <span className="muted">验收标准：</span>
                      {task.acceptance}
                    </div>
                    {task.dependsOn.length > 0 ? (
                      <div className="small">
                        <span className="muted">依赖：</span>
                        第 {task.dependsOn.map((depId) => {
                          const dep = planPreview.tasks.find((t) => t.id === depId)
                          return dep ? `#${dep.planSeq}` : '?'
                        }).join(', ')} 步
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>
      </Section>

      <Section title="计划历史">
        {plans.length === 0 ? (
          <Card>
            <p className="muted small">还没有主管计划。先在上方输入总目标并生成 Mock 计划预览。</p>
          </Card>
        ) : (
          <Card>
            <table>
              <thead>
                <tr>
                  <th>标题</th>
                  <th>状态</th>
                  <th>子任务数</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr
                    key={plan.id}
                    className={selectedPlan?.plan.id === plan.id ? 'selected' : ''}
                    onClick={() => void handleSelectPlan(plan)}
                  >
                    <td>{plan.title}</td>
                    <td>
                      <span className={`badge ${plan.status === 'succeeded' ? 'ok' : plan.status === 'failed' ? 'error' : 'warn'}`}>
                        {PLAN_STATUS_LABEL[plan.status]}
                      </span>
                    </td>
                    <td>{plan.taskCount}</td>
                    <td>{formatTime(plan.createdAt)}</td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <button
                        className="btn small"
                        type="button"
                        onClick={() => void handleSelectPlan(plan)}
                      >
                        查看详情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      {selectedPlan ? (
        <Section
          title={`计划详情（${MOCK_PLAN_BADGE}）`}
          extra={
            <span className={`badge ${selectedPlan.plan.status === 'succeeded' ? 'ok' : selectedPlan.plan.status === 'failed' ? 'error' : 'warn'}`}>
              {PLAN_STATUS_LABEL[selectedPlan.plan.status]}
            </span>
          }
        >
          <Card>
            <div className="kv">
              <span className="k">计划 ID</span>
              <span className="mono">{selectedPlan.plan.id}</span>
              <span className="k">总目标</span>
              <span>{selectedPlan.plan.goal}</span>
              <span className="k">状态</span>
              <span>{PLAN_STATUS_LABEL[selectedPlan.plan.status]}</span>
              <span className="k">创建 / 确认 / 结束</span>
              <span>
                {formatTime(selectedPlan.plan.createdAt)} → {formatTime(selectedPlan.plan.confirmedAt)} →{' '}
                {formatTime(selectedPlan.plan.endedAt)}
              </span>
            </div>

            {selectedPlan.plan.blockedReason ? (
              <div className="alert error" style={{ marginTop: 12, marginBottom: 0 }}>
                {selectedPlan.plan.blockedReason}
              </div>
            ) : null}

            {selectedPlan.plan.summary ? (
              <div style={{ marginTop: 14 }}>
                <b className="small">汇总报告</b>
                <div className="alert info" style={{ marginTop: 8 }}>
                  {selectedPlan.plan.summary.report}
                </div>
                <div className="kv" style={{ marginTop: 10 }}>
                  <span className="k">统计</span>
                  <span>
                    共 {selectedPlan.plan.summary.totalCount} 个子任务，成功{' '}
                    {selectedPlan.plan.summary.succeededCount} 个，失败{' '}
                    {selectedPlan.plan.summary.failedCount} 个，被阻断{' '}
                    {selectedPlan.plan.summary.blockedCount} 个
                  </span>
                </div>
              </div>
            ) : null}

            <div style={{ marginTop: 14 }}>
              <b className="small">子任务列表（按执行顺序）</b>
              <div style={{ marginTop: 8 }}>
                {selectedPlan.tasks.map((task) => (
                  <div
                    key={task.id}
                    style={{
                      padding: 10,
                      marginBottom: 8,
                      border: '1px solid #2a2f3a',
                      borderRadius: 6,
                      background: '#1a1d24'
                    }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <span className="badge ok">#{task.planSeq}</span>
                      <span className="badge">{task.taskKind ? SUB_TASK_KIND_LABEL[task.taskKind] : '—'}</span>
                      <b>{task.title}</b>
                      <StatusBadge status={task.status} errorCode={task.errorCode} />
                      <span className="muted small mono">{task.agentId}</span>
                    </div>
                    <div className="small muted" style={{ marginBottom: 4 }}>
                      {task.prompt}
                    </div>
                    <div className="small">
                      <span className="muted">验收标准：</span>
                      {task.acceptance}
                    </div>
                    {task.dependsOn.length > 0 ? (
                      <div className="small">
                        <span className="muted">依赖：</span>
                        第 {task.dependsOn.map((depId) => {
                          const dep = selectedPlan.tasks.find((t) => t.id === depId)
                          return dep ? `#${dep.planSeq}` : '?'
                        }).join(', ')} 步
                      </div>
                    ) : null}
                    {task.finalText ? (
                      <div className="small" style={{ marginTop: 6 }}>
                        <span className="muted">输出：</span>
                        {task.finalText.slice(0, 100)}
                        {task.finalText.length > 100 ? '…' : ''}
                      </div>
                    ) : null}
                    {task.blockedReason ? (
                      <div className="alert warn" style={{ marginTop: 6, marginBottom: 0 }}>
                        {task.blockedReason}
                      </div>
                    ) : null}
                    {task.errorMessage && !task.blockedReason ? (
                      <div className="alert error" style={{ marginTop: 6, marginBottom: 0 }}>
                        {task.errorMessage}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </Section>
      ) : null}

      <Section title="任务列表">
        {tasks.length === 0 ? (
          <Card>
            <p className="muted small">还没有任务。先在上方创建一个 Mock 任务并执行。</p>
          </Card>
        ) : (
          <Card>
            <table>
              <thead>
                <tr>
                  <th>标题</th>
                  <th>Agent</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>耗时</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr
                    key={task.id}
                    className={selectedId === task.id ? 'selected' : ''}
                    onClick={() => void selectTask(task)}
                  >
                    <td>{task.title}</td>
                    <td className="mono">{task.agentId}</td>
                    <td>
                      <span className={`badge ${task.isRealCall ? 'warn' : 'ok'}`}>
                        {task.isRealCall ? '真实调用' : 'Mock'}
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={task.status} errorCode={task.errorCode} />
                    </td>
                    <td>{formatTime(task.createdAt)}</td>
                    <td>{formatDuration(task.durationMs)}</td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <div className="btn-row">
                        <button
                          className="btn small"
                          type="button"
                          disabled={busy || task.status !== 'pending'}
                          onClick={() => void handleRun(task)}
                        >
                          {task.isRealCall ? '执行真实任务' : '执行（Mock）'}
                        </button>
                        {task.status === 'running' ? (
                          <button className="btn small danger" type="button" onClick={() => void handleCancel(task)}>
                            取消
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      {detail ? (
        <Section
          title="任务详情"
          extra={<StatusBadge status={detail.status} errorCode={detail.errorCode} />}
        >
          <Card>
            <div className="kv">
              <span className="k">任务 ID</span>
              <span className="mono">{detail.id}</span>
              <span className="k">标题</span>
              <span>{detail.title}</span>
              <span className="k">适配器 / 类型</span>
              <span>
                <span className="mono">{detail.adapterId}</span>{' '}
                {detail.isRealCall ? '（真实调用，可能产生费用）' : '（本地模拟，不产生费用）'}
              </span>
              <span className="k">状态</span>
              <span>{taskStatusText(detail)}</span>
              <span className="k">开始 / 结束</span>
              <span>
                {formatTime(detail.startedAt)} → {formatTime(detail.endedAt)}
              </span>
              <span className="k">耗时 / 退出码</span>
              <span>
                {formatDuration(detail.durationMs)} / {detail.exitCode ?? '—'}
              </span>
              <span className="k">会话 ID</span>
              <span className="mono">{detail.sessionId ?? '—'}</span>
              <span className="k">会话目录</span>
              <span className="mono">
                {detail.sessionDir ?? '—（未定位；工作台不会自动删除会话目录）'}
              </span>
              <span className="k">尝试次数</span>
              <span>{detail.attempt}（本阶段禁止自动重试，恒为 1）</span>
              {detail.errorCode ? (
                <>
                  <span className="k">错误码 / 分类</span>
                  <span>
                    <span className="mono">{detail.errorCode}</span>
                    {detail.failureKind ? ` / ${FAILURE_KIND_LABEL[detail.failureKind]}` : ''}
                  </span>
                </>
              ) : null}
            </div>

            {detail.userNotice ? (
              <div className="alert warn" style={{ marginTop: 12, marginBottom: 0 }}>
                {detail.userNotice}
              </div>
            ) : null}
            {detail.errorMessage ? (
              <div className="alert error" style={{ marginTop: 12, marginBottom: 0 }}>
                {detail.errorMessage}
              </div>
            ) : null}

            <div style={{ marginTop: 14 }}>
              <b className="small">输入内容（prompt）</b>
              <pre className="block">{detail.prompt}</pre>
            </div>

            <div style={{ marginTop: 14 }}>
              <b className="small">最终结果（final.text）</b>
              <pre className="block">
                {detail.finalText === null || detail.finalText === ''
                  ? '(无最终文本)'
                  : detail.finalText}
              </pre>
            </div>

            <div style={{ marginTop: 14 }}>
              <b className="small">用量与费用（token 与金额分开记录）</b>
              <UsagePanel usage={detail.usage} />
            </div>

            <div style={{ marginTop: 14 }}>
              <b className="small">原始事件流</b>
              <EventStream events={events} live={detail.status === 'running'} />
            </div>

            <div className="btn-row" style={{ marginTop: 14 }}>
              <button
                className="btn"
                type="button"
                disabled={busy || detail.status !== 'pending'}
                onClick={() => void handleRun(detail)}
              >
                {detail.isRealCall ? '执行真实任务（需确认）' : '执行（Mock）'}
              </button>
              {detail.status === 'running' ? (
                <button className="btn danger" type="button" onClick={() => void handleCancel(detail)}>
                  取消本地进程
                </button>
              ) : null}
              {detail.isRealCall && detail.status === 'pending' ? (
                <label className="checkbox" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={realConfirm}
                    onChange={(event) => setRealConfirm(event.target.checked)}
                  />
                  <span>我已确认本次会产生真实调用，且金额无法核验。</span>
                </label>
              ) : null}
            </div>

            {detail.isRealCall && detail.status === 'pending' && realCallsDisabled ? (
              <p className="inline-note">请先在「设置」中开启真实调用总开关，才能执行真实任务。</p>
            ) : null}
            {detail.failureKind === 'timeout' || detail.failureKind === 'cancelled' ? (
              <p className="inline-note">{REMOTE_NOT_STOPPED_WARNING}</p>
            ) : null}
          </Card>
        </Section>
      ) : null}

      <Section title="本阶段未实现（后续阶段）">
        <Card>
          <ul className="todo-list">
            <li>主管 Agent 自动拆解任务（真实模型版）—— 未实现（当前为 Mock Planner）</li>
            <li>多 Agent 自动分工、Agent 之间互相调用 —— 未实现</li>
            <li>自动重试 / 自动循环修复 —— 未实现（当前固定禁止自动重试）</li>
            <li>自动排队：并发超限时不会自动排队后偷偷开跑，需要你手动再次执行</li>
          </ul>
        </Card>
      </Section>
    </div>
  )
}

/** 供其他页面复用的状态文案（避免各处重复硬编码）。 */
export const TASK_STATUS_ORDER: TaskStatus[] = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'needs_confirmation'
]
