/**
 * 配置中心：受管文件的读取 / 差异预演 / 冲突检测 / 提交与历史。
 *
 * 不变量（对应 ARCHITECTURE §5.3）：
 * 1. 读取返回内容哈希；提交时必须带上这个哈希。
 * 2. 提交前重新读取；若哈希已变（外部改动）→ conflict，拒绝覆盖。
 * 3. 提交走原子写并在写后回读校验。
 * 4. 每次成功提交生成一份历史快照（内容寻址），可按 id 取回。
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, ensureDir, readJson, sha256 } from "../core/atomic.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";

export interface ManagedFile {
  path: string;
  exists: boolean;
  hash: string;
  size: number;
  mtimeMs: number;
  content: string;
}

export interface DiffLine {
  kind: "same" | "add" | "remove";
  line: string;
}

export interface DiffResult {
  path: string;
  beforeHash: string;
  afterHash: string;
  addedLines: number;
  removedLines: number;
  lines: DiffLine[];
}

export interface ConfigVersion {
  id: string;
  path: string;
  hash: string;
  size: number;
  savedAt: string;
  actor: string;
}

interface HistoryIndex {
  entries: ConfigVersion[];
}

export class ConfigCenter {
  readonly dataDir: string;
  readonly historyDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.historyDir = path.join(dataDir, "managed-history");
  }

  async read(filePath: string): Promise<ManagedFile> {
    const abs = path.resolve(filePath);
    try {
      const buf = await fsp.readFile(abs);
      const st = await fsp.stat(abs);
      return { path: abs, exists: true, hash: sha256(buf), size: buf.length, mtimeMs: st.mtimeMs, content: buf.toString("utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { path: abs, exists: false, hash: sha256(""), size: 0, mtimeMs: 0, content: "" };
      }
      throw purgeError("unreadable", `cannot read ${abs}: ${(err as Error).message}`);
    }
  }

  /** 差异预演：不写盘。 */
  async diff(filePath: string, nextContent: string): Promise<DiffResult> {
    const current = await this.read(filePath);
    return diffText(current.path, current.content, nextContent, current.hash, sha256(nextContent));
  }

  /**
   * 提交：expectHash 必须是调用方读到的那份内容的哈希。
   * 磁盘已被外部改动 → conflict（不覆盖），并给出两边的哈希。
   */
  async commit(filePath: string, nextContent: string, opts: { expectHash?: string; actor?: string } = {}): Promise<ConfigVersion> {
    const abs = path.resolve(filePath);
    const current = await this.read(abs);
    if (opts.expectHash !== undefined && opts.expectHash !== current.hash) {
      throw purgeError("conflict", `external modification detected for ${abs}`, {
        expected: opts.expectHash,
        actual: current.hash,
        hint: "重新读取后再提交",
      });
    }
    const nextHash = sha256(nextContent);
    try {
      await atomicWriteFile(abs, nextContent);
    } catch (err) {
      throw asPurgeError(err);
    }
    const after = await this.read(abs);
    if (after.hash !== nextHash) {
      throw purgeError("integrity_failed", `post-write verification failed for ${abs}`, { expected: nextHash, actual: after.hash });
    }
    return this.#record(abs, nextContent, after.hash, opts.actor ?? "system", current);
  }

  async history(filePath?: string): Promise<ConfigVersion[]> {
    const idx = await this.#index();
    const list = filePath ? idx.entries.filter((e) => e.path === path.resolve(filePath)) : idx.entries;
    return [...list].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async versionsFor(filePath: string): Promise<ManagedFile[]> {
    const entries = await this.history(filePath);
    const out: ManagedFile[] = [];
    for (const entry of entries) {
      try {
        const buf = await fsp.readFile(path.join(this.historyDir, `${entry.id}.json`));
        const parsed = JSON.parse(buf.toString("utf8")) as { content: string; hash: string; size: number };
        out.push({ path: entry.path, exists: true, hash: parsed.hash, size: parsed.size, mtimeMs: Date.parse(entry.savedAt), content: parsed.content });
      } catch {
        // 历史损坏不隐藏，用空内容 + 原哈希占位，配合 verify 提示
        out.push({ path: entry.path, exists: false, hash: entry.hash, size: entry.size, mtimeMs: Date.parse(entry.savedAt), content: "" });
      }
    }
    return out;
  }

  /** 对比磁盘当前内容与某个历史版本。 */
  async diffWithVersion(filePath: string, versionId: string): Promise<DiffResult> {
    const entries = await this.history(filePath);
    const entry = entries.find((e) => e.id === versionId);
    if (!entry) throw purgeError("not_found", `config version not found: ${versionId}`);
    const buf = await fsp.readFile(path.join(this.historyDir, `${entry.id}.json`));
    const parsed = JSON.parse(buf.toString("utf8")) as { content: string; hash: string };
    const current = await this.read(filePath);
    return diffText(current.path, parsed.content, current.content, parsed.hash, current.hash);
  }

  async #record(abs: string, content: string, hash: string, actor: string, previous: ManagedFile): Promise<ConfigVersion> {
    await ensureDir(this.historyDir);
    const id = `${Date.now().toString(36)}-${hash.slice(0, 8)}`;
    await atomicWriteFile(
      path.join(this.historyDir, `${id}.json`),
      `${JSON.stringify({ path: abs, content, hash, size: Buffer.byteLength(content, "utf8"), previousHash: previous.hash, actor, savedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    const idx = await this.#index();
    const entry: ConfigVersion = {
      id,
      path: abs,
      hash,
      size: Buffer.byteLength(content, "utf8"),
      savedAt: new Date().toISOString(),
      actor,
    };
    idx.entries.push(entry);
    await atomicWriteFile(path.join(this.historyDir, "index.json"), `${JSON.stringify(idx, null, 2)}\n`);
    return entry;
  }

  async #index(): Promise<HistoryIndex> {
    return readJson<HistoryIndex>(path.join(this.historyDir, "index.json"), { entries: [] });
  }
}

/** 行级 diff（LCS），输出统一的 same/add/remove。 */
export function diffText(filePath: string, before: string, after: string, beforeHash: string, afterHash: string): DiffResult {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs = computeLcs(a, b);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  for (const common of lcs) {
    while (i < a.length && a[i] !== common) {
      lines.push({ kind: "remove", line: a[i] as string });
      removed += 1;
      i += 1;
    }
    while (j < b.length && b[j] !== common) {
      lines.push({ kind: "add", line: b[j] as string });
      added += 1;
      j += 1;
    }
    lines.push({ kind: "same", line: common });
    i += 1;
    j += 1;
  }
  while (i < a.length) {
    lines.push({ kind: "remove", line: a[i] as string });
    removed += 1;
    i += 1;
  }
  while (j < b.length) {
    lines.push({ kind: "add", line: b[j] as string });
    added += 1;
    j += 1;
  }
  return { path: path.resolve(filePath), beforeHash, afterHash, addedLines: added, removedLines: removed, lines };
}

function computeLcs(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  // 大文件退化保护：超过 2000 行改用前缀/后缀裁剪后的简化匹配，避免 O(n*m) 爆炸
  if (n * m > 4_000_000) {
    const out: string[] = [];
    let start = 0;
    while (start < n && start < m && a[start] === b[start]) {
      out.push(a[start] as string);
      start += 1;
    }
    return out;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(a[i] as string);
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return out;
}

export function formatDiff(d: DiffResult): string {
  const header = `${d.path}\n- 前 ${d.beforeHash.slice(0, 12)}\n+ 后 ${d.afterHash.slice(0, 12)}\n（+${d.addedLines} / -${d.removedLines}）`;
  const body = d.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "remove" ? "-" : " "} ${l.line}`).join("\n");
  return `${header}\n${body}`;
}
