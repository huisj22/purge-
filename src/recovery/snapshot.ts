/**
 * 快照与内容寻址对象库。
 *
 * 设计来自原项目的维护经验，并修掉两个已知坑：
 * - 小文件内联进 manifest（阈值 32KB），避免对象库被配置碎片撑爆；
 * - 恢复时逐文件回读哈希校验，绝不「写完就算成功」。
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, ensureDir, sha256 } from "../core/atomic.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";
import { withWriteGuard } from "../core/lock.ts";
import type { Database } from "../storage/database.ts";

export const INLINE_LIMIT = 32 * 1024;

export type SnapshotEntryType = "file" | "dir" | "absent";

export interface SnapshotEntry {
  /** 绝对路径：恢复时的目标。 */
  path: string;
  type: SnapshotEntryType;
  hash?: string;
  size?: number;
  /** <= INLINE_LIMIT 的文件内容以 base64 内联。 */
  inline?: string;
  mode?: number;
}

export interface SnapshotManifest {
  schema: "purgeplus.snapshot/1";
  snapId: string;
  label: string;
  createdMs: number;
  entries: SnapshotEntry[];
}

export interface RestoreResult {
  restored: string[];
  removed: string[];
  failed: Array<{ path: string; error: string }>;
  /** 失败后是否成功回滚到恢复前状态。 */
  rolledBack: boolean;
  /** 失败前的保护性快照 id。 */
  preSnapshotId?: string;
  /** 回滚本身失败时的明细（此时现场需要人工介入）。 */
  rollbackFailed?: Array<{ path: string; error: string }>;
  /** 强制恢复时记录的覆盖信息（P2-08）。 */
  force?: { authorizedBy: string; reason?: string; overwritten: Array<{ path: string; fromHash: string; toHash: string }> };
}

/** 恢复前的逐文件冲突状态（P2-08）。 */
export type RestoreEntryStatus = "UNCHANGED" | "MODIFIED" | "NEWER" | "DELETED" | "UNKNOWN" | "CORRUPTED";

export interface RestorePlanEntry {
  path: string;
  status: RestoreEntryStatus;
  /** 快照中的内容哈希（absent 条目为 null）。 */
  snapshotHash: string | null;
  /** 当前磁盘内容哈希（不存在为 null）。 */
  currentHash: string | null;
  /** 恢复后要执行的动作。 */
  action: "restore" | "delete" | "noop";
  reason?: string;
}

export interface RestorePlan {
  snapId: string;
  label: string;
  snapshotCreatedMs: number;
  entries: RestorePlanEntry[];
  counts: Record<RestoreEntryStatus, number>;
  /** 默认会被阻止的状态数量（MODIFIED/NEWER/CORRUPTED/UNKNOWN）。 */
  conflicts: number;
  /** 是否存在需要人工确认的项。 */
  blocked: boolean;
}

export interface RestoreOptions {
  /** 默认 block：存在冲突即拒绝；force：需 authorizedBy。 */
  policy?: "block" | "force";
  authorizedBy?: string;
  reason?: string;
  /** 测试/审计用：在 plan 完成后、真正写盘前插入一次复检（TOCTOU 防护验证）。 */
  onBeforeApply?: () => Promise<void>;
}

const BLOCKING_STATUSES: RestoreEntryStatus[] = ["MODIFIED", "NEWER", "CORRUPTED", "UNKNOWN"];

interface SnapshotRow {
  snap_id: string;
  label: string;
  created_ms: number;
  root_hash: string;
  manifest: string;
}

function rowToRecord(r: SnapshotRow): SnapshotRecord {
  const manifest = JSON.parse(r.manifest) as SnapshotManifest;
  return {
    snapId: r.snap_id,
    label: r.label,
    createdMs: Number(r.created_ms),
    rootHash: r.root_hash,
    manifest,
    stats: {
      files: manifest.entries.filter((e) => e.type === "file").length,
      bytes: manifest.entries.reduce((n, e) => n + (e.size ?? 0), 0),
      inline: manifest.entries.filter((e) => e.inline !== undefined).length,
      dirs: manifest.entries.filter((e) => e.type === "dir").length,
    },
  };
}

export interface SnapshotRecord {
  snapId: string;
  label: string;
  createdMs: number;
  rootHash: string;
  manifest: SnapshotManifest;
  /** 统计：文件数 / 字节数 / 内联数 */
  stats: { files: number; bytes: number; inline: number; dirs: number };
}

export class SnapshotStore {
  readonly dataDir: string;
  readonly objectsDir: string;
  readonly db: Database;

  constructor(dataDir: string, db: Database) {
    this.dataDir = dataDir;
    this.objectsDir = path.join(dataDir, "objects");
    this.db = db;
  }

  objectPath(hash: string): string {
    return path.join(this.objectsDir, hash.slice(0, 2), hash.slice(2));
  }

  async putObject(buf: Buffer): Promise<string> {
    const hash = sha256(buf);
    const file = this.objectPath(hash);
    try {
      const st = await fsp.stat(file);
      if (st.size === buf.length) return hash;
    } catch {
      /* not present */
    }
    try {
      await atomicWriteFile(file, buf);
    } catch (err) {
      // 并发写同一对象（内容相同）在 Windows 上可能因 rename 竞争失败；
      // 只要最终对象存在且内容正确，就视为成功（CAS 幂等）。
      const existing = await fsp.readFile(file).catch(() => null);
      if (!existing || sha256(existing) !== hash) throw asPurgeError(err);
    }
    return hash;
  }

  async getObject(hash: string): Promise<Buffer> {
    try {
      const buf = await fsp.readFile(this.objectPath(hash));
      const actual = sha256(buf);
      if (actual !== hash) {
        throw purgeError("integrity_failed", `object ${hash} content hash mismatch (${actual})`);
      }
      return buf;
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code: string }).code === "integrity_failed") throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw purgeError("not_found", `object missing from store: ${hash}`, { hash });
      }
      throw asPurgeError(err);
    }
  }

  async capture(label: string, targets: string[]): Promise<SnapshotRecord> {
    // 跨进程互斥（T-037）：capture 也串行，避免两个进程同时写同一对象目录
    return withWriteGuard(this.dataDir, { resource: "snapshot", scope: "snapshot", operation: "snapshot.capture" }, () =>
      this.#captureLocked(label, targets),
    );
  }

  async #captureLocked(label: string, targets: string[]): Promise<SnapshotRecord> {
    const snapId = `snap-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const entries: SnapshotEntry[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      const abs = path.resolve(target);
      if (seen.has(abs)) continue;
      seen.add(abs);
      await this.#capturePath(abs, entries);
    }
    const rootHash = sha256(entries.map((e) => `${e.path}:${e.type}:${e.hash ?? ""}:${e.inline ?? ""}`).join("\n"));
    const manifest: SnapshotManifest = {
      schema: "purgeplus.snapshot/1",
      snapId,
      label,
      createdMs: Date.now(),
      entries,
    };
    const stats = {
      files: entries.filter((e) => e.type === "file").length,
      bytes: entries.reduce((n, e) => n + (e.size ?? 0), 0),
      inline: entries.filter((e) => e.inline !== undefined).length,
      dirs: entries.filter((e) => e.type === "dir").length,
    };
    this.db.raw
      .prepare("INSERT INTO snapshot(snap_id,label,created_ms,root_hash,manifest) VALUES(?,?,?,?,?)")
      .run(snapId, label, manifest.createdMs, rootHash, JSON.stringify(manifest));
    // 写后自检（P3-25）：创建即证明完整；不自洽就撤销这条快照，避免"看起来存在但恢复不了"。
    const check = await this.verify(snapId);
    if (!check.ok) {
      this.db.raw.prepare("DELETE FROM snapshot WHERE snap_id=?").run(snapId);
      throw purgeError("integrity_failed", `snapshot ${snapId} failed self-verification`, { issues: check.issues.slice(0, 5) });
    }
    return { snapId, label, createdMs: manifest.createdMs, rootHash, manifest, stats };
  }

  async #capturePath(abs: string, entries: SnapshotEntry[]): Promise<void> {
    let st;
    try {
      st = await fsp.lstat(abs);
    } catch {
      entries.push({ path: abs, type: "absent" });
      return;
    }
    if (st.isDirectory()) {
      entries.push({ path: abs, type: "dir", mode: st.mode & 0o777 });
      const children = await fsp.readdir(abs, { withFileTypes: true });
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (child.isSymbolicLink()) continue; // 不跟随链接，避免把外部树纳入快照
        await this.#capturePath(path.join(abs, child.name), entries);
      }
      return;
    }
    if (!st.isFile()) {
      entries.push({ path: abs, type: "absent" });
      return;
    }
    const buf = await fsp.readFile(abs);
    const hash = await this.putObject(buf);
    const entry: SnapshotEntry = { path: abs, type: "file", hash, size: buf.length, mode: st.mode & 0o777 };
    if (buf.length <= INLINE_LIMIT) entry.inline = buf.toString("base64");
    entries.push(entry);
  }

  list(limit = 50): SnapshotRecord[] {
    const rows = this.db.raw
      .prepare("SELECT snap_id,label,created_ms,root_hash,manifest FROM snapshot ORDER BY created_ms DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 500))) as unknown as SnapshotRow[];
    return rows.map(rowToRecord);
  }

  /** 按 id 精确查询；不受列表上限影响（P2-05 修复）。 */
  get(snapId: string): SnapshotRecord {
    const row = this.db.raw
      .prepare("SELECT snap_id,label,created_ms,root_hash,manifest FROM snapshot WHERE snap_id=?")
      .get(snapId) as SnapshotRow | undefined;
    if (!row) throw purgeError("not_found", `snapshot not found: ${snapId}`, { snapId });
    return rowToRecord(row);
  }

  /** 校验快照自身完整性：内联内容与对象库内容都要对得上 manifest。 */
  async verify(snapId: string): Promise<{ ok: boolean; issues: string[] }> {
    const rec = this.get(snapId);
    const issues: string[] = [];
    for (const entry of rec.manifest.entries) {
      if (entry.type !== "file" || !entry.hash) continue;
      if (entry.inline !== undefined) {
        const actual = sha256(Buffer.from(entry.inline, "base64"));
        if (actual !== entry.hash) issues.push(`inline hash mismatch: ${entry.path}`);
      }
      try {
        await this.getObject(entry.hash);
      } catch (err) {
        issues.push(`object missing/corrupt: ${entry.path} (${(err as Error).message})`);
      }
    }
    return { ok: issues.length === 0, issues };
  }

  /**
   * 恢复快照（事务化，P1-03 修复）。
   *
   * 协议：① 先给目标拍一张 pre-restore 快照；② 逐条应用；
   *       ③ 任一失败 → 立刻用 pre 快照回滚，返回 rolledBack=true；
   *       ④ 全成功 → rolledBack=false。
   * 并发：同一 store 内的 restore 串行执行（P2-09）。
   */
  /**
   * 只读恢复预演（P2-08）：不改磁盘，逐文件给出 UNCHANGED/MODIFIED/NEWER/DELETED/UNKNOWN/CORRUPTED。
   * 冲突默认阻止；调用方必须显式 force 并给出授权人才能覆盖。
   */
  async planRestore(snapId: string): Promise<RestorePlan> {
    const rec = this.get(snapId);
    const entries: RestorePlanEntry[] = [];
    const counts: Record<RestoreEntryStatus, number> = {
      UNCHANGED: 0,
      MODIFIED: 0,
      NEWER: 0,
      DELETED: 0,
      UNKNOWN: 0,
      CORRUPTED: 0,
    };
    for (const entry of rec.manifest.entries) {
      const planned = await this.#planEntry(entry, rec.createdMs);
      counts[planned.status] += 1;
      entries.push(planned);
    }
    const conflicts = BLOCKING_STATUSES.reduce((n, s) => n + counts[s], 0);
    return {
      snapId,
      label: rec.label,
      snapshotCreatedMs: rec.createdMs,
      entries,
      counts,
      conflicts,
      blocked: conflicts > 0,
    };
  }

  async #planEntry(entry: SnapshotEntry, snapshotCreatedMs: number): Promise<RestorePlanEntry> {
    // absent：快照时刻这个路径不存在 → 恢复时应当删除
    if (entry.type === "absent") {
      const exists = await fsp
        .stat(entry.path)
        .then(() => true)
        .catch(() => false);
      return exists
        ? { path: entry.path, status: "MODIFIED", snapshotHash: null, currentHash: null, action: "delete", reason: "快照时不存在，当前存在（恢复将删除）" }
        : { path: entry.path, status: "UNCHANGED", snapshotHash: null, currentHash: null, action: "noop" };
    }
    if (entry.type === "dir") {
      return { path: entry.path, status: "UNCHANGED", snapshotHash: null, currentHash: null, action: "noop", reason: "目录条目" };
    }
    // 快照自身是否可读（对象/内联）
    if (entry.hash) {
      try {
        if (entry.inline !== undefined) {
          const inlineHash = sha256(Buffer.from(entry.inline, "base64"));
          if (inlineHash !== entry.hash) {
            return { path: entry.path, status: "CORRUPTED", snapshotHash: entry.hash, currentHash: null, action: "noop", reason: "快照内联内容哈希不符" };
          }
        } else {
          await this.getObject(entry.hash);
        }
      } catch (err) {
        return { path: entry.path, status: "CORRUPTED", snapshotHash: entry.hash, currentHash: null, action: "noop", reason: `快照内容不可用：${asPurgeError(err).message}` };
      }
    }
    let buf: Buffer;
    try {
      buf = await fsp.readFile(entry.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { path: entry.path, status: "DELETED", snapshotHash: entry.hash ?? null, currentHash: null, action: "restore", reason: "文件已被删除" };
      }
      return { path: entry.path, status: "UNKNOWN", snapshotHash: entry.hash ?? null, currentHash: null, action: "noop", reason: `无法读取当前文件：${(err as Error).message}` };
    }
    const currentHash = sha256(buf);
    if (entry.hash && currentHash === entry.hash) {
      return { path: entry.path, status: "UNCHANGED", snapshotHash: entry.hash, currentHash, action: "noop" };
    }
    const st = await fsp.stat(entry.path).catch(() => null);
    const newer = st ? st.mtimeMs > snapshotCreatedMs : false;
    return {
      path: entry.path,
      status: newer ? "NEWER" : "MODIFIED",
      snapshotHash: entry.hash ?? null,
      currentHash,
      action: "restore",
      reason: newer ? "当前文件比快照更新" : "当前文件内容与快照不同",
    };
  }

  /**
   * 恢复快照（事务化 + 冲突检测）。
   *
   * 协议：① 预演冲突 → ② 有冲突且非 force 则拒绝 → ③ 拍 pre-restore 快照 →
   *       ④ 复检（TOCTOU）→ ⑤ 逐条应用 → ⑥ 失败则回滚并验证回滚结果。
   */
  async restore(snapId: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
    return withWriteGuard(this.dataDir, { resource: "snapshot", scope: "snapshot", operation: "snapshot.restore" }, () =>
      this.#withRestoreLock(async () => {
        const plan = await this.planRestore(snapId);
        if (plan.blocked && opts.policy !== "force") {
          throw purgeError("conflict", `restore blocked: ${plan.conflicts} conflicting entries`, {
            snapId,
            plan,
            hint: "确认要用快照覆盖当前内容时，使用 policy=force 并给出 authorizedBy",
          });
        }
        if (opts.policy === "force" && (!opts.authorizedBy || opts.authorizedBy.trim().length === 0)) {
          throw purgeError("policy_denied", "force restore requires authorizedBy", { snapId, plan });
        }
        const rec = this.get(snapId);
        const targets = rec.manifest.entries.map((e) => e.path);
        const pre = await this.capture(`pre-restore:${snapId}`, targets);

        if (opts.onBeforeApply) await opts.onBeforeApply();

        // TOCTOU：拍完保护快照、开始写盘前再算一次，防止"预演之后文件又变了"
        const recheck = await this.planRestore(snapId);
        if (recheck.blocked && opts.policy !== "force") {
          throw purgeError("conflict", `restore aborted: state changed between plan and apply (${recheck.conflicts} conflicts)`, {
            snapId,
            plan: recheck,
            preSnapshotId: pre.snapId,
          });
        }

        const overwritten = recheck.entries
          .filter((e) => e.status !== "UNCHANGED" && e.currentHash)
          .map((e) => ({ path: e.path, fromHash: e.currentHash as string, toHash: e.snapshotHash ?? "(deleted)" }));

        const attempt = await this.#applyEntries(rec);
        const base: RestoreResult = attempt.failed.length === 0
          ? { ...attempt, rolledBack: false, preSnapshotId: pre.snapId }
          : {
              ...attempt,
              rolledBack: (await this.#applyEntries(this.get(pre.snapId))).failed.length === 0,
              preSnapshotId: pre.snapId,
            };
        if (opts.policy === "force") {
          base.force = {
            authorizedBy: opts.authorizedBy as string,
            ...(opts.reason ? { reason: opts.reason } : {}),
            overwritten,
          };
        }
        return base;
      }),
    );
  }

  async #applyEntries(rec: SnapshotRecord): Promise<{ restored: string[]; removed: string[]; failed: Array<{ path: string; error: string }> }> {
    const restored: string[] = [];
    const removed: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const entry of rec.manifest.entries) {
      try {
        if (entry.type === "file") {
          const buf = entry.inline !== undefined ? Buffer.from(entry.inline, "base64") : await this.getObject(entry.hash as string);
          const actual = sha256(buf);
          if (entry.hash && actual !== entry.hash) throw new Error(`content hash mismatch before write (${actual})`);
          await ensureDir(path.dirname(entry.path));
          await atomicWriteFile(entry.path, buf, entry.mode === undefined ? {} : { mode: entry.mode });
          const after = sha256(await fsp.readFile(entry.path));
          if (entry.hash && after !== entry.hash) throw new Error(`post-write hash mismatch (${after})`);
          restored.push(entry.path);
        } else if (entry.type === "absent") {
          await fsp.rm(entry.path, { force: true, recursive: false });
          removed.push(entry.path);
        } else if (entry.type === "dir") {
          await ensureDir(entry.path);
        }
      } catch (err) {
        failed.push({ path: entry.path, error: asPurgeError(err).message });
      }
    }
    return { restored, removed, failed };
  }

  #restoreChain: Promise<unknown> = Promise.resolve();

  #withRestoreLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#restoreChain.then(fn, fn);
    // 保持链条前进，但不让失败的链条阻塞后续调用
    this.#restoreChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 清理没有任何快照引用的对象（GC）。引用集覆盖**所有**快照（P3-20 修复）。 */
  async prune(): Promise<{ removed: number; kept: number }> {
    const referenced = new Set<string>();
    const rows = this.db.raw.prepare("SELECT manifest FROM snapshot").all() as unknown as Array<{ manifest: string }>;
    for (const row of rows) {
      const manifest = JSON.parse(row.manifest) as SnapshotManifest;
      for (const e of manifest.entries) if (e.hash) referenced.add(e.hash);
    }
    let removed = 0;
    let kept = 0;
    const walk = async (dir: string): Promise<void> => {
      const children = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const child of children) {
        const abs = path.join(dir, child.name);
        if (child.isDirectory()) {
          await walk(abs);
          const left = await fsp.readdir(abs).catch(() => []);
          if (left.length === 0) await fsp.rmdir(abs).catch(() => {});
        } else {
          const hash = `${path.basename(dir)}${child.name}`;
          if (referenced.has(hash)) kept += 1;
          else {
            await fsp.rm(abs, { force: true });
            removed += 1;
          }
        }
      }
    };
    await walk(this.objectsDir);
    return { removed, kept };
  }
}
