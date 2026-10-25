import { useEffect, useState, type ReactNode } from 'react'

import { api, errorMessage } from '../api'
import { EmptyState, FormDialog, type FormFieldSpec } from './ui'

interface SkillParamMeta {
  name: string
  type: string
  description: string
  required: boolean
  default?: string
}

interface SkillMeta {
  id: string
  name: string
  description: string
  category: string
  params: SkillParamMeta[]
}

const CATEGORY_LABEL: Record<string, string> = {
  file: '文件',
  code: '代码',
  text: '文本'
}

/** 多行参数字段名（按内置技能的实际参数名约定）。 */
const TEXTAREA_FIELDS = new Set(['content', 'code', 'text'])

function toFieldSpec(param: SkillParamMeta): FormFieldSpec {
  return {
    name: param.name,
    label: param.description || param.name,
    type: TEXTAREA_FIELDS.has(param.name) ? 'textarea' : 'text',
    placeholder: param.default ? `默认：${param.default}` : `请输入${param.description || param.name}`,
    required: param.required,
    defaultValue: param.default
  }
}

/** 技能面板：技能列表 + 结构化参数表单执行（替代 window.prompt）。 */
export function SkillsPanel(): ReactNode {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [activeSkill, setActiveSkill] = useState<SkillMeta | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [execError, setExecError] = useState<string | null>(null)
  const [result, setResult] = useState<{ success: boolean; output: string } | null>(null)

  useEffect(() => {
    setLoading(true)
    api
      .listSkills()
      .then(setSkills)
      .catch((caught) => console.error('加载技能失败:', errorMessage(caught)))
      .finally(() => setLoading(false))
  }, [])

  const executeSkill = async (skill: SkillMeta, values: Record<string, string>): Promise<void> => {
    setSubmitting(true)
    setExecError(null)
    try {
      const outcome = await api.executeSkill(skill.id, values)
      setResult({ success: outcome.success, output: outcome.success ? outcome.output : outcome.error ?? '未知错误' })
    } catch (caught) {
      setExecError(errorMessage(caught))
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <div style={{ padding: '16px 0', color: 'var(--muted)' }}>技能加载中…</div>
  }

  if (skills.length === 0) {
    return <EmptyState title="暂无可用技能" description="技能注册表为空，请检查应用安装是否完整。" />
  }

  return (
    <div>
      <div className="skill-grid">
        {skills.map((skill) => (
          <div className="skill-item" key={skill.id}>
            <div className="info">
              <div className="name">{skill.name}</div>
              <div className="desc">{skill.description}</div>
              <div className="cat">
                <span className="badge">{CATEGORY_LABEL[skill.category] ?? skill.category}</span>
                {skill.params.length > 0 ? (
                  <span className="badge" style={{ marginLeft: 6 }}>
                    {skill.params.length} 个参数
                  </span>
                ) : null}
              </div>
            </div>
            <button
              className="btn primary small"
              type="button"
              onClick={() => {
                setActiveSkill(skill)
                setExecError(null)
                setResult(null)
              }}
            >
              执行
            </button>
          </div>
        ))}
      </div>

      <FormDialog
        key={activeSkill?.id ?? 'none'}
        open={activeSkill !== null}
        title={`执行技能：${activeSkill?.name ?? ''}`}
        description={activeSkill?.description}
        fields={(activeSkill?.params ?? []).map(toFieldSpec)}
        submitLabel="执行"
        submitting={submitting}
        error={execError}
        result={result}
        onSubmit={(values) => {
          if (!activeSkill) return
          void executeSkill(activeSkill, values)
        }}
        onCancel={() => setActiveSkill(null)}
      />
    </div>
  )
}
