import { useEffect, useState, useRef, type ReactNode } from 'react'
import type { Conversation, Message } from '../../../shared/types'

/**
 * 对话式 AI 工作台主页面。
 *
 * 布局：
 * - 左侧：对话列表 + Agent 状态 + 快速操作
 * - 右侧：当前对话（消息流 + 输入框）
 */
export default function ChatPage(): ReactNode {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 加载对话列表
  useEffect(() => {
    void loadConversations()
  }, [])

  // 加载当前对话的消息
  useEffect(() => {
    if (currentConversationId) {
      void loadMessages(currentConversationId)
    }
  }, [currentConversationId])

  // 滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const loadConversations = async () => {
    const list = await window.workbench.listConversations()
    setConversations(list)
    if (list.length > 0 && !currentConversationId) {
      setCurrentConversationId(list[0].id)
    }
  }

  const loadMessages = async (conversationId: string) => {
    const list = await window.workbench.listMessages(conversationId)
    setMessages(list)
  }

  const createConversation = async () => {
    const conversation = await window.workbench.createConversation()
    await loadConversations()
    setCurrentConversationId(conversation.id)
  }

  const sendMessage = async () => {
    if (!input.trim() || !currentConversationId) return

    setLoading(true)
    try {
      const newMessages = await window.workbench.sendMessage(currentConversationId, input)
      setMessages((prev) => [...prev, ...newMessages])
      setInput('')
    } catch (error) {
      console.error('发送消息失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  }

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg)' }}>
      {/* 左侧：对话列表 */}
      <div
        style={{
          width: '280px',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-soft)'
        }}
      >
        {/* 对话列表头部 */}
        <div
          style={{
            padding: '16px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>对话</h3>
          <button
            onClick={() => void createConversation()}
            style={{
              padding: '6px 12px',
              background: 'var(--accent)',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '12px'
            }}
          >
            新建
          </button>
        </div>

        {/* 对话列表 */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {conversations.map((conv) => (
            <div
              key={conv.id}
              onClick={() => setCurrentConversationId(conv.id)}
              style={{
                padding: '12px 16px',
                cursor: 'pointer',
                background: currentConversationId === conv.id ? 'var(--bg)' : 'transparent',
                borderLeft:
                  currentConversationId === conv.id
                    ? '2px solid var(--accent)'
                    : '2px solid transparent',
                transition: 'all 0.15s'
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px' }}>
                {conv.title}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                {conv.messageCount} 条消息
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 右侧：对话窗口 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {currentConversationId ? (
          <>
            {/* 消息流 */}
            <div style={{ flex: 1, overflow: 'auto', padding: '20px' }}>
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  style={{
                    marginBottom: '16px',
                    display: 'flex',
                    flexDirection: msg.role === 'user' ? 'row-reverse' : 'row'
                  }}
                >
                  <div
                    style={{
                      maxWidth: '70%',
                      padding: '12px 16px',
                      borderRadius: '12px',
                      background:
                        msg.role === 'user'
                          ? 'var(--accent)'
                          : msg.role === 'agent'
                            ? 'var(--bg-soft)'
                            : 'var(--warn-soft)',
                      color: msg.role === 'user' ? 'white' : 'var(--text)',
                      border: msg.role === 'agent' ? '1px solid var(--border)' : 'none'
                    }}
                  >
                    {msg.role === 'agent' && msg.agentId && (
                      <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '6px' }}>
                        {msg.agentId}
                      </div>
                    )}
                    <div style={{ fontSize: '13px', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
                      {msg.content}
                    </div>
                    {msg.metadata && (
                      <div
                        style={{
                          fontSize: '11px',
                          color: msg.role === 'user' ? 'rgba(255,255,255,0.7)' : 'var(--muted)',
                          marginTop: '8px'
                        }}
                      >
                        {msg.metadata.duration && `⏱️ ${msg.metadata.duration}ms`}
                        {msg.metadata.tokens && ` · 🔢 ${msg.metadata.tokens} tokens`}
                        {msg.metadata.cost && ` · 💰 ¥${msg.metadata.cost.toFixed(4)}`}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* 输入框 */}
            <div
              style={{
                padding: '16px 20px',
                borderTop: '1px solid var(--border)',
                background: 'var(--bg-soft)'
              }}
            >
              <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入消息... (@DeepSeek @Trae @WorkBuddy)"
                  disabled={loading}
                  style={{
                    flex: 1,
                    padding: '12px',
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    color: 'var(--text)',
                    fontSize: '13px',
                    fontFamily: 'inherit',
                    resize: 'none',
                    minHeight: '44px',
                    maxHeight: '120px'
                  }}
                />
                <button
                  onClick={() => void sendMessage()}
                  disabled={loading || !input.trim()}
                  style={{
                    padding: '12px 24px',
                    background: loading || !input.trim() ? 'var(--muted)' : 'var(--accent)',
                    color: 'white',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                    fontSize: '13px',
                    fontWeight: 500
                  }}
                >
                  {loading ? '发送中...' : '发送'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--muted)'
            }}
          >
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '48px', marginBottom: '16px' }}>💬</div>
              <div style={{ fontSize: '14px' }}>选择一个对话或创建新对话</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
