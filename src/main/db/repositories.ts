import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

import type {
  AgentDescriptor,
  AgentRunEvent,
  AgentRunEventDraft,
  Capability,
  CapabilityState,
  Conversation,
  FailureKind,
  Message,
  MessageMetadata,
  MessageRole,
  PlanFilter,
  PlanRecord,
  PlanStatus,
  PlanSummary,
  RunRecord,
  SubTaskKind,
  TaskFilter,
  TaskRecord,
  TaskStatus,
  TaskTemplate,
  UsageRecord
} from '../../shared/types'

type Row = Record<string, unknown>
type SqlValue = SQLInputValue

function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return value
  return String(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBool(value: unknown): boolean {
  return value === 1 || value === true
}

function parseUsage(raw: unknown): UsageRecord | null {
  const text = asString(raw)
  if (!text || text.length === 0) return null
  try {
    return JSON.parse(text) as UsageRecord
  } catch {
    return null
  }
}

function asStringArray(value: unknown): string[] {
  const text = asString(value)
  if (!text || text.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

function rowToTask(row: Row): TaskRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    prompt: String(row.prompt),
    agentId: String(row.agent_id),
    adapterId: String(row.adapter_id),
    isRealCall: asBool(row.is_real_call),
    status: String(row.status) as TaskStatus,
    createdAt: String(row.created_at),
    startedAt: asString(row.started_at),
    endedAt: asString(row.ended_at),
    durationMs: asNumber(row.duration_ms),
    exitCode: asNumber(row.exit_code),
    sessionId: asString(row.session_id),
    sessionDir: asString(row.session_dir),
    finalText: asString(row.final_text),
    errorCode: asString(row.error_code),
    errorMessage: asString(row.error_message),
    failureKind: asString(row.failure_kind) as FailureKind | null,
    usage: parseUsage(row.usage_json),
    cwd: asString(row.cwd),
    attempt: asNumber(row.attempt) ?? 1,
    userNotice: asString(row.user_notice),
    // v2 新增列：v1 旧数据这些列恒为 NULL，读出后落成空值（不影响旧任务）。
    planId: asString(row.plan_id),
    planSeq: asNumber(row.plan_seq),
    taskKind: asString(row.task_kind) as SubTaskKind | null,
    dependsOn: asStringArray(row.depends_on_json),
    acceptance: asString(row.acceptance),
    blockedReason: asString(row.blocked_reason)
  }
}

function parsePlanSummary(raw: unknown): PlanSummary | null {
  const text = asString(raw)
  if (!text || text.length === 0) return null
  try {
    return JSON.parse(text) as PlanSummary
  } catch {
    return null
  }
}

function rowToPlan(row: Row): PlanRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    goal: String(row.goal),
    status: String(row.status) as PlanStatus,
    planner: String(row.planner),
    createdAt: String(row.created_at),
    confirmedAt: asString(row.confirmed_at),
    startedAt: asString(row.started_at),
    endedAt: asString(row.ended_at),
    summary: parsePlanSummary(row.summary_json),
    blockedReason: asString(row.blocked_reason),
    taskCount: asNumber(row.task_count) ?? 0,
    plannerUsage: parseUsage(row.planner_usage_json)
  }
}

function rowToAgent(row: Row): AgentDescriptor {
  let capabilities: Record<Capability, CapabilityState>
  try {
    capabilities = JSON.parse(String(row.capabilities_json)) as Record<Capability, CapabilityState>
  } catch {
    capabilities = {
      submit: 'unverified',
      result: 'unverified',
      status: 'unverified',
      cancel: 'unverified',
      cost: 'unverified'
    }
  }
  return {
    id: String(row.id),
    name: String(row.name),
    adapterId: String(row.adapter_id),
    mode: String(row.mode) as AgentDescriptor['mode'],
    isRealCall: asBool(row.is_real_call),
    description: asString(row.config_note) ?? '',
    capabilities,
    availability: String(row.availability) as AgentDescriptor['availability'],
    availabilityDetail: String(row.availability_detail ?? ''),
    version: asString(row.version),
    checkedAt: asString(row.checked_at),
    configNote: String(row.config_note ?? '')
  }
}

function rowToRun(row: Row): RunRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    agentId: String(row.agent_id),
    adapterId: String(row.adapter_id),
    attemptNo: asNumber(row.attempt_no) ?? 1,
    isRealCall: asBool(row.is_real_call),
    exitCode: asNumber(row.exit_code),
    durationMs: asNumber(row.duration_ms) ?? 0,
    stdoutBytes: asNumber(row.stdout_bytes) ?? 0,
    stdoutLineCount: asNumber(row.stdout_line_count) ?? 0,
    invalidLineCount: asNumber(row.invalid_line_count) ?? 0,
    stderrExcerpt: String(row.stderr_excerpt ?? ''),
    failureKind: asString(row.failure_kind) as FailureKind | null,
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at)
  }
}

export class AgentRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 以 registry 的描述为准做 upsert（描述即「事实来源」，避免数据库里存过期能力）。 */
  upsert(descriptor: AgentDescriptor): void {
    this.db
      .prepare(
        `INSERT INTO agents (
          id, name, adapter_id, mode, is_real_call, capabilities_json, availability,
          availability_detail, version, checked_at, config_note, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          adapter_id = excluded.adapter_id,
          mode = excluded.mode,
          is_real_call = excluded.is_real_call,
          capabilities_json = excluded.capabilities_json,
          availability = excluded.availability,
          availability_detail = excluded.availability_detail,
          version = excluded.version,
          checked_at = excluded.checked_at,
          config_note = excluded.config_note,
          updated_at = excluded.updated_at`
      )
      .run(
        ...[
          descriptor.id,
          descriptor.name,
          descriptor.adapterId,
          descriptor.mode,
          descriptor.isRealCall,
          JSON.stringify(descriptor.capabilities),
          descriptor.availability,
          descriptor.availabilityDetail,
          descriptor.version,
          descriptor.checkedAt,
          descriptor.configNote,
          new Date().toISOString()
        ].map(toSqlValue)
      )
  }

  list(): AgentDescriptor[] {
    const rows = this.db
      .prepare('SELECT * FROM agents ORDER BY is_real_call DESC, id ASC')
      .all() as unknown as Row[]
    return rows.map(rowToAgent)
  }
}

export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, title, prompt, agent_id, adapter_id, is_real_call, status, created_at, started_at,
          ended_at, duration_ms, exit_code, session_id, session_dir, final_text, error_code,
          error_message, failure_kind, usage_json, cwd, attempt, user_notice,
          plan_id, plan_seq, task_kind, depends_on_json, acceptance, blocked_reason
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        ...[
          task.id,
          task.title,
          task.prompt,
          task.agentId,
          task.adapterId,
          task.isRealCall,
          task.status,
          task.createdAt,
          task.startedAt,
          task.endedAt,
          task.durationMs,
          task.exitCode,
          task.sessionId,
          task.sessionDir,
          task.finalText,
          task.errorCode,
          task.errorMessage,
          null,
          task.usage === null ? null : JSON.stringify(task.usage),
          task.cwd,
          task.attempt,
          null,
          task.planId,
          task.planSeq,
          task.taskKind,
          task.dependsOn.length > 0 ? JSON.stringify(task.dependsOn) : null,
          task.acceptance,
          task.blockedReason
        ].map(toSqlValue)
      )
  }

  update(task: TaskRecord): void {
    this.db
      .prepare(
        `UPDATE tasks SET
          title = ?, prompt = ?, agent_id = ?, adapter_id = ?, is_real_call = ?,
          status = ?, started_at = ?, ended_at = ?, duration_ms = ?, exit_code = ?,
          session_id = ?, session_dir = ?, final_text = ?, error_code = ?, error_message = ?,
          failure_kind = ?, usage_json = ?, cwd = ?, attempt = ?, user_notice = ?,
          plan_id = ?, plan_seq = ?, task_kind = ?, depends_on_json = ?, acceptance = ?,
          blocked_reason = ?
        WHERE id = ?`
      )
      .run(
        ...[
          task.title,
          task.prompt,
          task.agentId,
          task.adapterId,
          task.isRealCall,
          task.status,
          task.startedAt,
          task.endedAt,
          task.durationMs,
          task.exitCode,
          task.sessionId,
          task.sessionDir,
          task.finalText,
          task.errorCode,
          task.errorMessage,
          task.failureKind ?? null,
          task.usage === null ? null : JSON.stringify(task.usage),
          task.cwd,
          task.attempt,
          task.userNotice ?? null,
          task.planId,
          task.planSeq,
          task.taskKind,
          task.dependsOn.length > 0 ? JSON.stringify(task.dependsOn) : null,
          task.acceptance,
          task.blockedReason,
          task.id
        ].map(toSqlValue)
      )
  }

  get(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as Row | undefined
    return row ? rowToTask(row) : null
  }

  /** 某份计划下的全部子任务，按计划内顺序升序。 */
  listByPlan(planId: string): TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE plan_id = ? ORDER BY plan_seq ASC')
      .all(planId) as unknown as Row[]
    return rows.map(rowToTask)
  }

  list(filter: TaskFilter = {}): TaskRecord[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.status && filter.status !== 'all') {
      where.push('status = ?')
      params.push(filter.status)
    }
    if (filter.agentId) {
      where.push('agent_id = ?')
      params.push(filter.agentId)
    }
    if (filter.searchQuery) {
      const query = `%${filter.searchQuery.trim()}%`
      where.push('(title LIKE ? OR prompt LIKE ?)')
      params.push(query, query)
    }
    if (filter.createdAfter) {
      where.push('created_at >= ?')
      params.push(filter.createdAfter)
    }
    if (filter.createdBefore) {
      where.push('created_at <= ?')
      params.push(filter.createdBefore)
    }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
    const sql =
      `SELECT * FROM tasks ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}` +
      ` ORDER BY created_at DESC LIMIT ${limit}`
    const rows = this.db.prepare(sql).all(...params.map(toSqlValue)) as unknown as Row[]
    return rows.map(rowToTask)
  }

  /** 删除任务（仅删除 tasks 表记录，关联数据由调用方处理）。 */
  delete(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  /**
   * 启动时清理：上次进程异常结束时留下的 running 任务，其本地子进程已随进程消失，
   * 无法再确认远端状态 —— 一律转入 needs_confirmation，**不假装它还在跑，也不自动重跑**。
   */
  recoverStaleRunning(notice: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'running'")
      .all() as unknown as Row[]
    const recovered: TaskRecord[] = []
    for (const row of rows) {
      const task = rowToTask(row)
      task.status = 'needs_confirmation'
      task.errorCode = 'STALE_RUNNING'
      task.errorMessage = notice
      task.userNotice = notice
      task.endedAt = task.endedAt ?? new Date().toISOString()
      this.update(task)
      recovered.push(task)
    }
    return recovered
  }

  /** 供概览聚合使用的最小数据集。 */
  overviewRows(): Array<{ status: TaskStatus; isRealCall: boolean; usage: UsageRecord | null }> {
    const rows = this.db
      .prepare('SELECT status, is_real_call, usage_json FROM tasks')
      .all() as unknown as Row[]
    return rows.map((row) => ({
      status: String(row.status) as TaskStatus,
      isRealCall: asBool(row.is_real_call),
      usage: parseUsage(row.usage_json)
    }))
  }

  lastActivityAt(): string | null {
    const row = this.db
      .prepare('SELECT MAX(COALESCE(ended_at, started_at, created_at)) AS ts FROM tasks')
      .get() as unknown as Row | undefined
    return row ? asString(row.ts) : null
  }
}

export class RunRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (
          id, task_id, agent_id, adapter_id, attempt_no, is_real_call, exit_code, duration_ms,
          stdout_bytes, stdout_line_count, invalid_line_count, stderr_excerpt, failure_kind,
          started_at, ended_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        ...[
          run.id,
          run.taskId,
          run.agentId,
          run.adapterId,
          run.attemptNo,
          run.isRealCall,
          run.exitCode,
          run.durationMs,
          run.stdoutBytes,
          run.stdoutLineCount,
          run.invalidLineCount,
          run.stderrExcerpt,
          run.failureKind,
          run.startedAt,
          run.endedAt
        ].map(toSqlValue)
      )
  }

  listRecent(limit = 200): RunRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 1000)
    const rows = this.db
      .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ${safeLimit}`)
      .all() as unknown as Row[]
    return rows.map(rowToRun)
  }

  listByTask(taskId: string): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC')
      .all(taskId) as unknown as Row[]
    return rows.map(rowToRun)
  }

  /** 删除指定任务的运行记录。 */
  deleteByTaskId(taskId: string): void {
    this.db.prepare('DELETE FROM runs WHERE task_id = ?').run(taskId)
  }
}

export class EventRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(taskId: string, runId: string, draft: AgentRunEventDraft, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO events (task_id, run_id, seq, type, raw_type, payload_json, received_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        ...[
          taskId,
          runId,
          seq,
          draft.type,
          draft.rawType,
          JSON.stringify(draft.payload),
          draft.receivedAt
        ].map(toSqlValue)
      )
  }

  listByTask(taskId: string, limit = 500): AgentRunEvent[] {
    const safeLimit = Math.min(Math.max(limit, 1), 5000)
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC LIMIT ${safeLimit}`)
      .all(taskId) as unknown as Row[]
    return rows.map((row) => ({
      seq: asNumber(row.seq) ?? 0,
      type: String(row.type) as AgentRunEvent['type'],
      rawType: String(row.raw_type),
      payload: (() => {
        try {
          return JSON.parse(String(row.payload_json)) as Record<string, unknown>
        } catch {
          return { _unparsable: String(row.payload_json).slice(0, 500) }
        }
      })(),
      receivedAt: String(row.received_at)
    }))
  }

  countByTask(taskId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE task_id = ?')
      .get(taskId) as unknown as Row | undefined
    return row ? (asNumber(row.c) ?? 0) : 0
  }

  /** 删除指定任务的事件记录。 */
  deleteByTaskId(taskId: string): void {
    this.db.prepare('DELETE FROM events WHERE task_id = ?').run(taskId)
  }
}

export class PlanRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(plan: PlanRecord): void {
    this.db
      .prepare(
        `INSERT INTO plans (
          id, title, goal, status, planner, created_at, confirmed_at, started_at, ended_at,
          summary_json, blocked_reason, task_count, planner_usage_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        ...[
          plan.id,
          plan.title,
          plan.goal,
          plan.status,
          plan.planner,
          plan.createdAt,
          plan.confirmedAt,
          plan.startedAt,
          plan.endedAt,
          plan.summary === null ? null : JSON.stringify(plan.summary),
          plan.blockedReason,
          plan.taskCount,
          plan.plannerUsage === null ? null : JSON.stringify(plan.plannerUsage)
        ].map(toSqlValue)
      )
  }

  update(plan: PlanRecord): void {
    this.db
      .prepare(
        `UPDATE plans SET
          status = ?, confirmed_at = ?, started_at = ?, ended_at = ?, summary_json = ?,
          blocked_reason = ?, task_count = ?
        WHERE id = ?`
      )
      .run(
        ...[
          plan.status,
          plan.confirmedAt,
          plan.startedAt,
          plan.endedAt,
          plan.summary === null ? null : JSON.stringify(plan.summary),
          plan.blockedReason,
          plan.taskCount,
          plan.id
        ].map(toSqlValue)
      )
  }

  get(id: string): PlanRecord | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as unknown as Row | undefined
    return row ? rowToPlan(row) : null
  }

  list(filter: PlanFilter = {}): PlanRecord[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.status && filter.status !== 'all') {
      where.push('status = ?')
      params.push(filter.status)
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
    const sql =
      `SELECT * FROM plans ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}` +
      ` ORDER BY created_at DESC LIMIT ${limit}`
    const rows = this.db.prepare(sql).all(...params.map(toSqlValue)) as unknown as Row[]
    return rows.map(rowToPlan)
  }

  /** 启动恢复：找出仍处于 running 的计划（上次进程异常退出时遗留）。 */
  listRunning(): PlanRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM plans WHERE status = 'running'")
      .all() as unknown as Row[]
    return rows.map(rowToPlan)
  }
}

// ========== 任务模板 Repository ==========

export class TemplateRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(template: TaskTemplate): void {
    this.db
      .prepare(
        `INSERT INTO task_templates (
          id, name, description, agent_id, prompt_template, title_template, tags, is_built_in, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        template.id,
        template.name,
        template.description,
        template.agentId,
        template.promptTemplate,
        template.titleTemplate,
        template.tags,
        template.isBuiltIn ? 1 : 0,
        template.createdAt,
        template.updatedAt
      )
  }

  update(template: TaskTemplate): void {
    this.db
      .prepare(
        `UPDATE task_templates SET
          name = ?, description = ?, agent_id = ?, prompt_template = ?, title_template = ?, tags = ?, updated_at = ?
        WHERE id = ?`
      )
      .run(
        template.name,
        template.description,
        template.agentId,
        template.promptTemplate,
        template.titleTemplate,
        template.tags,
        template.updatedAt,
        template.id
      )
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM task_templates WHERE id = ? AND is_built_in = 0').run(id)
  }

  get(id: string): TaskTemplate | null {
    const row = this.db.prepare('SELECT * FROM task_templates WHERE id = ?').get(id) as unknown as Row | undefined
    return row ? rowToTemplate(row) : null
  }

  list(agentId?: string): TaskTemplate[] {
    const where = agentId ? 'WHERE agent_id = ?' : ''
    const params = agentId ? [agentId] : []
    const rows = this.db
      .prepare(`SELECT * FROM task_templates ${where} ORDER BY created_at DESC`)
      .all(...params) as unknown as Row[]
    return rows.map(rowToTemplate)
  }
}

function rowToTemplate(row: Row): TaskTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    agentId: row.agent_id as string,
    promptTemplate: row.prompt_template as string,
    titleTemplate: row.title_template as string,
    tags: row.tags as string,
    isBuiltIn: (row.is_built_in as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

// ========== 对话系统 Repository ==========

export class ConversationRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(conversation: Conversation): void {
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, message_count)
         VALUES (?,?,?,?,?)`
      )
      .run(
        conversation.id,
        conversation.title,
        conversation.createdAt,
        conversation.updatedAt,
        conversation.messageCount
      )
  }

  update(conversation: Conversation): void {
    this.db
      .prepare(
        `UPDATE conversations SET title=?, updated_at=?, message_count=? WHERE id=?`
      )
      .run(conversation.title, conversation.updatedAt, conversation.messageCount, conversation.id)
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM conversations WHERE id=?`).run(id)
  }

  get(id: string): Conversation | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id=?`).get(id) as Row | undefined
    return row ? this.rowToConversation(row) : null
  }

  list(): Conversation[] {
    const rows = this.db
      .prepare(`SELECT * FROM conversations ORDER BY updated_at DESC`)
      .all() as Row[]
    return rows.map((row) => this.rowToConversation(row))
  }

  private rowToConversation(row: Row): Conversation {
    return {
      id: String(row.id),
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      messageCount: asNumber(row.message_count) ?? 0
    }
  }
}

export class MessageRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(message: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, agent_id, content, created_at, task_ids, metadata)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        message.id,
        message.conversationId,
        message.role,
        message.agentId,
        message.content,
        message.createdAt,
        JSON.stringify(message.taskIds),
        message.metadata ? JSON.stringify(message.metadata) : null
      )
  }

  listByConversation(conversationId: string): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC`)
      .all(conversationId) as Row[]
    return rows.map((row) => this.rowToMessage(row))
  }

  private rowToMessage(row: Row): Message {
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      role: String(row.role) as MessageRole,
      agentId: asString(row.agent_id),
      content: String(row.content),
      createdAt: String(row.created_at),
      taskIds: asStringArray(row.task_ids),
      metadata: row.metadata ? JSON.parse(String(row.metadata)) as MessageMetadata : null
    }
  }
}

export interface Repositories {
  agents: AgentRepository
  tasks: TaskRepository
  runs: RunRepository
  events: EventRepository
  plans: PlanRepository
  templates: TemplateRepository
  conversations: ConversationRepository
  messages: MessageRepository
}

export function createRepositories(db: DatabaseSync): Repositories {
  return {
    agents: new AgentRepository(db),
    tasks: new TaskRepository(db),
    runs: new RunRepository(db),
    events: new EventRepository(db),
    plans: new PlanRepository(db),
    templates: new TemplateRepository(db),
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db)
  }
}
