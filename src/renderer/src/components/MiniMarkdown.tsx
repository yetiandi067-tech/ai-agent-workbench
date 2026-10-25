import type { ReactNode } from 'react'

/**
 * 极简 Markdown 渲染器（零依赖）。
 *
 * 支持对话场景最常用的子集：
 * - ``` 围栏代码块
 * - ` 行内代码
 * - **粗体**
 * - - / * 无序列表
 *
 * 不支持的语法按普通文本展示，保证 Agent 输出永远可读。
 */
export function MiniMarkdown({ text }: { text: string }): ReactNode {
  return <div className="md">{renderBlocks(text)}</div>
}

function renderBlocks(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // 按围栏代码块切分：奇数段为代码块
  const parts = text.split('```')
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const newline = part.indexOf('\n')
      const code = newline >= 0 ? part.slice(newline + 1) : part
      nodes.push(
        <pre key={`code-${index}`} className="block">
          <code>{code.replace(/\n$/, '')}</code>
        </pre>
      )
      return
    }
    nodes.push(...renderTextBlock(part, index))
  })
  return nodes
}

function renderTextBlock(text: string, keyBase: number): ReactNode[] {
  const out: ReactNode[] = []
  const lines = text.split('\n')
  let listItems: string[] = []

  const flushList = (key: string): void => {
    if (listItems.length > 0) {
      out.push(
        <ul key={`ul-${key}`}>
          {listItems.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      )
      listItems = []
    }
  }

  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (/^[-*]\s+/.test(trimmed)) {
      listItems.push(trimmed.replace(/^[-*]\s+/, ''))
      return
    }
    flushList(String(keyBase) + '-' + String(i))
    if (trimmed.length === 0) return
    out.push(<p key={`p-${keyBase}-${i}`}>{renderInline(trimmed)}</p>)
  })
  flushList(String(keyBase) + '-end')
  return out
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    if (match[1] !== undefined) {
      nodes.push(
        <code key={key++} className="inline">
          {match[1]}
        </code>
      )
    } else {
      nodes.push(<strong key={key++}>{match[2]}</strong>)
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}
