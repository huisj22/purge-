/**
 * 日志存储：把结构化日志落到 SQLite，可按级别/服务/时间/traceId 查询。
 *
 * 约束：
 * - 写库前已脱敏（logger 的 redact 在产生记录时完成），这里不再二次加工。
 * - 只保留最近 N 条（默认 5000），超出按 ts 淘汰；不做「静默丢弃」——
 *   淘汰数量会在 stats() 里体现为 pruned。
 * - 写入失败不影响主流程（fail-soft），但会把失败计数暴露出来。
 */
import type { LogLevel, LogRecord } from "../core/logger.ts";
import type { Database } from "./database.ts";

export interface LogRow {
  id: number;
  ts: string;
  level: LogLevel;
  msg: string;
  ctx: unknown;
}

export interface LogQuery {
  level?: LogLevel;
  contains?: string;
  traceId?: string;
  sinceMs?: number;
  limit?: number;
}

export class LogStore {
  readonly #db: Database;
  readonly #max: number;
  #pruned = 0;
  #writeErrors = 0;
  /** 当前行数（内存计数，避免每次 append 都全表 COUNT）。 */
  #count = 0;
  #countLoaded = false;

  constructor(db: Database, opts: { maxRows?: number } = {}) {
    this.#db = db;
    this.#max = Math.max(100, opts.maxRows ?? 5000);
  }

  append(record: LogRecord): void {
    try {
      this.#db.raw
        .prepare("INSERT INTO log(ts,level,msg,ctx,trace_id) VALUES(?,?,?,?,?)")
        .run(record.ts, record.level, record.msg, record.ctx === undefined ? null : JSON.stringify(record.ctx), record.traceId ?? null);
      if (!this.#countLoaded) {
        const row = this.#db.raw.prepare("SELECT COUNT(*) AS n FROM log").get() as { n: number };
        this.#count = Number(row.n);
        this.#countLoaded = true;
      } else {
        this.#count += 1;
      }
      if (this.#count > this.#max) {
        const excess = this.#count - this.#max;
        this.#db.raw
          .prepare("DELETE FROM log WHERE id IN (SELECT id FROM log ORDER BY id ASC LIMIT ?)")
          .run(excess);
        this.#count -= excess;
        this.#pruned += excess;
      }
    } catch {
      this.#writeErrors += 1;
    }
  }

  query(opts: LogQuery = {}): LogRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 2000));
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.level) {
      clauses.push("level = ?");
      params.push(opts.level);
    }
    if (opts.contains) {
      clauses.push("(msg LIKE ? OR ctx LIKE ?)");
      params.push(`%${opts.contains}%`, `%${opts.contains}%`);
    }
    if (opts.traceId) {
      clauses.push("trace_id = ?");
      params.push(opts.traceId);
    }
    if (opts.sinceMs !== undefined) {
      clauses.push("ts >= ?");
      params.push(new Date(opts.sinceMs).toISOString());
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db.raw
      .prepare(`SELECT id,ts,level,msg,ctx FROM log ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as unknown as Array<{ id: number; ts: string; level: LogLevel; msg: string; ctx: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      level: r.level,
      msg: r.msg,
      ctx: r.ctx ? safeParse(r.ctx) : null,
    }));
  }

  stats(): { total: number; byLevel: Record<string, number>; pruned: number; writeErrors: number } {
    const rows = this.#db.raw.prepare("SELECT level, COUNT(*) AS n FROM log GROUP BY level").all() as unknown as Array<{
      level: string;
      n: number;
    }>;
    const byLevel: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byLevel[r.level] = Number(r.n);
      total += Number(r.n);
    }
    return { total, byLevel, pruned: this.#pruned, writeErrors: this.#writeErrors };
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { unparsable: text };
  }
}
