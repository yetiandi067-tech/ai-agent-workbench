import type { Skill, SkillContext, SkillRegistry, SkillResult } from '../../shared/types'

/**
 * 技能注册表：管理所有可用技能。
 *
 * 技能是 Agent 可调用的能力单元，例如文件读写、代码分析、文本处理等。
 * 所有接入的 Agent 都可以通过技能注册表调用这些能力。
 */
export class SkillRegistryImpl implements SkillRegistry {
  private readonly skills = new Map<string, Skill>()

  register(skill: Skill): void {
    if (this.skills.has(skill.id)) {
      throw new Error(`技能已存在：${skill.id}`)
    }
    this.skills.set(skill.id, skill)
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id)
  }

  list(): Skill[] {
    return Array.from(this.skills.values())
  }

  listByCategory(category: string): Skill[] {
    return this.list().filter((skill) => skill.category === category)
  }

  async execute(
    id: string,
    ctx: SkillContext,
    params: Record<string, unknown>
  ): Promise<SkillResult> {
    const skill = this.skills.get(id)
    if (!skill) {
      return { success: false, output: '', error: `技能不存在：${id}` }
    }

    // 校验必填参数
    for (const param of skill.params) {
      if (param.required && params[param.name] === undefined) {
        return { success: false, output: '', error: `缺少必填参数：${param.name}` }
      }
    }

    try {
      ctx.logger.info(`执行技能：${skill.name}`, { taskId: ctx.taskId, skillId: id })
      return await skill.handler(ctx, params)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.info(`技能执行失败：${skill.name}`, { error: message })
      return { success: false, output: '', error: message }
    }
  }
}

/** 创建技能注册表（单例）。 */
export function createSkillRegistry(): SkillRegistry {
  return new SkillRegistryImpl()
}
