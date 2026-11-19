/**
 * 文件系统原子写与哈希工具。
 *
 * 设计约束（来自原项目缺陷史）：
 * - 写临时文件 → fsync → rename，绝不就地截断。
 * - 覆盖已有文件时保留其权限位（避免 0755 变 0644、0600 变 0644）。
 * - 失败时清理临时文件，不留半成品。
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { asPurgeError, purgeError } from "./errors.ts";

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256FileSync(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export async function sha256File(file: string): Promise<string> {
  const buf = await fsp.readFile(file);
  return createHash("sha256").update(buf).digest("hex");
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export interface AtomicWriteOptions {
  /** 显式指定文件模式（八进制）。缺省时沿用目标已有模式，新文件用 0o644。 */
  mode?: number;
  /** 写后 fsync 目录（POSIX 语义更强；Windows 上为 no-op）。 */
  fsyncDir?: boolean;
}

export async function atomicWriteFile(file: string, data: Buffer | string, opts: AtomicWriteOptions = {}): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let existingMode: number | undefined;
  try {
    const st = await fsp.stat(file);
    existingMode = st.mode & 0o777;
  } catch {
    existingMode = undefined;
  }
  const mode = opts.mode ?? existingMode ?? 0o644;
  try {
    const fh = await fsp.open(tmp, "w", mode);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (existingMode !== undefined && (existingMode & 0o777) !== (mode & 0o777)) {
      await fsp.chmod(tmp, mode);
    }
    await fsp.rename(tmp, file);
    if (opts.fsyncDir !== false && process.platform !== "win32") {
      try {
        const dh = await fsp.open(dir, "r");
        try {
          await dh.sync();
        } finally {
          await dh.close();
        }
      } catch {
        /* 目录 fsync 失败不影响正确性，按尽力而为处理 */
      }
    }
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw purgeError("unwritable", `cannot write ${file}: ${(err as Error).message}`, { file });
  }
}

export function atomicWriteFileSync(file: string, data: Buffer | string, opts: AtomicWriteOptions = {}): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let existingMode: number | undefined;
  try {
    existingMode = fs.statSync(file).mode & 0o777;
  } catch {
    existingMode = undefined;
  }
  const mode = opts.mode ?? existingMode ?? 0o644;
  try {
    fs.writeFileSync(tmp, data, { mode });
    const fd = fs.openSync(tmp, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw new PurgeFsError(file, "unwritable", err);
  }
}

export class PurgeFsError extends Error {
  readonly code: "unreadable" | "unwritable" | "not_found";
  readonly path: string;
  constructor(file: string, code: "unreadable" | "unwritable" | "not_found", cause?: unknown) {
    super(`${code}: ${file}`, cause === undefined ? undefined : { cause });
    this.name = "PurgeFsError";
    this.code = code;
    this.path = file;
  }
}

export async function readJson<T>(file: string, fallback?: T): Promise<T> {
  try {
    const text = await fsp.readFile(file, "utf8");
    if (!text.trim()) {
      if (fallback !== undefined) return fallback;
      throw purgeError("schema_invalid", `empty json file: ${file}`);
    }
    return JSON.parse(text) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined) return fallback;
    if (err instanceof Error && "code" in err && err.code === "schema_invalid") throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new PurgeFsError(file, "not_found", err);
    if (err instanceof SyntaxError) {
      throw purgeError("schema_invalid", `invalid json in ${file}: ${err.message}`, { file });
    }
    throw asPurgeError(err);
  }
}

export async function writeJsonAtomic(file: string, value: unknown, opts: AtomicWriteOptions = {}): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, opts);
}

/** 递归删除但不跟随符号链接/junction（Windows 上 junction 递归会被当成真目录删）。 */
export async function removeTreeNoFollow(target: string): Promise<void> {
  let st: fs.Stats;
  try {
    st = await fsp.lstat(target);
  } catch {
    return;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    await fsp.rm(target, { force: true });
    return;
  }
  const entries = await fsp.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      await fsp.rm(child, { force: true });
      continue;
    }
    if (entry.isDirectory()) await removeTreeNoFollow(child);
    else await fsp.rm(child, { force: true });
  }
  try {
    await fsp.rmdir(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new PurgeFsError(target, "unwritable", err);
  }
}

/** 列出目录树（相对路径 + 尺寸 + 哈希），用于快照与一致性校验。 */
export async function hashTree(root: string): Promise<Array<{ rel: string; size: number; hash: string }>> {
  const out: Array<{ rel: string; size: number; hash: string }> = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const st = await fsp.lstat(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await walk(abs, relPath);
      } else if (st.isFile()) {
        out.push({ rel: relPath, size: st.size, hash: await sha256File(abs) });
      }
    }
  };
  await walk(root, "");
  return out;
}
