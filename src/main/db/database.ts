import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations'

export interface OpenDatabaseResult {
  db: DatabaseSync
  /** file = 正常持久化；memory-fallback = 文件库不可用，已降级为内存库。 */
  mode: 'file' | 'memory-fallback'
  detail: string
  filePath: string
  schemaVersion: number
}

/**
 * 打开数据库。
 *
 * 关键设计：**数据库出问题不能导致应用打不开**。文件库创建 / 迁移失败时，
 * 自动降级为内存库并把失败原因带出去（设置页会显著提示「本次数据不会持久化」），
 * 而不是直接崩掉整个应用。
 */
export function openDatabase(filePath: string): OpenDatabaseResult {
  try {
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const db = new DatabaseSync(filePath)
    try {
      db.exec('PRAGMA journal_mode = WAL;')
    } catch {
      // WAL 不可用（部分文件系统 / 内存库）时退化为默认日志模式
    }
    db.exec('PRAGMA foreign_keys = ON;')
    const schemaVersion = applyMigrations(db)

    return {
      db,
      mode: 'file',
      detail: `SQLite 文件库正常：${filePath}`,
      filePath,
      schemaVersion
    }
  } catch (error) {
    const detail = `文件库不可用（${error instanceof Error ? error.message : String(error)}），已降级为内存库；本次运行的数据不会持久化。`
    const db = new DatabaseSync(':memory:')
    const schemaVersion = applyMigrations(db)
    return { db, mode: 'memory-fallback', detail, filePath, schemaVersion }
  }
}

/** 应用迁移，返回当前 schema 版本。失败时抛出具名错误。 */
export function applyMigrations(db: DatabaseSync): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`
  )

  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number
  }>
  const applied = new Set(rows.map((row) => Number(row.version)))

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    db.exec('BEGIN')
    try {
      for (const statement of migration.statements) db.exec(statement)
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(migration.version, migration.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 回滚失败时保留原始错误
      }
      throw new Error(
        `数据库迁移失败：v${migration.version} ${migration.name} —— ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  return LATEST_SCHEMA_VERSION
}
