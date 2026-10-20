import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { redactAndTruncate } from '../../../shared/redact'
import {
  REMOTE_NOT_STOPPED_WARNING,
  type AgentDescriptor,
  type AgentRunEventDraft,
  type Capability,
  type CapabilityState,
  type UsageRecord
} from '../../../shared/types'
import {
  TIMEOUT_REASON,
  emptyDiagnostics,
  type AgentAdapter,
  type RunHooks,
  type RunInput,
  type RunOutcome
} from '../types'
import { DshStreamAccumulator, classifyDshOutcome, type DshTokenUsage } from './ndjson'
import { describeSessionPolicy, locateSessionDir } from './dshSession'

export interface DshAdapterOptions {
  /** `DeepSeek Harness.exe` 的绝对路径。 */
  exePath: string
  /** asar 内的 cli.js 绝对路径（只有 Electron 打过补丁的 fs 能看见它）。 */
  cliScript: string
  profile: string
  dshHomeDir: string
  /**
   * 纵深防御：即使是真实适配器，也必须先确认用户已显式授权真实调用。
   * 返回 false 时直接拒绝，**不启动任何子进程**。
   */
  allowRealCall: () => { allowed: boolean; reason: string }
}

const VERSION_PROBE_TIMEOUT_MS = 20_000

/**
 * DeepSeek Harness 的 headless 适配器。
 *
 * 调用方式刻意**不走 `dsh.cmd`**（批处理会强制引入 cmd.exe 包装层），
 * 而是直接以 `ELECTRON_RUN_AS_NODE=1` 启动 Electron 主程序并传入 asar 内的入口脚本，
 * 参数以**数组**形式传递（`shell: false`），不做任何字符串拼接。
 *
 * 这条命令形态与第 2.5 步实测成功的形态完全一致：
 *   ELECTRON_RUN_AS_NODE=1 "<exe>" --expose-internals "<cli.js>" --profile headless --json "<prompt>"
 */
export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh'
  readonly name = 'DeepSeek Harness（headless）'
  readonly mode = 'auto' as const
  readonly isRealCall = true

  private readonly usageByRun = new Map<string, UsageRecord>()
  private lastAvailability: AgentDescriptor | null = null

  constructor(private readonly opts: DshAdapterOptions) {}

  capabilities(): Record<Capability, CapabilityState> {
    return {
      submit: 'verified',
      result: 'verified',
      status: 'unverified',
      cancel: 'unverified',
      cost: 'unverified'
    }
  }

  describe(): AgentDescriptor {
    if (this.lastAvailability) return this.lastAvailability
    const pathsOk = this.envOk()
    return {
      id: this.id,
      name: this.name,
      adapterId: this.id,
      mode: this.mode,
      isRealCall: true,
      description: '通过 dsh headless CLI 提交任务，读取 NDJSON 事件流并返回最终结果。',
      capabilities: this.capabilities(),
      availability: pathsOk.ok ? 'unknown' : 'unavailable',
      availabilityDetail: pathsOk.ok
        ? '已登记 CLI 路径，尚未检测（点击「检测连接」只跑 --version，不调用模型）'
        : pathsOk.detail,
      version: null,
      checkedAt: null,
      configNote:
        '路由为 deepseek-account（复用现有登录态，第 2.5 步已实测成功）。' +
        '已知限制：CLI 无 cancel / status 子命令，取消只能终止本地进程且不保证远端停止；' +
        '金额无法核验（headless 不写入 ~/.dsh/.dshw-usage.json）。' +
        describeSessionPolicy(this.opts.dshHomeDir)
    }
  }

  /** 只读探活：检查路径 + 跑 `--version`。**不提交任何模型任务**。 */
  async checkAvailability(): Promise<AgentDescriptor> {
    const base = this.describe()
    const paths = this.envOk()
    if (!paths.ok) {
      this.lastAvailability = {
        ...base,
        availability: 'unavailable',
        availabilityDetail: paths.detail,
        checkedAt: new Date().toISOString()
      }
      return this.lastAvailability
    }

    const probe = await runVersionProbe(this.opts.exePath, this.opts.cliScript)
    this.lastAvailability = {
      ...base,
      availability: probe.ok ? 'available' : 'unavailable',
      availabilityDetail: probe.detail,
      version: probe.version,
      checkedAt: new Date().toISOString()
    }
    return this.lastAvailability
  }

  async run(input: RunInput, hooks: RunHooks): Promise<RunOutcome> {
    const startedAt = Date.now()
    const now = () => new Date().toISOString()

    const permission = this.opts.allowRealCall()
    if (!permission.allowed) {
      return this.refuse(startedAt, 'REAL_CALL_BLOCKED', permission.reason)
    }

    const envCheck = this.envOk(input.cwd)
    if (!envCheck.ok) {
      return this.refuse(startedAt, 'ENV_INVALID', envCheck.detail)
    }

    const args = [
      '--expose-internals',
      this.opts.cliScript,
      '--profile',
      this.opts.profile,
      '--json',
      input.prompt
    ]

    const accumulator = new DshStreamAccumulator()
    let stdoutBytes = 0
    let stderrRaw = ''
    let spawnErrorCode: string | null = null
    let spawnErrorMessage = ''
    let abortKind: 'timeout' | 'cancel' | null = null

    const child = spawn(this.opts.exePath, args, {
      cwd: input.cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const emit = (event: AgentRunEventDraft): void => {
      hooks.onEvent(event)
    }

    let lineReader: ReturnType<typeof createInterface> | null = null
    if (child.stdout) {
      lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity })
      lineReader.on('line', (line: string) => {
        stdoutBytes += Buffer.byteLength(line, 'utf8') + 1
        for (const event of accumulator.pushLine(line, now())) emit(event)
      })
    }

    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (stderrRaw.length < 40_000) stderrRaw += chunk
      })
    }

    const onAbort = (): void => {
      abortKind = hooks.signal.reason === TIMEOUT_REASON ? 'timeout' : 'cancel'
      killTree(child)
    }
    hooks.signal.addEventListener('abort', onAbort, { once: true })
    if (hooks.signal.aborted) onAbort()

    child.on('error', (error: Error) => {
      spawnErrorCode = (error as NodeJS.ErrnoException).code ?? 'SPAWN_ERROR'
      spawnErrorMessage = error.message
    })

    const exitCode = await new Promise<number | null>((resolve) => {
      let settled = false
      const finish = (value: number | null): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      child.once('close', (code: number | null) => finish(code))
      child.once('error', () => finish(null))
    })

    lineReader?.close()
    hooks.signal.removeEventListener('abort', onAbort)

    const state = accumulator.snapshot
    const diagnostics = emptyDiagnostics({
      stdoutBytes,
      stdoutLineCount: state.lineCount,
      invalidLineCount: state.invalidLineCount,
      stderrExcerpt: redactAndTruncate(stderrRaw, 2000),
      exitCode,
      spawnErrorCode
    })

    const classified = classifyDshOutcome(state)
    const durationMs = Date.now() - startedAt
    const sessionDir = state.sessionId
      ? locateSessionDir(this.opts.dshHomeDir, state.sessionId)
      : null

    const usage = buildUsage(state.usage, now())

    const withUsage = (outcome: Omit<RunOutcome, 'usage'>): RunOutcome => {
      this.usageByRun.set(input.runId, usage)
      return { ...outcome, usage }
    }

    if (abortKind === 'timeout') {
      return withUsage({
        status: 'timed_out',
        sessionId: state.sessionId,
        sessionDir,
        finalText: state.finalText,
        exitCode,
        errorCode: 'TIMEOUT',
        errorMessage: `任务在 ${input.timeoutMs} ms 内未结束，已终止本地子进程。`,
        failureKind: 'timeout',
        durationMs,
        diagnostics,
        userNotice: REMOTE_NOT_STOPPED_WARNING
      })
    }

    if (abortKind === 'cancel') {
      return withUsage({
        status: 'cancelled',
        sessionId: state.sessionId,
        sessionDir,
        finalText: state.finalText,
        exitCode,
        errorCode: 'CANCELLED_BY_USER',
        errorMessage: '用户取消了本任务，已终止本地子进程。',
        failureKind: 'cancelled',
        durationMs,
        diagnostics,
        userNotice: REMOTE_NOT_STOPPED_WARNING
      })
    }

    if (spawnErrorCode) {
      this.usageByRun.set(input.runId, usage)
      return {
        status: 'failed',
        sessionId: state.sessionId,
        sessionDir,
        finalText: state.finalText,
        exitCode: null,
        errorCode: spawnErrorCode,
        errorMessage: `无法启动 DSH 子进程：${redactAndTruncate(spawnErrorMessage, 400)}`,
        failureKind: 'spawn_failed',
        durationMs,
        usage: null,
        diagnostics,
        userNotice: '子进程未启动成功，本次未发生模型调用。'
      }
    }

    if (!classified.ok && classified.failureKind === 'turn_error') {
      return withUsage({
        status: 'failed',
        sessionId: state.sessionId,
        sessionDir,
        finalText: state.finalText,
        exitCode,
        errorCode: state.errorCode ?? 'TURN_ERROR',
        errorMessage: classified.reason,
        failureKind: 'turn_error',
        durationMs,
        diagnostics,
        userNotice: null
      })
    }

    if (exitCode !== 0) {
      return withUsage({
        status: 'failed',
        sessionId: state.sessionId,
        sessionDir,
        finalText: state.finalText,
        exitCode,
        errorCode: 'NONZERO_EXIT',
        errorMessage: `DSH 退出码为 ${exitCode}，本次执行判定失败。${classified.ok ? '' : classified.reason}`,
        failureKind: 'nonzero_exit',
        durationMs,
        diagnostics,
        userNotice: stderrRaw.trim().length > 0 ? '详见下方 stderr 摘要。' : null
      })
    }

    if (!classified.ok) {
      return withUsage({
        status: 'failed',
        sessionId: state.sessionId,
        sessionDir,
        finalText: state.finalText,
        exitCode,
        errorCode: classified.failureKind === 'missing_final' ? 'MISSING_FINAL' : 'INVALID_OUTPUT',
        errorMessage: classified.reason,
        failureKind: classified.failureKind ?? 'invalid_output',
        durationMs,
        diagnostics,
        userNotice: null
      })
    }

    return withUsage({
      status: 'succeeded',
      sessionId: state.sessionId,
      sessionDir,
      finalText: state.finalText,
      exitCode,
      errorCode: null,
      errorMessage: null,
      failureKind: null,
      durationMs,
      diagnostics,
      userNotice: null
    })
  }

  getUsage(runId: string): UsageRecord | null {
    return this.usageByRun.get(runId) ?? null
  }

  private refuse(
    startedAt: number,
    errorCode: string,
    message: string
  ): RunOutcome {
    return {
      status: 'failed',
      sessionId: null,
      sessionDir: null,
      finalText: null,
      exitCode: null,
      errorCode,
      errorMessage: message,
      failureKind: 'refused',
      durationMs: Date.now() - startedAt,
      usage: null,
      diagnostics: emptyDiagnostics(),
      userNotice: '本次被安全护栏拦截，未启动子进程，未发生模型调用，未产生费用。'
    }
  }

  private envOk(cwd?: string): { ok: boolean; detail: string } {
    if (!existsSync(this.opts.exePath)) {
      return { ok: false, detail: `找不到 DSH 可执行文件：${this.opts.exePath}` }
    }
    if (!existsSync(this.opts.cliScript)) {
      return {
        ok: false,
        detail:
          `找不到 DSH 入口脚本：${this.opts.cliScript}` +
          '（注意：该路径在 asar 虚拟归档内，只有在 Electron 主进程里才能被检测到；' +
          '用 PowerShell 的 Test-Path 检测会得到 False，属正常现象。）'
      }
    }
    if (cwd !== undefined) {
      if (!existsSync(cwd)) {
        return { ok: false, detail: `任务工作目录不存在：${cwd}` }
      }
      try {
        if (!statSync(cwd).isDirectory()) {
          return { ok: false, detail: `任务工作目录不是目录：${cwd}` }
        }
      } catch (error) {
        return { ok: false, detail: `无法读取任务工作目录：${String(error)}` }
      }
    }
    return { ok: true, detail: '路径检查通过' }
  }
}

/**
 * 构造用量记录。
 *
 * 三条纪律（对应第 3 步的成本核验要求）：
 * - token 就是 token，来自 NDJSON，可信；
 * - 金额无法核验 → actualCost 为 null、source 为 'unknown'、verified 为 false；
 * - **没有可靠单价来源，所以不生成估算金额**，estimatedCost 保持 null。
 */
export function buildUsage(tokens: DshTokenUsage | null, recordedAt: string): UsageRecord {
  if (!tokens) {
    return {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      actualCost: null,
      estimatedCost: null,
      currency: 'CNY',
      source: 'unknown',
      verified: false,
      recordedAt,
      note:
        '未从事件流读到 step_end.usage，token 用量未能读取。' +
        '金额同样无法核验（headless 不写入本地账本）。'
    }
  }

  const tokenRead = tokens.totalTokens !== null
  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.totalTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    actualCost: null,
    estimatedCost: null,
    currency: 'CNY',
    source: 'unknown',
    verified: false,
    recordedAt,
    note:
      (tokenRead
        ? 'token 用量来自 DSH NDJSON 的 step_end.usage，已成功读取。'
        : '未从事件流读到 step_end.usage，token 用量未能读取。') +
      '金额无法核验：headless 调用不写入 ~/.dsh/.dshw-usage.json，本地账本差值恒为 0，' +
      '不能把该差值解释为「免费」；也没有可靠的单价来源，因此不给出估算金额。'
  }
}

/** 只跑 `--version` 的探活子进程（不提交模型任务）。 */
function runVersionProbe(
  exePath: string,
  cliScript: string
): Promise<{ ok: boolean; version: string | null; detail: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(
      exePath,
      ['--expose-internals', cliScript, '--version'],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )

    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      killTree(child)
      resolve({ ok: false, version: null, detail: `--version 探活超过 ${VERSION_PROBE_TIMEOUT_MS} ms 未返回` })
    }, VERSION_PROBE_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    const finish = (ok: boolean, detail: string, version: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok, version, detail })
    }

    child.on('error', (error: Error) => {
      finish(false, `启动子进程失败：${redactAndTruncate(error.message, 200)}`, null)
    })

    child.once('close', (code: number | null) => {
      const version = stdout.trim().split(/\r?\n/)[0]?.trim() ?? ''
      if (code === 0 && version.length > 0) {
        finish(true, `--version 探活成功（未调用模型）`, version)
      } else {
        finish(
          false,
          `--version 探活失败：退出码 ${code}${stderr.trim() ? `，stderr：${redactAndTruncate(stderr.trim(), 200)}` : ''}`,
          version.length > 0 ? version : null
        )
      }
    })
  })
}

/**
 * 终止本地子进程树。
 *
 * 只针对本次自己启动的 PID（`taskkill /F /T /PID <pid>`），不波及任何同名进程。
 * **注意**：终止本地进程不等于远端请求停止 —— 调用方必须把
 * REMOTE_NOT_STOPPED_WARNING 一并展示给用户。
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  try {
    child.kill()
  } catch {
    // 进程可能已经退出，忽略
  }
  if (pid && process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => undefined)
      killer.unref()
    } catch {
      // taskkill 不可用时退化为 child.kill()，同样保留「远端可能未停止」的告警
    }
  }
}
