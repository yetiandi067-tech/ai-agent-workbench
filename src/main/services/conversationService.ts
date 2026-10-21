import { randomUUID } from 'node:crypto'

import type {
  Conversation,
  Intent,
  Message,
  MessageMetadata,
  TaskDraft
} from '../../shared/types'
import type { Repositories } from '../db/repositories'
import type { Logger } from '../logger'
import type { WorkbenchService } from './workbenchService'

export interface ConversationServiceDeps {
  repos: Repositories
  logger: Logger
  workbench: WorkbenchService
}

/**
 * 对话服务：管理对话和消息，支持意图识别和任务自动拆解。
 *
 * 职责：
 * - 创建/删除/更新对话
 * - 发送/接收消息
 * - 意图识别（规则引擎）
 * - 任务自动拆解
 * - 多 Agent 路由
 */
export class ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {}

  /** 创建新对话。 */
  createConversation(title?: string): Conversation {
    const now = new Date().toISOString()
    const conversation: Conversation = {
      id: randomUUID(),
      title: title ?? `新对话 ${new Date().toLocaleString('zh-CN')}`,
      createdAt: now,
      updatedAt: now,
      messageCount: 0
    }
    this.deps.repos.conversations.create(conversation)
    this.deps.logger.info('创建对话', { conversationId: conversation.id, title: conversation.title })
    return conversation
  }

  /** 列出所有对话。 */
  listConversations(): Conversation[] {
    return this.deps.repos.conversations.list()
  }

  /** 获取对话详情。 */
  getConversation(id: string): Conversation | null {
    return this.deps.repos.conversations.get(id)
  }

  /** 删除对话（级联删除消息）。 */
  deleteConversation(id: string): void {
    this.deps.repos.conversations.delete(id)
    this.deps.logger.info('删除对话', { conversationId: id })
  }

  /** 获取对话的所有消息。 */
  listMessages(conversationId: string): Message[] {
    return this.deps.repos.messages.listByConversation(conversationId)
  }

  /**
   * 发送消息。
   *
   * 流程：
   * 1. 保存用户消息
   * 2. 识别意图
   * 3. 如果是任务意图，自动创建任务
   * 4. 如果是 @提及，路由到多个 Agent
   * 5. 返回 Agent 回复
   */
  async sendMessage(conversationId: string, content: string): Promise<Message[]> {
    const conversation = this.getConversation(conversationId)
    if (!conversation) throw new Error(`对话不存在：${conversationId}`)

    const now = new Date().toISOString()

    // 1. 保存用户消息
    const userMessage: Message = {
      id: randomUUID(),
      conversationId,
      role: 'user',
      agentId: null,
      content,
      createdAt: now,
      taskIds: [],
      metadata: null
    }
    this.deps.repos.messages.create(userMessage)

    // 2. 识别意图
    const intent = this.detectIntent(content)

    // 3. 检测 @提及
    const mentions = this.detectMentions(content)

    // 4. 根据意图和提及路由
    const replies: Message[] = []

    if (mentions.length > 0) {
      // 多 Agent 群聊：@提及
      for (const agentId of mentions) {
        const reply = await this.routeToAgent(conversationId, content, agentId)
        replies.push(reply)
      }
    } else if (intent.type === 'task') {
      // 任务意图：自动拆解并创建任务
      const taskDrafts = intent.suggestedTasks ?? []
      const taskIds: string[] = []

      for (const draft of taskDrafts) {
        try {
          const task = this.deps.workbench.createTask({
            title: draft.title,
            prompt: draft.prompt,
            agentId: draft.agentId
          })
          taskIds.push(task.id)
        } catch (error) {
          this.deps.logger.error('自动创建任务失败', { error, draft })
        }
      }

      // 创建系统消息
      const systemMessage: Message = {
        id: randomUUID(),
        conversationId,
        role: 'system',
        agentId: null,
        content: `已自动创建 ${taskIds.length} 个任务`,
        createdAt: new Date().toISOString(),
        taskIds,
        metadata: null
      }
      this.deps.repos.messages.create(systemMessage)
      replies.push(systemMessage)
    } else {
      // 普通对话：默认路由到 Mock
      const reply = await this.routeToAgent(conversationId, content, 'mock')
      replies.push(reply)
    }

    // 5. 更新对话
    conversation.updatedAt = new Date().toISOString()
    conversation.messageCount += 1 + replies.length
    this.deps.repos.conversations.update(conversation)

    return [userMessage, ...replies]
  }

  /**
   * 意图识别（规则引擎）。
   *
   * 规则：
   * - 包含"帮我"、"请"、"执行"等动词 → 任务意图
   * - 包含"@xxx" → 多 Agent 群聊
   * - 其他 → 普通对话
   */
  private detectIntent(content: string): Intent {
    const taskKeywords = ['帮我', '请', '执行', '运行', '分析', '生成', '翻译', '整理', '检查']
    const hasTaskKeyword = taskKeywords.some((keyword) => content.includes(keyword))

    if (hasTaskKeyword) {
      return {
        type: 'task',
        confidence: 0.7,
        suggestedAgents: ['mock'],
        suggestedTasks: this.generateTaskDrafts(content)
      }
    }

    return {
      type: 'chat',
      confidence: 0.9,
      suggestedAgents: ['mock']
    }
  }

  /**
   * 检测 @提及。
   *
   * 支持：@DeepSeek、@Trae、@WorkBuddy、@Mock
   */
  private detectMentions(content: string): string[] {
    const mentions: string[] = []
    const agentMap: Record<string, string> = {
      'deepseek': 'dsh',
      'trae': 'trae-cn',
      'workbuddy': 'workbuddy',
      'mock': 'mock'
    }

    for (const [keyword, agentId] of Object.entries(agentMap)) {
      if (content.toLowerCase().includes(`@${keyword}`)) {
        mentions.push(agentId)
      }
    }

    return mentions
  }

  /**
   * 生成任务草稿（规则引擎）。
   *
   * 简单规则：
   * - 包含"分析" → 代码分析任务
   * - 包含"翻译" → 翻译任务
   * - 包含"生成" → 生成任务
   * - 默认 → 通用任务
   */
  private generateTaskDrafts(content: string): TaskDraft[] {
    if (content.includes('分析')) {
      return [{
        title: '代码分析',
        prompt: content,
        agentId: 'mock',
        skills: ['code-analyze']
      }]
    }

    if (content.includes('翻译')) {
      return [{
        title: '文本翻译',
        prompt: content,
        agentId: 'mock',
        skills: ['text-process']
      }]
    }

    return [{
      title: content.slice(0, 50),
      prompt: content,
      agentId: 'mock'
    }]
  }

  /**
   * 路由到指定 Agent。
   *
   * 流程：
   * 1. 创建任务
   * 2. 执行任务
   * 3. 返回 Agent 回复消息
   */
  private async routeToAgent(
    conversationId: string,
    content: string,
    agentId: string
  ): Promise<Message> {
    const startTime = Date.now()

    try {
      // 创建任务
      const task = this.deps.workbench.createTask({
        title: content.slice(0, 50),
        prompt: content,
        agentId
      })

      // 执行任务（Mock 任务直接执行）
      if (agentId === 'mock') {
        await this.deps.workbench.runTask(task.id, false)
      }

      const updatedTask = this.deps.workbench.getTask(task.id)
      const duration = Date.now() - startTime

      const metadata: MessageMetadata = {
        duration,
        tokens: updatedTask?.usage?.totalTokens ?? undefined,
        cost: updatedTask?.usage?.actualCost ?? undefined
      }

      const agentMessage: Message = {
        id: randomUUID(),
        conversationId,
        role: 'agent',
        agentId,
        content: updatedTask?.finalText ?? '任务已创建，等待执行',
        createdAt: new Date().toISOString(),
        taskIds: [task.id],
        metadata
      }
      this.deps.repos.messages.create(agentMessage)

      return agentMessage
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      const errorMessage: Message = {
        id: randomUUID(),
        conversationId,
        role: 'system',
        agentId: null,
        content: `Agent ${agentId} 执行失败：${errorText}`,
        createdAt: new Date().toISOString(),
        taskIds: [],
        metadata: { error: errorText }
      }
      this.deps.repos.messages.create(errorMessage)

      return errorMessage
    }
  }
}
