/**
 * 数据库迁移。
 *
 * 策略：`schema_migrations` 表记录已应用的版本；每个迁移在**单个事务**里执行，
 * 失败即回滚并抛出带版本号的错误（由上层给出清楚的提示，而不是静默降级）。
 */
export interface Migration {
  version: number
  name: string
  statements: string[]
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    statements: [
      `CREATE TABLE IF NOT EXISTS agents (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        adapter_id          TEXT NOT NULL,
        mode                TEXT NOT NULL,
        is_real_call        INTEGER NOT NULL DEFAULT 0,
        capabilities_json   TEXT NOT NULL,
        availability        TEXT NOT NULL,
        availability_detail TEXT NOT NULL DEFAULT '',
        version             TEXT,
        checked_at          TEXT,
        config_note         TEXT NOT NULL DEFAULT '',
        updated_at          TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        prompt        TEXT NOT NULL,
        agent_id      TEXT NOT NULL,
        adapter_id    TEXT NOT NULL,
        is_real_call  INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        started_at    TEXT,
        ended_at      TEXT,
        duration_ms   INTEGER,
        exit_code     INTEGER,
        session_id    TEXT,
        session_dir   TEXT,
        final_text    TEXT,
        error_code    TEXT,
        error_message TEXT,
        failure_kind  TEXT,
        usage_json    TEXT,
        cwd           TEXT,
        attempt       INTEGER NOT NULL DEFAULT 1,
        user_notice   TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`,

      `CREATE TABLE IF NOT EXISTS runs (
        id                 TEXT PRIMARY KEY,
        task_id            TEXT NOT NULL,
        agent_id           TEXT NOT NULL,
        adapter_id         TEXT NOT NULL,
        attempt_no         INTEGER NOT NULL DEFAULT 1,
        is_real_call       INTEGER NOT NULL DEFAULT 0,
        exit_code          INTEGER,
        duration_ms        INTEGER NOT NULL DEFAULT 0,
        stdout_bytes       INTEGER NOT NULL DEFAULT 0,
        stdout_line_count  INTEGER NOT NULL DEFAULT 0,
        invalid_line_count INTEGER NOT NULL DEFAULT 0,
        stderr_excerpt     TEXT NOT NULL DEFAULT '',
        failure_kind       TEXT,
        started_at         TEXT NOT NULL,
        ended_at           TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id)`,
      `CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC)`,

      `CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        type        TEXT NOT NULL,
        raw_type    TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events(task_id, seq)`
    ]
  },
  {
    /**
     * v2：第 4 步·阶段 1「主管 Agent 调度层」。
     *
     * - 新增 plans 表：一份总任务（目标、状态、汇总报告）。
     * - tasks 表追加计划关联列：子任务复用现有 tasks 表与状态机，**不另建 subtasks 表**。
     * - 全部为「新增列 / 新增表」，不修改、不删除 v1 的任何列与数据。
     */
    version: 2,
    name: 'plans-and-subtask-linkage',
    statements: [
      `CREATE TABLE IF NOT EXISTS plans (
        id             TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        goal           TEXT NOT NULL,
        status         TEXT NOT NULL,
        planner        TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        confirmed_at   TEXT,
        started_at     TEXT,
        ended_at       TEXT,
        summary_json   TEXT,
        blocked_reason TEXT,
        task_count     INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)`,
      `CREATE INDEX IF NOT EXISTS idx_plans_created ON plans(created_at DESC)`,

      `ALTER TABLE tasks ADD COLUMN plan_id TEXT`,
      `ALTER TABLE tasks ADD COLUMN plan_seq INTEGER`,
      `ALTER TABLE tasks ADD COLUMN task_kind TEXT`,
      `ALTER TABLE tasks ADD COLUMN depends_on_json TEXT`,
      `ALTER TABLE tasks ADD COLUMN acceptance TEXT`,
      `ALTER TABLE tasks ADD COLUMN blocked_reason TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id)`
    ]
  }
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
