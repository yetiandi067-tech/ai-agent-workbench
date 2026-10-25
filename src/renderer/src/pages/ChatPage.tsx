import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { AgentDescriptor, Conversation, Message, TaskRecord } from '../../../shared/types'
import { api, errorMessage, formatMoney } from '../api'
import { MiniMarkdown } from '../components/MiniMarkdown'
import { AgentAvatar, ConfirmDialog, EmptyState, Spinner, TaskChip } from '../components/ui'
import { IconPlus, IconSend, IconTrash } from '../components/icons'
import type { TabId } from '../App'

/** 服务端 @提及路由所认得的关键词（conversationService.detectMentions）。 */
const MENTION_KEYWORD: Record<string, string> = {
  mock: 'mock',
  dsh: 'deepseek',
  'trae-cn': 'trae',
  workbuddy: 'workbuddy'
}

const QUICK_PROMPTS = ['帮我分析一段代码', '@trae 创建一个交接单任务', '总结今天的任务进展']

function fmtClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return sameDay
    ? hhmm
    : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hhmm}`
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return ''
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  const date = new Date(iso)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

interface ConvView extends Conversation {
  preview: string
}

/**
 * 对话式工作台主页面：左侧对话列表 + 右侧消息流。
 *
 * 人工交接在对话内闭环：needs_confirmation 任务的回填入口直接内嵌在
 * 关联的 Agent 回复气泡下方，回填结果实时反映在任务芯片状态上。
 */
export default function ChatPage({ onNavigate }: { onNavigate: (tab: TabId) => void }): ReactNode {
  const [conversations, setConversations] = useState<ConvView[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [taskRefs, setTaskRefs] = useState<Record<string, TaskRecord | null>>({})
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [handoffDrafts, setHandoffDrafts] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<ConvView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const loadConversations = useCallback(async (selectId?: string): Promise<void> => {
    try {
      const list = await api.listConversations()
      // 个人规模对话数有限，拉取各自最后一条消息做预览。
      const previews = await Promise.all(
        list.slice(0, 30).map(async (conv) => {
          try {
            const rows = await api.listMessages(conv.id)
            const last = rows[rows.length - 1]
            return [conv.id, last ? last.content.replace(/\s+/g, ' ').slice(0, 60) : ''] as const
          } catch {
            return [conv.id, ''] as const
          }
        })
      )
      const previewMap = new Map(previews)
      const views: ConvView[] = list.map((conv) => ({ ...conv, preview: previewMap.get(conv.id) ?? '' }))
      setConversations(views)
      const target = selectId ?? views[0]?.id ?? null
      setCurrentId((prev) => prev ?? target)
      if (selectId) setCurrentId(selectId)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [])

  const loadMessages = useCallback(async (conversationId: string): Promise<void> => {
    try {
      const rows = await api.listMessages(conversationId)
      setMessages(rows)
      // 拉取消息关联的任务，用于任务芯片与内联回填。
      const ids = [...new Set(rows.flatMap((row) => row.taskIds))]
      if (ids.length > 0) {
        const results = await Promise.all(ids.map(async (id) => [id, await api.getTask(id)] as const))
        setTaskRefs((prev) => {
          const next = { ...prev }
          for (const [id, task] of results) next[id] = task
          return next
        })
      }
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [])

  useEffect(() => {
    void loadConversations()
    void api
      .listAgents()
      .then(setAgents)
      .catch(() => {})
  }, [loadConversations])

  useEffect(() => {
    if (currentId) void loadMessages(currentId)
    else setMessages([])
  }, [currentId, loadMessages])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, sending])

  const agentName = useCallback(
    (agentId: string | null): { name: string; mode: AgentDescriptor['mode'] | undefined } => {
      if (!agentId) return { name: '系统', mode: undefined }
      const found = agents.find((agent) => agent.id === agentId)
      return { name: found?.name ?? agentId, mode: found?.mode }
    },
    [agents]
  )

  const mentionItems = useMemo(() => {
    return agents
      .filter((agent) => agent.mode !== 'unavailable')
      .map((agent) => ({ agent, keyword: MENTION_KEYWORD[agent.id] ?? agent.id }))
      .filter(
        ({ agent, keyword }) =>
          keyword.toLowerCase().includes(mentionQuery) ||
          agent.name.toLowerCase().includes(mentionQuery)
      )
  }, [agents, mentionQuery])

  const handleInputChange = (value: string): void => {
    setInput(value)
    const match = /@([\w-]*)$/.exec(value)
    if (match) {
      setMentionQuery(match[1].toLowerCase())
      setMentionOpen(true)
    } else {
      setMentionOpen(false)
    }
  }

  const applyMention = (keyword: string): void => {
    setInput((prev) => prev.replace(/@([\w-]*)$/, `@${keyword} `))
    setMentionOpen(false)
    inputRef.current?.focus()
  }

  const createConversation = async (): Promise<void> => {
    try {
      const created = await api.createConversation()
      await loadConversations(created.id)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const removeConversation = async (): Promise<void> => {
    if (!deleteTarget) return
    try {
      await api.deleteConversation(deleteTarget.id)
      const remaining = conversations.filter((conv) => conv.id !== deleteTarget.id)
      setConversations(remaining)
      if (currentId === deleteTarget.id) {
        setCurrentId(remaining[0]?.id ?? null)
        setMessages([])
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setDeleteTarget(null)
    }
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (text.length === 0 || !currentId || sending) return
    setSending(true)
    setError(null)
    setInput('')
    setMentionOpen(false)
    try {
      const reply = await api.sendMessage(currentId, text)
      setMessages((prev) => [...prev, ...reply])
      const ids = [...new Set(reply.flatMap((row) => row.taskIds))]
      if (ids.length > 0) {
        const results = await Promise.all(ids.map(async (id) => [id, await api.getTask(id)] as const))
        setTaskRefs((prev) => {
          const next = { ...prev }
          for (const [id, task] of results) next[id] = task
          return next
        })
      }
      await loadConversations(currentId)
    } catch (caught) {
      setError(errorMessage(caught))
      setInput(text)
    } finally {
      setSending(false)
    }
  }

  const openTask = (taskId: string): void => {
    window.dispatchEvent(new CustomEvent<string>('workbench:focus-task', { detail: taskId }))
    onNavigate('tasks')
  }

  const resolveHandoff = async (taskId: string, succeeded: boolean): Promise<void> => {
    try {
      await api.submitHandoffResult(taskId, handoffDrafts[taskId] ?? '', succeeded)
      const fresh = await api.getTask(taskId)
      setTaskRefs((prev) => ({ ...prev, [taskId]: fresh }))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const renderMessage = (msg: Message): ReactNode => {
    if (msg.role === 'user') {
      return (
        <div className="chat-msg user" key={msg.id}>
          <div className="chat-bubble">
            {msg.content}
            <div className="meta">{fmtClock(msg.createdAt)}</div>
          </div>
        </div>
      )
    }
    if (msg.role === 'system') {
      return (
        <div className="chat-msg system" key={msg.id}>
          <div className="chat-bubble">{msg.content}</div>
        </div>
      )
    }

    const { name, mode } = agentName(msg.agentId)
    const linkedTasks = msg.taskIds.map((id) => taskRefs[id]).filter((task): task is TaskRecord => !!task)
    return (
      <div className="chat-msg agent" key={msg.id}>
        <AgentAvatar name={name} mode={mode} />
        <div className="chat-bubble">
          <div className="chat-msg-head">
            <span className="name">{name}</span>
            <span>{fmtClock(msg.createdAt)}</span>
          </div>
          <MiniMarkdown text={msg.content} />
          {msg.metadata ? (
            <div className="meta">
              {msg.metadata.duration !== undefined ? <span>⏱ {msg.metadata.duration}ms</span> : null}
              {msg.metadata.tokens !== undefined ? <span>{msg.metadata.tokens} tokens</span> : null}
              {msg.metadata.cost !== undefined ? <span>{formatMoney(msg.metadata.cost)}</span> : null}
            </div>
          ) : null}
          {linkedTasks.length > 0 ? (
            <div className="chat-taskchips">
              {linkedTasks.map((task) => (
                <TaskChip key={task.id} taskId={task.id} title={task.title} status={task.status} onOpen={openTask} />
              ))}
            </div>
          ) : null}
          {linkedTasks
            .filter((task) => task.status === 'needs_confirmation')
            .map((task) => (
              <div className="chat-handoff" key={`handoff-${task.id}`}>
                <div className="chat-handoff-label">人工交接待回填 · {task.title}</div>
                <textarea
                  value={handoffDrafts[task.id] ?? ''}
                  placeholder="在目标 Agent 中执行后，把结果粘贴到这里（可留空）…"
                  onChange={(event) =>
                    setHandoffDrafts((prev) => ({ ...prev, [task.id]: event.target.value }))
                  }
                />
                <div className="chat-handoff-actions">
                  <button className="btn primary small" type="button" onClick={() => void resolveHandoff(task.id, true)}>
                    执行成功
                  </button>
                  <button className="btn danger small" type="button" onClick={() => void resolveHandoff(task.id, false)}>
                    执行失败
                  </button>
                </div>
              </div>
            ))}
        </div>
      </div>
    )
  }

  const currentConversation = conversations.find((conv) => conv.id === currentId) ?? null

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-header">
          <h3>对话</h3>
          <button className="icon-btn" type="button" title="新建对话" onClick={() => void createConversation()}>
            <IconPlus />
          </button>
        </div>
        <div className="chat-conv-list">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`chat-conv-item${conv.id === currentId ? ' active' : ''}`}
              onClick={() => setCurrentId(conv.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') setCurrentId(conv.id)
              }}
            >
              <div className="chat-conv-title">{conv.title}</div>
              <div className="chat-conv-meta">
                <span className="chat-conv-preview">{conv.preview || '暂无消息'}</span>
                <span>{fmtRelative(conv.updatedAt)}</span>
              </div>
              <button
                className="icon-btn chat-conv-delete"
                type="button"
                title="删除对话"
                onClick={(event) => {
                  event.stopPropagation()
                  setDeleteTarget(conv)
                }}
              >
                <IconTrash size={13} />
              </button>
            </div>
          ))}
          {conversations.length === 0 ? <div className="inline-note" style={{ padding: '10px 12px' }}>还没有对话</div> : null}
        </div>
      </aside>

      <section className="chat-main">
        {error ? (
          <div className="alert error" style={{ margin: '12px 16px 0' }}>
            {error}
            <button className="btn small" type="button" style={{ marginLeft: 10 }} onClick={() => setError(null)}>
              知道了
            </button>
          </div>
        ) : null}

        {!currentConversation ? (
          <div className="chat-empty-wrap">
            <EmptyState
              title="开始一段新对话"
              description="像聊天一样下达任务：直接描述需求，或用 @ 提及指定 Agent。支持 Mock 演练、真实模型调用与人工交接。"
              action={
                <button className="btn primary" type="button" onClick={() => void createConversation()}>
                  新建对话
                </button>
              }
            />
          </div>
        ) : (
          <>
            <div className="chat-messages">
              {messages.length === 0 ? (
                <div className="chat-empty-wrap">
                  <EmptyState
                    title={currentConversation.title}
                    description="发送第一条消息开始协作。"
                  />
                  <div className="chat-quick">
                    {QUICK_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        className="btn small"
                        type="button"
                        onClick={() => {
                          setInput(prompt)
                          inputRef.current?.focus()
                        }}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((msg) => renderMessage(msg))
              )}
              {sending ? (
                <div className="chat-msg agent">
                  <div className="chat-bubble pending">
                    <Spinner size="sm" label="正在调度 Agent，请稍候…" />
                  </div>
                </div>
              ) : null}
              <div ref={endRef} />
            </div>

            <div className="chat-composer">
              {mentionOpen && mentionItems.length > 0 ? (
                <div className="chat-mention">
                  {mentionItems.map(({ agent, keyword }) => (
                    <div
                      key={agent.id}
                      className="chat-mention-item"
                      onClick={() => applyMention(keyword)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') applyMention(keyword)
                      }}
                    >
                      <b>@{keyword}</b>
                      <span className="desc">{agent.name}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="chat-composer-row">
                <textarea
                  ref={inputRef}
                  value={input}
                  placeholder="输入消息…（@ 提及 Agent，Enter 发送）"
                  onChange={(event) => handleInputChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void send()
                    } else if (event.key === 'Escape') {
                      setMentionOpen(false)
                    }
                  }}
                />
                <button
                  className="btn primary chat-send"
                  type="button"
                  disabled={sending || input.trim().length === 0}
                  onClick={() => void send()}
                >
                  <IconSend size={14} />
                </button>
              </div>
              <div className="chat-hint">Enter 发送 · Shift+Enter 换行 · 输入 @ 唤起 Agent · 真实模型任务仍需显式确认</div>
            </div>
          </>
        )}
      </section>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除对话"
        message={`确定删除「${deleteTarget?.title ?? ''}」吗？对话内的全部消息将一并删除，且不可恢复。`}
        confirmLabel="删除"
        onConfirm={() => void removeConversation()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
