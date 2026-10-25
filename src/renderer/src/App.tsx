import { useEffect, useState, type ReactNode } from 'react'

import type { TaskRecord } from '../../shared/types'
import { api } from './api'
import { CountBadge } from './components/ui'
import { IconAgents, IconChat, IconGrid, IconRuns, IconSettings, IconTasks } from './components/icons'
import AgentsPage from './pages/AgentsPage'
import ChatPage from './pages/ChatPage'
import OverviewPage from './pages/OverviewPage'
import RunsPage from './pages/RunsPage'
import SettingsPage from './pages/SettingsPage'
import TasksPage from './pages/TasksPage'

export type TabId = 'chat' | 'overview' | 'tasks' | 'agents' | 'runs' | 'settings'

const NAV: Array<{ id: TabId; label: string; icon: ReactNode }> = [
  { id: 'chat', label: '对话', icon: <IconChat /> },
  { id: 'overview', label: '总览', icon: <IconGrid /> },
  { id: 'tasks', label: '任务中心', icon: <IconTasks /> },
  { id: 'agents', label: 'Agent 管理', icon: <IconAgents /> },
  { id: 'runs', label: '运行记录', icon: <IconRuns /> },
  { id: 'settings', label: '设置', icon: <IconSettings /> }
]

export default function App(): ReactNode {
  const [tab, setTab] = useState<TabId>('chat')
  const [version, setVersion] = useState('')
  const [realCallsAllowed, setRealCallsAllowed] = useState<boolean | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [runningCount, setRunningCount] = useState(0)

  // 全局轻量任务状态：驱动导航徽章与侧栏状态区（数量随任务推送实时刷新）。
  useEffect(() => {
    let disposed = false
    const recount = (rows: TaskRecord[]): void => {
      setPendingCount(rows.filter((row) => row.status === 'needs_confirmation').length)
      setRunningCount(rows.filter((row) => row.status === 'running').length)
    }
    void (async () => {
      try {
        const [info, settings, tasks] = await Promise.all([
          api.getSystemInfo(),
          api.getSettings(),
          api.listTasks()
        ])
        if (disposed) return
        setVersion(info.appVersion)
        setRealCallsAllowed(settings.allowRealModelCalls)
        recount(tasks)
      } catch {
        // 徽章与状态区属非关键路径，失败时保持占位值即可。
      }
    })()
    const unsubscribe = api.onTaskChanged(() => {
      void api
        .listTasks()
        .then((rows) => {
          if (!disposed) recount(rows)
        })
        .catch(() => {})
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>AI 多 Agent 工作台</h1>
          <p>个人 Agent 指挥中心</p>
        </div>
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-item${tab === item.id ? ' active' : ''}`}
            onClick={() => setTab(item.id)}
            type="button"
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
            {item.id === 'chat' ? (
              <span className="nav-badge">
                <CountBadge count={pendingCount} />
              </span>
            ) : null}
            {item.id === 'tasks' ? (
              <span className="nav-badge">
                <CountBadge count={runningCount} tone="info" />
              </span>
            ) : null}
          </button>
        ))}
        <div className="sidebar-status">
          <div className="row">
            <span>运行中任务</span>
            <b>{runningCount}</b>
          </div>
          <div className="row">
            <span>待人工确认</span>
            <b>{pendingCount}</b>
          </div>
          <div className="row">
            <span>真实调用</span>
            <b>{realCallsAllowed === null ? '—' : realCallsAllowed ? '开' : '关'}</b>
          </div>
          <div className="row">
            <span>自动重试</span>
            <b>禁止</b>
          </div>
          <div className="row">
            <span>版本</span>
            <b>{version || '—'}</b>
          </div>
        </div>
      </aside>

      <main className={tab === 'chat' ? 'content chat-mode' : 'content'}>
        {tab === 'chat' ? <ChatPage onNavigate={setTab} /> : null}
        {tab === 'overview' ? <OverviewPage onNavigate={setTab} /> : null}
        {tab === 'tasks' ? <TasksPage /> : null}
        {tab === 'agents' ? <AgentsPage /> : null}
        {tab === 'runs' ? <RunsPage /> : null}
        {tab === 'settings' ? <SettingsPage /> : null}
      </main>
    </div>
  )
}
