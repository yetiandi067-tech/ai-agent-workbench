import { useState, type ReactNode } from 'react'

import AgentsPage from './pages/AgentsPage'
import OverviewPage from './pages/OverviewPage'
import RunsPage from './pages/RunsPage'
import SettingsPage from './pages/SettingsPage'
import TasksPage from './pages/TasksPage'

export type TabId = 'overview' | 'tasks' | 'agents' | 'runs' | 'settings'

const NAV: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: '总览' },
  { id: 'tasks', label: '任务中心' },
  { id: 'agents', label: 'Agent 管理' },
  { id: 'runs', label: '运行记录' },
  { id: 'settings', label: '设置' }
]

export default function App(): ReactNode {
  const [tab, setTab] = useState<TabId>('overview')

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>AI 多 Agent 工作台</h1>
          <p>第 4 步：主管 Agent（Mock 调度）+ DSH Adapter</p>
        </div>
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-item${tab === item.id ? ' active' : ''}`}
            onClick={() => setTab(item.id)}
            type="button"
          >
            <span className="dot" />
            {item.label}
          </button>
        ))}
        <div className="sidebar-footer">
          自动重试：禁止
          <br />
          真实任务并发上限：1
          <br />
          真实调用总开关：默认关闭
          <br />
          主管 Agent：Mock 调度已实现（真实调度未接入）
        </div>
      </aside>

      <main className="content">
        {tab === 'overview' ? <OverviewPage onNavigate={setTab} /> : null}
        {tab === 'tasks' ? <TasksPage /> : null}
        {tab === 'agents' ? <AgentsPage /> : null}
        {tab === 'runs' ? <RunsPage /> : null}
        {tab === 'settings' ? <SettingsPage /> : null}
      </main>
    </div>
  )
}
