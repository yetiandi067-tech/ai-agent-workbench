import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'

import { openDatabase } from '../src/main/db/database'

/**
 * 数据库迁移兼容性测试：验证 v1 → v2 升级保留旧数据。
 *
 * 关键验证点：
 * 1. v1 数据库（只有 tasks / runs / events / agents 表）能正确升级到 v2；
 * 2. 旧任务数据在迁移后完整保留；
 * 3. v2 新增的 plans 表与 tasks 表新列正确创建；
 * 4. 旧任务的 plan_id 等新列默认为 NULL，不影响读取。
 */
const tempDir = mkdtempSync(join(tmpdir(), 'migration-test-'))
const dbPath = join(tempDir, 'migration.db')

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('数据库迁移兼容性（v1 → v3）', () => {
  it('v1 数据库升级到 v3 后保留旧任务数据，并新增 plans 表、计划关联列与 planner_usage_json', () => {
    // 第一步：手工创建 v1 数据库（只执行 v1 迁移）
    const db = new DatabaseSync(dbPath)

    // 只应用 v1 迁移（跳过 v2）
    db.exec('BEGIN')
    try {
      // v1 的表结构（来自 migrations.ts 的 v1 迁移）
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `)

      db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
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
        )
      `)

      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
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
        )
      `)

      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
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
        )
      `)

      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id     TEXT NOT NULL,
          run_id      TEXT NOT NULL,
          seq         INTEGER NOT NULL,
          type        TEXT NOT NULL,
          raw_type    TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          received_at TEXT NOT NULL
        )
      `)

      // 记录 v1 已应用
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(1, 'init', new Date().toISOString())

      // 插入 v1 时期的旧任务数据
      const v1Now = new Date().toISOString()
      db.prepare(
        `INSERT INTO tasks (
          id, title, prompt, agent_id, adapter_id, is_real_call, status, created_at,
          started_at, ended_at, duration_ms, exit_code, session_id, session_dir, final_text,
          error_code, error_message, failure_kind, usage_json, cwd, attempt, user_notice
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'old-task-1',
        '旧任务：普通单任务',
        '这是一个 v1 时期的普通任务',
        'mock',
        'mock',
        0,
        'succeeded',
        v1Now,
        v1Now,
        v1Now,
        100,
        0,
        'session-1',
        null,
        'MOCK_OK',
        null,
        null,
        null,
        null,
        null,
        1,
        null
      )

      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    db.close()

    // 第二步：用 openDatabase 打开同一个文件，触发 v2 + v3 + v4 + v5 迁移
    const opened = openDatabase(dbPath)
    expect(opened.schemaVersion).toBe(5)
    expect(opened.mode).toBe('file')

    // 第三步：验证 plans 表已创建
    const plansTable = opened.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='plans'`)
      .get()
    expect(plansTable).toBeDefined()

    // 第四步：验证 tasks 表新增了 plan_id 等列
    const taskColumns = opened.db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
      name: string
    }>
    const columnNames = taskColumns.map((col) => col.name)
    expect(columnNames).toContain('plan_id')
    expect(columnNames).toContain('plan_seq')
    expect(columnNames).toContain('task_kind')
    expect(columnNames).toContain('depends_on_json')
    expect(columnNames).toContain('acceptance')
    expect(columnNames).toContain('blocked_reason')

    // plans 表应包含 v3 新增的 planner_usage_json 列
    const planColumns = opened.db.prepare(`PRAGMA table_info(plans)`).all() as Array<{
      name: string
    }>
    const planColumnNames = planColumns.map((col) => col.name)
    expect(planColumnNames).toContain('planner_usage_json')

    // 第五步：验证旧任务数据完整保留
    const oldTask = opened.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get('old-task-1') as Record<string, unknown>
    expect(oldTask).toBeDefined()
    expect(oldTask.title).toBe('旧任务：普通单任务')
    expect(oldTask.prompt).toBe('这是一个 v1 时期的普通任务')
    expect(oldTask.status).toBe('succeeded')
    expect(oldTask.final_text).toBe('MOCK_OK')

    // 旧任务的新列应为 NULL（不影响读取）
    expect(oldTask.plan_id).toBeNull()
    expect(oldTask.plan_seq).toBeNull()
    expect(oldTask.task_kind).toBeNull()
    expect(oldTask.depends_on_json).toBeNull()
    expect(oldTask.acceptance).toBeNull()
    expect(oldTask.blocked_reason).toBeNull()

    // 第六步：验证可以插入新的计划任务
    const v2Now = new Date().toISOString()
    const newPlanId = 'new-plan-1'
    const newTaskId = 'new-task-1'
    opened.db
      .prepare(
        `INSERT INTO plans (id, title, goal, status, planner, created_at, task_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(newPlanId, '新计划', '测试 v2 计划', 'draft', 'mock-planner', v2Now, 1)

    opened.db
      .prepare(
        `INSERT INTO tasks (
          id, title, prompt, agent_id, adapter_id, is_real_call, status, created_at,
          plan_id, plan_seq, task_kind, depends_on_json, acceptance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        newTaskId,
        '新子任务',
        '[research] 测试',
        'mock',
        'mock',
        0,
        'pending',
        v2Now,
        newPlanId,
        1,
        'research',
        null,
        '验收标准'
      )

    const newPlan = opened.db.prepare('SELECT * FROM plans WHERE id = ?').get(newPlanId)
    expect(newPlan).toBeDefined()

    const newTask = opened.db.prepare('SELECT * FROM tasks WHERE id = ?').get(newTaskId)
    expect(newTask).toBeDefined()
    expect((newTask as Record<string, unknown>).plan_id).toBe(newPlanId)

    opened.db.close()
  })

  it('重复运行迁移不会报错（幂等）', () => {
    const db2Path = join(tempDir, 'idempotent.db')

    // 第一次打开：应用所有迁移
    const first = openDatabase(db2Path)
    expect(first.schemaVersion).toBe(5)
    first.db.close()

    // 第二次打开：不应重复应用迁移
    const second = openDatabase(db2Path)
    expect(second.schemaVersion).toBe(5)
    second.db.close()
  })
})
