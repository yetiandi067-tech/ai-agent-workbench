/**
 * 日志 / 诊断文本脱敏。
 *
 * 用途：工作台会把子进程的 stderr 摘要、诊断信息写进日志与数据库。这些文本里
 * 可能夹带凭据（例如 `DEEPSEEK_API_KEY=sk-...`）。**写盘之前必须先过这里。**
 *
 * 原则：只脱敏「看起来像值」的部分，保留键名（键名本身有助于排查，
 * 例如 `MISSING_CREDENTIAL ... no API key for provider route "deepseek-official"`
 * 里的 DEEPSEEK_API_KEY 只是一个变量名，不是秘密，不应被抹掉）。
 */
const REDACTED = '***REDACTED***'

interface Rule {
  name: string
  pattern: RegExp
  replace: (match: string, ...groups: string[]) => string
}

const RULES: Rule[] = [
  {
    // OpenAI 风格密钥
    name: 'sk-key',
    pattern: /\bsk-[A-Za-z0-9_-]{6,}\b/g,
    replace: () => `sk-${REDACTED}`
  },
  {
    // Authorization: Bearer xxx
    name: 'bearer',
    pattern: /\b(Bearer)(\s+)([A-Za-z0-9._~+/-]{12,}=*)/gi,
    replace: (_m, scheme: string, space: string) => `${scheme}${space}${REDACTED}`
  },
  {
    // JWT
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
    replace: () => REDACTED
  },
  {
    // key=value / key: value 形式（保留键名，抹掉值）
    name: 'key-value',
    pattern:
      /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)([^\s"'`,;]{6,})/gi,
    replace: (_m, prefix: string) => `${prefix}${REDACTED}`
  },
  {
    // JSON 里带引号的凭据字段（值必须够长，避免误伤 "token": "" 之类）
    name: 'json-credential',
    pattern: /("(?:token|apiKey|api_key|accessToken|refreshToken|password|secret)"\s*:\s*")([^"]{16,})(")/gi,
    replace: (_m, prefix: string, _v: string, suffix: string) => `${prefix}${REDACTED}${suffix}`
  },
  {
    // 长十六进制串（哈希 / 密钥）
    name: 'long-hex',
    pattern: /\b[A-Fa-f0-9]{40,}\b/g,
    replace: () => REDACTED
  }
]

export function redactText(input: string): string {
  let output = input
  for (const rule of RULES) {
    output = output.replace(rule.pattern, (...args: unknown[]) => {
      const [match, ...groups] = args as [string, ...string[]]
      return rule.replace(match, ...groups)
    })
  }
  return output
}

/** 脱敏 + 截断，用于把诊断信息写进数据库 / 日志。 */
export function redactAndTruncate(input: string, maxLength = 4000): string {
  const safe = redactText(input)
  if (safe.length <= maxLength) return safe
  return `${safe.slice(0, maxLength)}\n…（已截断，共 ${safe.length} 字符）`
}
