/**
 * SQLite 访问层（node:sqlite 内置模块，无原生编译）。
 * 迁移按 schema_meta.version 递增，任何失败都不静默吞掉。
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "../core/atomic.ts";
import { purgeError } from "../core/errors.ts";

export const SCHEMA_VERSION = 4;

const MIGRATIONS: Array<{ version: number; apply: (db: DatabaseSync) => void }> = [
  {
    version: 1,
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT,
          risk INTEGER NOT NULL DEFAULT 0,
          detail TEXT,
          prev_hash TEXT NOT NULL,
          hash TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS trace(
          span_id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          parent_id TEXT,
          name TEXT NOT NULL,
          service TEXT NOT NULL,
          start_ms INTEGER NOT NULL,
          end_ms INTEGER,
          status TEXT NOT NULL DEFAULT 'running',
          attrs TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_trace_trace_id ON trace(trace_id);
        CREATE INDEX IF NOT EXISTS idx_trace_start ON trace(start_ms);
        CREATE TABLE IF NOT EXISTS metric(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          ts INTEGER NOT NULL,
          value REAL NOT NULL,
          tags TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_metric_name_ts ON metric(name, ts);
        CREATE TABLE IF NOT EXISTS job(
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          spec TEXT NOT NULL,
          state TEXT NOT NULL,
          next_run_ms INTEGER,
          last_run_ms INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        );
        CREATE TABLE IF NOT EXISTS run(
          run_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          ref TEXT NOT NULL,
          state TEXT NOT NULL,
          started_ms INTEGER NOT NULL,
          ended_ms INTEGER,
          result TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_run_started ON run(started_ms);
        CREATE TABLE IF NOT EXISTS snapshot(
          snap_id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          created_ms INTEGER NOT NULL,
          root_hash TEXT NOT NULL,
          manifest TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS finding(
          finding_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          severity TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          evidence TEXT NOT NULL,
          remediation TEXT,
          created_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_finding_run ON finding(run_id);
      `);
    },
  },
  {
    version: 2,
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_step(
          run_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          state TEXT NOT NULL,
          started_ms INTEGER,
          ended_ms INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0,
          output TEXT,
          error TEXT,
          PRIMARY KEY(run_id, step_id)
        );
        CREATE INDEX IF NOT EXISTS idx_run_step_run ON run_step(run_id);
      `);
    },
  },
  {
    version: 3,
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS log(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          level TEXT NOT NULL,
          msg TEXT NOT NULL,
          ctx TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_log_ts ON log(ts);
        CREATE INDEX IF NOT EXISTS idx_log_level ON log(level);
      `);
    },
  },
  {
    version: 4,
    apply: (db) => {
      // P3-09：日志与 trace 关联
      db.exec(`
        ALTER TABLE log ADD COLUMN trace_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_log_trace ON log(trace_id);
      `);
    },
  },
  {
    version: 5,
    apply: (db) => {
      // Phase 5.5：审计裁剪的完整性锚点。
      // 裁剪会删除旧记录；若不记录"删到哪个 seq、被删链尾的 hash"，剩余链无法自证连续。
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_checkpoint(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pruned_up_to_seq INTEGER NOT NULL,
          pruned_count INTEGER NOT NULL,
          head_hash TEXT NOT NULL,
          actor TEXT NOT NULL,
          ts TEXT NOT NULL,
          reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_checkpoint_seq ON audit_checkpoint(pruned_up_to_seq);
      `);
    },
  },
];
export interface Database {
  readonly raw: DatabaseSync;
  close(): void;
  version(): number;
}

export function openDatabase(file: string): Database {
  if (file !== ":memory:") {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("CREATE TABLE IF NOT EXISTS schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value?: string } | undefined;
  let version = row?.value ? Number(row.value) : 0;
  if (!Number.isInteger(version)) throw purgeError("schema_invalid", `bad schema version: ${row?.value}`);
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    try {
      db.exec("BEGIN");
      m.apply(db);
      db.prepare("INSERT INTO schema_meta(key,value) VALUES('version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(m.version));
      db.exec("COMMIT");
      version = m.version;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw purgeError("internal", `migration to v${m.version} failed: ${(err as Error).message}`, { cause: String(err) });
    }
  }
  return {
    raw: db,
    close: () => db.close(),
    version: () => version,
  };
}

/** 供测试与工具使用的内存库。 */
export function openMemoryDatabase(): Database {
  return openDatabase(":memory:");
}

export { ensureDir };
