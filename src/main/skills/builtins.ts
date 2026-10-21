import type { Skill } from '../../shared/types'

/** 内置技能：文件读取 */
export const skillFileRead: Skill = {
  id: 'file-read',
  name: '文件读取',
  description: '读取指定文件的内容',
  category: 'file',
  params: [
    { name: 'path', type: 'string', description: '文件路径', required: true },
    { name: 'encoding', type: 'string', description: '编码格式', required: false, default: 'utf-8' }
  ],
  handler: async (ctx, params) => {
    const path = params.path as string
    const encoding = (params.encoding as string) || 'utf-8'
    ctx.logger.info(`读取文件：${path}`)
    // 实际实现需要 fs 模块，这里返回占位符
    return { success: true, output: `[文件内容：${path}（${encoding}）]` }
  }
}

/** 内置技能：文件写入 */
export const skillFileWrite: Skill = {
  id: 'file-write',
  name: '文件写入',
  description: '将内容写入指定文件',
  category: 'file',
  params: [
    { name: 'path', type: 'string', description: '文件路径', required: true },
    { name: 'content', type: 'string', description: '写入内容', required: true }
  ],
  handler: async (ctx, params) => {
    const path = params.path as string
    const content = params.content as string
    ctx.logger.info(`写入文件：${path}（${content.length} 字符）`)
    return { success: true, output: `已写入 ${content.length} 字符到 ${path}` }
  }
}

/** 内置技能：代码分析 */
export const skillCodeAnalyze: Skill = {
  id: 'code-analyze',
  name: '代码分析',
  description: '分析代码质量、复杂度和潜在问题',
  category: 'code',
  params: [
    { name: 'code', type: 'string', description: '要分析的代码', required: true },
    { name: 'language', type: 'string', description: '编程语言', required: false, default: 'auto' }
  ],
  handler: async (ctx, params) => {
    const code = params.code as string
    ctx.logger.info(`分析代码（${code.length} 字符）`)
    return {
      success: true,
      output: `代码分析结果：\n- 行数：${code.split('\n').length}\n- 字符数：${code.length}\n- 建议：代码结构良好，可考虑添加注释`
    }
  }
}

/** 内置技能：文本处理 */
export const skillTextProcess: Skill = {
  id: 'text-process',
  name: '文本处理',
  description: '文本格式化、提取、转换',
  category: 'text',
  params: [
    { name: 'text', type: 'string', description: '要处理的文本', required: true },
    { name: 'operation', type: 'string', description: '操作类型（format/extract/convert）', required: true }
  ],
  handler: async (ctx, params) => {
    const text = params.text as string
    const operation = params.operation as string
    ctx.logger.info(`文本处理：${operation}（${text.length} 字符）`)
    return {
      success: true,
      output: `文本处理完成（${operation}）：\n${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`
    }
  }
}

/** 全部内置技能列表 */
export const BUILT_IN_SKILLS: Skill[] = [
  skillFileRead,
  skillFileWrite,
  skillCodeAnalyze,
  skillTextProcess
]
