/**
 * 包仓库：导入、落盘、列出。导入前必须通过 schema 校验，并记录内容哈希与来源。
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, ensureDir, readJson } from "../core/atomic.ts";
import { purgeError } from "../core/errors.ts";
import { withWriteGuard } from "../core/lock.ts";
import { packHash, validatePack, type Pack } from "./schema.ts";

export interface StoredPack {
  pack: Pack;
  hash: string;
  importedAt: string;
  /** 来源描述（文件名/URL）。 */
  source: string;
  /** 文件路径。 */
  file: string;
}

interface IndexEntry {
  id: string;
  version: string;
  hash: string;
  importedAt: string;
  source: string;
  file: string;
}

interface PackIndex {
  entries: IndexEntry[];
}

export class PackStore {
  readonly dataDir: string;
  readonly dir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, "packs");
  }

  async importPack(input: unknown, source: string): Promise<StoredPack> {
    // 跨进程互斥：index.json 是"读-改-写"，无锁时两个进程会互相覆盖（丢条目）
    return withWriteGuard(this.dataDir, { resource: "packs", scope: "pack", operation: "pack.import", waitMs: 5000 }, () => this.#importPackLocked(input, source));
  }

  async #importPackLocked(input: unknown, source: string): Promise<StoredPack> {
    const pack = validatePack(input);
    const hash = packHash(pack);
    await ensureDir(this.dir);
    const file = path.join(this.dir, `${pack.id}@${pack.version}.json`);
    // 同 id+version 但内容不同 → 冲突，不静默覆盖
    try {
      const existing = JSON.parse(await fsp.readFile(file, "utf8")) as Pack;
      const existingHash = packHash(existing);
      if (existingHash !== hash) {
        throw purgeError("conflict", `pack ${pack.id}@${pack.version} already imported with a different content hash`, {
          existing: existingHash,
          incoming: hash,
        });
      }
      const idx = await this.#index();
      const entry = idx.entries.find((e) => e.id === pack.id && e.version === pack.version);
      return {
        pack,
        hash,
        importedAt: entry?.importedAt ?? new Date().toISOString(),
        source: entry?.source ?? source,
        file,
      };
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code: string }).code === "conflict") throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        if (err instanceof SyntaxError) throw purgeError("schema_invalid", `existing pack file is corrupt: ${file}`);
      }
    }
    await atomicWriteFile(file, `${JSON.stringify(pack, null, 2)}\n`);
    const idx = await this.#index();
    const importedAt = new Date().toISOString();
    idx.entries = idx.entries.filter((e) => !(e.id === pack.id && e.version === pack.version));
    idx.entries.push({ id: pack.id, version: pack.version, hash, importedAt, source, file });
    await atomicWriteFile(path.join(this.dir, "index.json"), `${JSON.stringify(idx, null, 2)}\n`);
    return { pack, hash, importedAt, source, file };
  }

  async list(): Promise<StoredPack[]> {
    const idx = await this.#index();
    const out: StoredPack[] = [];
    for (const entry of [...idx.entries].sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version))) {
      try {
        const pack = validatePack(await readJson<unknown>(entry.file));
        out.push({ pack, hash: packHash(pack), importedAt: entry.importedAt, source: entry.source, file: entry.file });
      } catch {
        // 损坏的包不隐藏：以最小信息暴露，便于用户清理
        out.push({
          pack: { schema: "purgeplus.pack/1", id: entry.id, name: "(corrupt)", version: entry.version, target: { adapter: "?" }, risk: { level: "critical", reasons: ["文件损坏"] }, rules: [] },
          hash: entry.hash,
          importedAt: entry.importedAt,
          source: entry.source,
          file: entry.file,
        });
      }
    }
    return out;
  }

  async get(id: string, version?: string): Promise<StoredPack> {
    const all = await this.list();
    const candidates = all.filter((p) => p.pack.id === id && (version ? p.pack.version === version : true));
    if (candidates.length === 0) throw purgeError("not_found", `pack not found: ${id}${version ? `@${version}` : ""}`);
    // 未指定版本时取版本号最大者（简单字符串序，够用且可预测）
    return candidates.sort((a, b) => a.pack.version.localeCompare(b.pack.version)).at(-1) as StoredPack;
  }

  async #index(): Promise<PackIndex> {
    return readJson<PackIndex>(path.join(this.dir, "index.json"), { entries: [] });
  }
}
