import { useEffect, useState, type ReactNode } from 'react'

import { api, errorMessage } from '../api'
import { EmptyState } from './ui'

interface Skill {
  id: string
  name: string
  description: string
  category: string
}

interface SkillResult {
  success: boolean
  output: string
  error?: string
}

/**
 * 技能面板：展示所有可用技能，支持手动执行。
 */
export function SkillsPanel(): ReactNode {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(false)
  const [executing, setExecuting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, SkillResult>>({})

  useEffect(() => {
    void loadSkills()
  }, [])

  const loadSkills = async () => {
    setLoading(true)
    try {
      const list = await api.listSkills()
      setSkills(list)
    } catch (error) {
      console.error('加载技能失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const executeSkill = async (skillId: string) => {
    setExecuting(skillId)
    try {
      // 简单提示输入参数
      const paramsJson = prompt('请输入技能参数（JSON 格式）：', '{}')
      if (!paramsJson) {
        setExecuting(null)
        return
      }

      const params = JSON.parse(paramsJson)
      const result = await api.executeSkill(skillId, params)
      setResults((prev) => ({ ...prev, [skillId]: result }))
    } catch (error) {
      setResults((prev) => ({
        ...prev,
        [skillId]: { success: false, output: '', error: errorMessage(error) }
      }))
    } finally {
      setExecuting(null)
    }
  }

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--muted)' }}>加载中...</div>
  }

  if (skills.length === 0) {
    return <EmptyState title="暂无可用技能" description="技能系统尚未初始化" />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {skills.map((skill) => (
        <div
          key={skill.id}
          style={{
            padding: '16px',
            background: 'var(--bg-soft)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            transition: 'all 0.15s'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>
                {getSkillIcon(skill.category)} {skill.name}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '8px' }}>
                {skill.description}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                分类: {skill.category}
              </div>
            </div>
            <button
              onClick={() => void executeSkill(skill.id)}
              disabled={executing === skill.id}
              style={{
                padding: '6px 16px',
                background: executing === skill.id ? 'var(--muted)' : 'var(--accent)',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: executing === skill.id ? 'not-allowed' : 'pointer',
                fontSize: '12px',
                fontWeight: 500
              }}
            >
              {executing === skill.id ? '执行中...' : '执行'}
            </button>
          </div>

          {results[skill.id] && (
            <div
              style={{
                marginTop: '12px',
                padding: '12px',
                background: results[skill.id].success ? 'var(--ok-soft)' : 'var(--err-soft)',
                borderRadius: '6px',
                fontSize: '12px'
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                {results[skill.id].success ? '✅ 执行成功' : '❌ 执行失败'}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '11px' }}>
                {results[skill.id].output || results[skill.id].error}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function getSkillIcon(category: string): string {
  const iconMap: Record<string, string> = {
    'file': '📄',
    'code': '🔍',
    'text': '📝',
    'default': '🔧'
  }
  return iconMap[category] || iconMap.default
}
