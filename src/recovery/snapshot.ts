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
    await atomicWriteFile(file, buf);
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
      .all(Math.max(1, Math.min(limit, 500))) as unknown as Array<{
      snap_id: string;
      label: string;
      created_ms: number;
      root_hash: string;
      manifest: string;
    }>;
    return rows.map((r) => {
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
    });
  }

  get(snapId: string): SnapshotRecord {
    const rec = this.list(500).find((s) => s.snapId === snapId);
    if (!rec) throw purgeError("not_found", `snapshot not found: ${snapId}`, { snapId });
    return rec;
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
   * 恢复快照。逐文件写回并回读哈希；任一失败立即停止并返回已恢复/失败明细。
   * `absent` 条目表示快照时刻该路径不存在 → 恢复时删除。
   */
  async restore(snapId: string): Promise<{ restored: string[]; removed: string[]; failed: Array<{ path: string; error: string }> }> {
    const rec = this.get(snapId);
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

  /** 清理没有任何快照引用的对象（GC）。 */
  async prune(): Promise<{ removed: number; kept: number }> {
    const referenced = new Set<string>();
    for (const rec of this.list(500)) {
      for (const e of rec.manifest.entries) if (e.hash) referenced.add(e.hash);
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
