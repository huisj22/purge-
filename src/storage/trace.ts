/**
 * 瑙傛祴瀛樺偍锛歴pan/trace 涓?metric銆? * 鍙褰曠湡瀹炴墽琛岋紱娌℃湁鏁版嵁鐨勬椂闂存涓嶇紪閫犻浂鍊笺€? */
import { randomUUID } from "node:crypto";
import type { Database } from "./database.ts";

export type SpanStatus = "running" | "ok" | "error" | "cancelled";

export interface SpanRow {
  spanId: string;
  traceId: string;
  parentId: string | null;
  name: string;
  service: string;
  startMs: number;
  endMs: number | null;
  status: SpanStatus;
  attrs: unknown;
}

export interface Span {
  readonly spanId: string;
  readonly traceId: string;
  end(status?: SpanStatus, attrs?: Record<string, unknown>): void;
}

export class TraceStore {
  readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  startSpan(name: string, opts: { service?: string; traceId?: string; parentId?: string; attrs?: Record<string, unknown> } = {}): Span {
    const spanId = randomUUID();
    const traceId = opts.traceId ?? spanId;
    const startMs = Date.now();
    this.db.raw
      .prepare("INSERT INTO trace(span_id,trace_id,parent_id,name,service,start_ms,end_ms,status,attrs) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(spanId, traceId, opts.parentId ?? null, name, opts.service ?? "purgeplus", startMs, null, "running", JSON.stringify(opts.attrs ?? {}));
    let ended = false;
    return {
      spanId,
      traceId,
      end: (status: SpanStatus = "ok", attrs: Record<string, unknown> = {}) => {
        if (ended) return;
        ended = true;
        const merged = { ...(opts.attrs ?? {}), ...attrs };
        this.db.raw
          .prepare("UPDATE trace SET end_ms=?, status=?, attrs=? WHERE span_id=?")
          .run(Date.now(), status, JSON.stringify(merged), spanId);
      },
    };
  }

  listTraces(opts: { limit?: number; status?: SpanStatus } = {}): Array<{ traceId: string; spans: number; startMs: number; endMs: number | null; status: SpanStatus; root: string }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const rows = this.db.raw
      .prepare(
        `SELECT trace_id, COUNT(*) AS spans, MIN(start_ms) AS start_ms, MAX(end_ms) AS end_ms,
                MAX(CASE WHEN status='error' THEN 1 ELSE 0 END) AS has_error,
                MIN(parent_id IS NULL) AS has_root
         FROM trace GROUP BY trace_id ORDER BY start_ms DESC LIMIT ?`,
      )
      .all(limit) as unknown as Array<{ trace_id: string; spans: number; start_ms: number; end_ms: number | null; has_error: number }>;
    const out = [];
    for (const r of rows) {
      const root = this.db.raw
        .prepare("SELECT name FROM trace WHERE trace_id=? AND (parent_id IS NULL OR parent_id='') ORDER BY start_ms ASC LIMIT 1")
        .get(r.trace_id) as { name: string } | undefined;
      const running = this.db.raw.prepare("SELECT COUNT(*) AS n FROM trace WHERE trace_id=? AND status='running'").get(r.trace_id) as { n: number };
      const status: SpanStatus = Number(running.n) > 0 ? "running" : r.has_error ? "error" : "ok";
      out.push({
        traceId: r.trace_id,
        spans: Number(r.spans),
        startMs: Number(r.start_ms),
        endMs: r.end_ms === null ? null : Number(r.end_ms),
        status,
        root: root?.name ?? "(unknown)",
      });
    }
    if (opts.status) return out.filter((t) => t.status === opts.status);
    return out;
  }

  spansOf(traceId: string): SpanRow[] {
    const rows = this.db.raw.prepare("SELECT * FROM trace WHERE trace_id=? ORDER BY start_ms ASC").all(traceId) as unknown as Array<{
      span_id: string;
      trace_id: string;
      parent_id: string | null;
      name: string;
      service: string;
      start_ms: number;
      end_ms: number | null;
      status: SpanStatus;
      attrs: string;
    }>;
    return rows.map((r) => ({
      spanId: r.span_id,
      traceId: r.trace_id,
      parentId: r.parent_id,
      name: r.name,
      service: r.service,
      startMs: Number(r.start_ms),
      endMs: r.end_ms === null ? null : Number(r.end_ms),
      status: r.status,
      attrs: r.attrs ? JSON.parse(r.attrs) : {},
    }));
  }
}

export class MetricStore {
  readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  record(name: string, value: number, tags: Record<string, string> = {}): void {
    const tagKey = Object.keys(tags).sort().map((k) => `${k}=${tags[k]}`).join(",");
    this.db.raw
      .prepare("INSERT INTO metric(name,ts,value,tags) VALUES(?,?,?,?)")
      .run(name, Date.now(), value, tagKey);
  }

  /** 鏃堕棿绐楀彛鍐呯殑绠€鍗曠粺璁★紙count/sum/min/max/avg锛夛紝绌虹獥鍙ｈ繑鍥?null 鑰屼笉鏄?0銆?*/
  stats(name: string, windowMs = 3600_000): { count: number; sum: number; min: number; max: number; avg: number } | null {
    const since = Date.now() - windowMs;
    const row = this.db.raw
      .prepare("SELECT COUNT(*) AS n, SUM(value) AS s, MIN(value) AS mn, MAX(value) AS mx, AVG(value) AS av FROM metric WHERE name=? AND ts>=?")
      .get(name, since) as { n: number; s: number | null; mn: number | null; mx: number | null; av: number | null };
    if (!row || Number(row.n) === 0) return null;
    return { count: Number(row.n), sum: Number(row.s), min: Number(row.mn), max: Number(row.mx), avg: Number(row.av) };
  }

  names(): string[] {
    const rows = this.db.raw.prepare("SELECT DISTINCT name FROM metric ORDER BY name").all() as unknown as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }
}

