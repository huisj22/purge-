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
    // 跨进程并发安全：seq 的分配必须在**写事务内**完成。
    // 否则两个进程会读到同一个 last(seq)，并在插入时撞 UNIQUE(audit.seq)。
    let attempt = 0;
    for (;;) {
      try {
        this.db.raw.exec("BEGIN IMMEDIATE");
        try {
          const last = this.db.raw.prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").get() as
            | { seq: number; hash: string }
            | undefined;
          const seq = (last?.seq ?? 0) + 1;
          const prevHash = last?.hash ?? GENESIS_HASH;
          const hash = computeAuditHash({ prevHash, seq, ts, actor: input.actor, action: input.action, target, risk, detail });
          this.db.raw
            .prepare("INSERT INTO audit(seq,ts,actor,action,target,risk,detail,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?)")
            .run(seq, ts, input.actor, input.action, target, risk, detail, prevHash, hash);
          this.db.raw.exec("COMMIT");
          return { seq, ts, actor: input.actor, action: input.action, target, risk, detail: detailObj, prevHash, hash };
        } catch (err) {
          try {
            this.db.raw.exec("ROLLBACK");
          } catch {
            /* 事务可能已结束 */
          }
          throw err;
        }
      } catch (err) {
        const message = String((err as Error).message ?? err);
        const retryable = /SQLITE_BUSY|database is locked/i.test(message);
        attempt += 1;
        if (!retryable || attempt > 100) throw err;
        // 同步自旋等待写锁释放（append 是同步 API）
        const until = Date.now() + 5;
        while (Date.now() < until) {
          /* spin */
        }
      }
    }
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

  /**
   * 审计裁剪（Phase 5.5）。
   *
   * 安全规则：
   * 1. 只删"最老的一段"且保留 atLeast 条；绝不删最新记录。
   * 2. 裁剪前把"删到哪个 seq + 被删链尾 hash"写入 audit_checkpoint，
   *    这样剩余链仍可自证连续（verify 会校验锚点）。
   * 3. 整体在一个 BEGIN IMMEDIATE 事务内完成（与 append 互斥）。
   * 4. 任何不确定状态（读不出 count / 锚点写入失败）→ 抛错，绝不删除。
   * 5. 裁剪本身也写一条审计记录（action=audit.prune），保留可追溯性。
   */
  prune(opts: { keepLast?: number; actor: string; reason?: string }): { removed: number; kept: number; checkpointId: number } {
    const keepLast = Math.max(1, Math.floor(opts.keepLast ?? 1000));
    let attempt = 0;
    for (;;) {
      try {
        this.db.raw.exec("BEGIN IMMEDIATE");
        try {
          const total = this.count();
          const removable = total - keepLast;
          if (removable <= 0) {
            this.db.raw.exec("COMMIT");
            return { removed: 0, kept: total, checkpointId: 0 };
          }
          const victims = this.db.raw
            .prepare("SELECT seq, hash FROM audit ORDER BY seq ASC LIMIT ?")
            .all(removable) as unknown as Array<{ seq: number; hash: string }>;
          if (victims.length === 0) {
            this.db.raw.exec("COMMIT");
            return { removed: 0, kept: total, checkpointId: 0 };
          }
          const last = victims[victims.length - 1] as { seq: number; hash: string };
          this.db.raw.prepare("DELETE FROM audit WHERE seq <= ?").run(last.seq);
          this.db.raw
            .prepare("INSERT INTO audit_checkpoint(pruned_up_to_seq,pruned_count,head_hash,actor,ts,reason) VALUES(?,?,?,?,?,?)")
            .run(last.seq, victims.length, last.hash, opts.actor, new Date().toISOString(), opts.reason ?? null);
          const checkpoint = this.db.raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
          // 裁剪事件本身也进入审计链：接在**剩余链尾**之后（不能占用已存在的 seq）
          const tail = this.db.raw.prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").get() as
            | { seq: number; hash: string }
            | undefined;
          const ts = new Date().toISOString();
          const prev = tail?.hash ?? last.hash;
          const seq = (tail?.seq ?? last.seq) + 1;
          const detail = JSON.stringify({ kept: keepLast, removed: victims.length, upTo: last.seq });
          const hash = computeAuditHash({
            prevHash: prev,
            seq,
            ts,
            actor: opts.actor,
            action: "audit.prune",
            target: "audit",
            risk: 0,
            detail,
          });
          this.db.raw
            .prepare("INSERT INTO audit(seq,ts,actor,action,target,risk,detail,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?)")
            .run(seq, ts, opts.actor, "audit.prune", "audit", 0, detail, prev, hash);
          this.db.raw.exec("COMMIT");
          const remaining = this.db.raw.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number };
          return { removed: victims.length, kept: Number(remaining.n), checkpointId: Number(checkpoint.id) };
        } catch (err) {
          try {
            this.db.raw.exec("ROLLBACK");
          } catch {
            /* 事务可能已结束 */
          }
          throw err;
        }
      } catch (err) {
        const message = String((err as Error).message ?? err);
        const retryable = /SQLITE_BUSY|database is locked/i.test(message);
        attempt += 1;
        if (!retryable || attempt > 100) throw err;
        const until = Date.now() + 5;
        while (Date.now() < until) {
          /* spin */
        }
      }
    }
  }

  /** 最近一次裁剪锚点（供 verify 与诊断使用）。 */
  lastCheckpoint(): { prunedUpToSeq: number; prunedCount: number; headHash: string; actor: string; ts: string; reason?: string } | null {
    const row = this.db.raw
      .prepare("SELECT pruned_up_to_seq, pruned_count, head_hash, actor, ts, reason FROM audit_checkpoint ORDER BY id DESC LIMIT 1")
      .get() as
      | { pruned_up_to_seq: number; pruned_count: number; head_hash: string; actor: string; ts: string; reason: string | null }
      | undefined;
    if (!row) return null;
    return {
      prunedUpToSeq: Number(row.pruned_up_to_seq),
      prunedCount: Number(row.pruned_count),
      headHash: row.head_hash,
      actor: row.actor,
      ts: row.ts,
      ...(row.reason === null ? {} : { reason: row.reason }),
    };
  }

  /**
   * 链校验。若有裁剪历史，第一条剩余记录的 seq 会大于 1：
   * 此时必须存在 pruned_up_to_seq === firstSeq-1 的检查点，且其 head_hash === first.prev_hash。
   * 没有锚点却出现空洞 → 视为链损坏（不能当作"裁剪过"）。
   */
  verify(): AuditVerifyResult {
    const rows = this.db.raw.prepare("SELECT * FROM audit ORDER BY seq ASC").all() as unknown as AuditRow[];
    if (rows.length === 0) {
      const cp = this.lastCheckpoint();
      return cp === null ? { ok: true, checked: 0 } : { ok: true, checked: 0, reason: `all records pruned up to seq ${cp.prunedUpToSeq}` };
    }
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    const first = rows[0] as AuditRow;
    if (first.seq !== 1) {
      const cp = this.db.raw
        .prepare("SELECT head_hash, pruned_up_to_seq FROM audit_checkpoint WHERE pruned_up_to_seq=? ORDER BY id DESC LIMIT 1")
        .get(first.seq - 1) as { head_hash: string; pruned_up_to_seq: number } | undefined;
      if (!cp) {
        return {
          ok: false,
          checked: 0,
          brokenAt: first.seq,
          reason: `sequence gap with no prune checkpoint: expected 1, got ${first.seq}`,
        };
      }
      if (cp.head_hash !== first.prev_hash) {
        return {
          ok: false,
          checked: 0,
          brokenAt: first.seq,
          reason: `prune checkpoint hash mismatch at seq ${first.seq - 1}`,
        };
      }
      prev = cp.head_hash;
      expectedSeq = first.seq;
    }
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
