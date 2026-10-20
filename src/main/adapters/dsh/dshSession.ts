import { readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * 会话目录定位（只读、尽力而为）。
 *
 * 实测事实：DSH 每次 run 会按 cwd 在 `$DSH_HOME/sessions/--<转义 cwd>--/` 下落
 * 一个以 sessionId 命名的会话目录。**转义规则未验证**，所以这里不猜测目录名，
 * 而是按名字搜索 —— 这比凭猜测拼路径更可靠。
 *
 * 本模块只做定位与记录，**绝不删除任何目录**。
 */
export function locateSessionDir(
  dshHomeDir: string,
  sessionId: string,
  maxDepth = 4
): string | null {
  if (!sessionId) return null
  const root = join(dshHomeDir, 'sessions')
  try {
    return walk(root, sessionId, maxDepth)
  } catch {
    return null
  }
}

function walk(dir: string, target: string, depthLeft: number): string | null {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }

  if (entries.some((e) => e.name === target)) {
    return join(dir, target)
  }
  if (depthLeft <= 0) return null

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = walk(join(dir, entry.name), target, depthLeft - 1)
    if (found) return found
  }
  return null
}

/** 会话落盘位置的中立说明（用于设置页与文档，不含任何猜测）。 */
export function describeSessionPolicy(dshHomeDir: string): string {
  return (
    `会话目录位于 ${join(dshHomeDir, 'sessions')} 下（每次 run 按 cwd 生成一个以 sessionId ` +
    `命名的目录）。目录名依赖未验证的 cwd 转义规则，因此本工作台只用「按名字搜索」定位，` +
    `不会自动删除任何会话目录。清理策略留待后续阶段人工审查后再定。`
  )
}
