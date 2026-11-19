/**
 * 事务式文件变更。
 *
 * 协议：begin(捕获快照) → write/remove(记录预期哈希) → verify(回读) → commit | rollback。
 * 约束：任何写入都必须经过事务，否则 rollback 无法还原。
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, ensureDir, sha256 } from "../core/atomic.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";
import type { SnapshotStore } from "./snapshot.ts";

export type TxState = "open" | "verified" | "committed" | "rolled_back" | "failed";

export interface TxChange {
  path: string;
  action: "write" | "remove" | "mkdir";
  expectedHash?: string;
  bytes?: number;
}

export interface TxResult {
  txId: string;
  label: string;
  state: TxState;
  snapshotId: string;
  changes: TxChange[];
  verified: boolean;
  rollback?: { restored: string[]; removed: string[]; failed: Array<{ path: string; error: string }> };
}

export interface TransactionOptions {
  snapshots: SnapshotStore;
  actor?: string;
  onEvent?: (event: { type: string; txId: string; detail?: unknown }) => void;
}

export class Transaction {
  readonly txId: string;
  readonly label: string;
  readonly #snapshots: SnapshotStore;
  readonly #actor: string;
  readonly #onEvent: (e: { type: string; txId: string; detail?: unknown }) => void;
  #snapshotId = "";
  #state: TxState = "open";
  #changes: TxChange[] = [];
  #touched = new Set<string>();
  #targets = new Set<string>();

  constructor(label: string, opts: TransactionOptions) {
    this.txId = `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.label = label;
    this.#snapshots = opts.snapshots;
    this.#actor = opts.actor ?? "system";
    this.#onEvent = opts.onEvent ?? (() => {});
  }

  get state(): TxState {
    return this.#state;
  }

  get changes(): ReadonlyArray<TxChange> {
    return this.#changes;
  }

  /** 在改动任何文件之前登记目标；快照在此刻捕获。 */
  async begin(targets: string[]): Promise<void> {
    if (this.#state !== "open") throw purgeError("invalid_argument", `transaction already ${this.#state}`);
    for (const t of targets) this.#targets.add(path.resolve(t));
    if (this.#targets.size === 0) throw purgeError("invalid_argument", "transaction needs at least one target");
    const rec = await this.#snapshots.capture(`tx:${this.label}`, [...this.#targets]);
    this.#snapshotId = rec.snapId;
    this.#onEvent({ type: "begin", txId: this.txId, detail: { snapshotId: this.#snapshotId, targets: [...this.#targets] } });
  }

  async write(file: string, data: Buffer | string): Promise<void> {
    this.#assertOpen();
    const abs = path.resolve(file);
    this.#touch(abs);
    await atomicWriteFile(abs, data);
    const hash = sha256(typeof data === "string" ? Buffer.from(data) : data);
    // 回读校验：写成功不等于写对
    const after = sha256(await fsp.readFile(abs));
    if (after !== hash) throw purgeError("integrity_failed", `post-write hash mismatch for ${abs}`, { expected: hash, actual: after });
    this.#changes.push({ path: abs, action: "write", expectedHash: hash, bytes: typeof data === "string" ? Buffer.byteLength(data) : data.length });
  }

  async remove(file: string): Promise<void> {
    this.#assertOpen();
    const abs = path.resolve(file);
    this.#touch(abs);
    await fsp.rm(abs, { force: true });
    this.#changes.push({ path: abs, action: "remove" });
  }

  async mkdir(dir: string): Promise<void> {
    this.#assertOpen();
    const abs = path.resolve(dir);
    this.#touch(abs);
    await ensureDir(abs);
    this.#changes.push({ path: abs, action: "mkdir" });
  }

  /** 回读所有变更，确认磁盘状态与预期一致。 */
  async verify(): Promise<{ ok: boolean; problems: string[] }> {
    this.#assertOpen();
    const problems: string[] = [];
    for (const change of this.#changes) {
      if (change.action === "write" && change.expectedHash) {
        try {
          const actual = sha256(await fsp.readFile(change.path));
          if (actual !== change.expectedHash) problems.push(`${change.path}: hash ${actual} != ${change.expectedHash}`);
        } catch (err) {
          problems.push(`${change.path}: ${asPurgeError(err).message}`);
        }
      } else if (change.action === "remove") {
        try {
          await fsp.stat(change.path);
          problems.push(`${change.path}: still exists after remove`);
        } catch {
          /* expected missing */
        }
      } else if (change.action === "mkdir") {
        try {
          const st = await fsp.stat(change.path);
          if (!st.isDirectory()) problems.push(`${change.path}: not a directory`);
        } catch {
          problems.push(`${change.path}: directory missing`);
        }
      }
    }
    if (problems.length === 0) this.#state = "verified";
    return { ok: problems.length === 0, problems };
  }

  commit(): TxResult {
    this.#assertOpen("commit");
    if (this.#state !== "verified") throw purgeError("invalid_argument", "cannot commit before verify() passes");
    this.#state = "committed";
    this.#onEvent({ type: "commit", txId: this.txId, detail: { changes: this.#changes.length } });
    return this.result();
  }

  async rollback(): Promise<TxResult> {
    if (this.#state === "committed") throw purgeError("invalid_argument", "cannot rollback a committed transaction");
    if (this.#state === "rolled_back") return this.result();
    const rollback = await this.#snapshots.restore(this.#snapshotId, {
      policy: "force",
      authorizedBy: `transaction:${this.#actor}`,
      reason: `rollback of ${this.txId} (${this.label})`,
    });
    // 快照之前不存在的路径，restore 已按 absent 处理；这里再兜底清理事务新建的文件
    for (const change of this.#changes) {
      if (change.action !== "mkdir") continue;
      await fsp.rm(change.path, { force: true }).catch(() => {});
    }
    this.#state = rollback.failed.length === 0 ? "rolled_back" : "failed";
    this.#onEvent({ type: "rollback", txId: this.txId, detail: rollback });
    return { ...this.result(), rollback };
  }

  result(): TxResult {
    return {
      txId: this.txId,
      label: this.label,
      state: this.#state,
      snapshotId: this.#snapshotId,
      changes: [...this.#changes],
      verified: this.#state === "verified" || this.#state === "committed",
    };
  }

  #assertOpen(action = "mutate"): void {
    if (this.#state === "committed" || this.#state === "rolled_back" || this.#state === "failed") {
      throw purgeError("invalid_argument", `cannot ${action}: transaction is ${this.#state}`);
    }
    if (this.#snapshotId === "") throw purgeError("invalid_argument", `cannot ${action}: call begin() first`);
  }

  #touch(abs: string): void {
    this.#touched.add(abs);
  }

  get actor(): string {
    return this.#actor;
  }

  get targets(): string[] {
    return [...this.#targets];
  }
}
