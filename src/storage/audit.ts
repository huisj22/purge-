/**
 * 审计日志：追加式哈希链。
 *
 * 不变量（有测试）：
 * 1. seq 连续、prev_hash 指向上一行 hash，链断即报告 broken（不自动修复）。
 * 2. detail 写库前脱敏，禁止凭据落库。
 * 3. 任何变更类动作（apply/revert/config/policy）必须写审计。
 */
import { sha256 } from "../core/atomic.ts";
import { redact } from "../core/logger.ts";
import type { Database } from "./database.ts";

export const GENESIS_HASH = "0".repeat(64);

export interface AuditInput {
  actor: string;
  action: string;
  target?: string;
  risk?: number;
  detail?: unknown;
}

export interface AuditEntry {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  risk: number;
  detail: unknown;
  prevHash: string;
  hash: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  brokenAt?: number;
  reason?: string;
}

interface AuditRow {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  risk: number;
  detail: string | null;
  prev_hash: string;
  hash: string;
}

export function computeAuditHash(parts: {
  prevHash: string;
  seq: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  risk: number;
  detail: string | null;
}): string {
  return sha256(
    [parts.prevHash, parts.seq, parts.ts, parts.actor, parts.action, parts.target ?? "", parts.risk, parts.detail ?? ""].join("|"),
  );
}

export class AuditLog {
  readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  append(input: AuditInput): AuditEntry {
    const ts = new Date().toISOString();
    const target = input.target ?? null;
    const risk = input.risk ?? 0;
    const detailObj = input.detail === undefined ? null : redact(input.detail);
    const detail = detailObj === null ? null : JSON.stringify(detailObj);
    const last = this.db.raw.prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; hash: string }
      | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const hash = computeAuditHash({ prevHash, seq, ts, actor: input.actor, action: input.action, target, risk, detail });
    this.db.raw
      .prepare("INSERT INTO audit(seq,ts,actor,action,target,risk,detail,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(seq, ts, input.actor, input.action, target, risk, detail, prevHash, hash);
    return { seq, ts, actor: input.actor, action: input.action, target, risk, detail: detailObj, prevHash, hash };
  }

  list(opts: { limit?: number; action?: string } = {}): AuditEntry[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
    const rows = (
      opts.action
        ? this.db.raw.prepare("SELECT * FROM audit WHERE action=? ORDER BY seq DESC LIMIT ?").all(opts.action, limit)
        : this.db.raw.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT ?").all(limit)
    ) as unknown as AuditRow[];
    return rows.map(rowToEntry);
  }

  count(): number {
    const row = this.db.raw.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number };
    return Number(row.n);
  }

  verify(): AuditVerifyResult {
    const rows = this.db.raw.prepare("SELECT * FROM audit ORDER BY seq ASC").all() as unknown as AuditRow[];
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return {
          ok: false,
          checked: expectedSeq - 1,
          brokenAt: row.seq,
          reason: `sequence gap: expected ${expectedSeq}, got ${row.seq}`,
        };
      }
      if (row.prev_hash !== prev) {
        return { ok: false, checked: expectedSeq - 1, brokenAt: row.seq, reason: `prev_hash mismatch at seq ${row.seq}` };
      }
      const recomputed = computeAuditHash({
        prevHash: row.prev_hash,
        seq: row.seq,
        ts: row.ts,
        actor: row.actor,
        action: row.action,
        target: row.target,
        risk: row.risk,
        detail: row.detail,
      });
      if (recomputed !== row.hash) {
        return { ok: false, checked: expectedSeq - 1, brokenAt: row.seq, reason: `hash mismatch at seq ${row.seq}` };
      }
      prev = row.hash;
      expectedSeq += 1;
    }
    return { ok: true, checked: rows.length };
  }
}

function rowToEntry(row: AuditRow): AuditEntry {
  let detail: unknown = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      detail = { unparsable: row.detail };
    }
  }
  return {
    seq: row.seq,
    ts: row.ts,
    actor: row.actor,
    action: row.action,
    target: row.target,
    risk: row.risk,
    detail,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}
