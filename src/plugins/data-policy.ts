/**
 * 插件数据边界（T055-03）。
 *
 * 目标：把"插件私有数据"从"插件程序目录"里分离出来，并在宿主侧强制执行目录边界。
 *
 * 重要边界声明：
 * - 本模块提供的是 **宿主调解的数据访问**（HOST_MEDIATED_DATA_ACCESS），
 *   它只能约束"通过 ctx.data / ctx.store 走宿主 API"的访问。
 * - 插件进程仍拥有当前用户的文件系统权限，可直接 `import("node:fs")` 读写任意路径。
 *   因此这不是 OS 级隔离（NOT_OS_SANDBOXED），文档与报告不得写成沙箱。
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, ensureDir, readJson, removeTreeNoFollow, sha256 } from "../core/atomic.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";

/** 插件 ID 只允许小写字母/数字/点/下划线/连字符，且不能以点开头。 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 256;

export function assertPluginId(id: string): string {
  if (!PLUGIN_ID_RE.test(id)) {
    throw purgeError("invalid_argument", `invalid plugin id: ${JSON.stringify(id)}`, {
      hint: "小写字母/数字/点/下划线/连字符，1–64 位，且不能以点开头",
    });
  }
  if (id.includes("..")) throw purgeError("invalid_argument", `plugin id must not contain '..': ${id}`);
  return id;
}

/** 把插件提供的相对路径规范化，并拒绝绝对路径 / 上跳 / Windows 设备名。 */
export function normalizeRelative(rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) throw purgeError("invalid_argument", "relative path must be a non-empty string");
  if (rel.length > 512) throw purgeError("invalid_argument", "relative path too long");
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("\\\\") || rel.startsWith("//")) {
    throw purgeError("policy_denied", `absolute paths are not allowed: ${rel}`, { state: "PLUGIN_DATA_ACCESS_DENIED" });
  }
  const normalized = path.normalize(rel).replace(/\\/g, "/");
  if (normalized === "." || normalized === "" || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw purgeError("policy_denied", `path traversal is not allowed: ${rel}`, { state: "PLUGIN_DATA_ACCESS_DENIED" });
  }
  if (/(^|\/)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|\/|$)/i.test(normalized)) {
    throw purgeError("policy_denied", `reserved device name: ${rel}`, { state: "PLUGIN_DATA_ACCESS_DENIED" });
  }
  return normalized;
}

export interface PluginDataApi {
  read(rel: string): Promise<Buffer>;
  write(rel: string, data: Buffer | string): Promise<{ path: string; hash: string; size: number }>;
  list(rel?: string): Promise<Array<{ name: string; dir: boolean; size: number }>>;
  remove(rel: string): Promise<{ removed: boolean }>;
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  keys(): Promise<string[]>;
}

export class PluginDataStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  dirFor(pluginId: string): string {
    return path.join(this.root, assertPluginId(pluginId));
  }

  async ensure(pluginId: string): Promise<string> {
    const dir = this.dirFor(pluginId);
    await ensureDir(dir);
    return dir;
  }

  /**
   * 解析并校验目标路径。
   *
   * 校验顺序：
   * 1. 相对路径规范化（拒绝绝对路径 / `..` / 设备名）。
   * 2. 拼接后的词法前缀检查。
   * 3. 逐级 lstat：任何已存在的组件是符号链接/junction → 拒绝（不跟随）。
   * 4. 对最深的已存在祖先做 realpath，再次确认仍在插件目录内（防 junction 逃逸）。
   */
  async resolvePath(pluginId: string, rel: string): Promise<string> {
    const dir = this.dirFor(pluginId);
    const clean = normalizeRelative(rel);
    const target = path.resolve(dir, clean);
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      throw purgeError("policy_denied", `resolved path escapes plugin data dir: ${rel}`, { state: "PLUGIN_DATA_ACCESS_DENIED" });
    }
    // 根目录必须真实存在，否则 realpath 比较没有基准
    await ensureDir(this.root);
    const realRoot = await fsp.realpath(this.root);

    // 逐级检查已存在组件：任何 symlink / junction 一律拒绝（不跟随）
    const parts = clean.split("/");
    let cursor = dir;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      const st = await fsp.lstat(cursor).catch(() => null);
      if (!st) break;
      if (st.isSymbolicLink()) {
        throw purgeError("policy_denied", `symbolic links are not allowed inside plugin data: ${rel}`, { state: "PLUGIN_DATA_ACCESS_DENIED" });
      }
    }

    // 最近的存在祖先做 realpath，确认它仍在数据根目录内（防 junction/挂载点逃逸）
    let probe = path.dirname(target);
    for (;;) {
      const realProbe = await fsp.realpath(probe).catch(() => null);
      if (realProbe) {
        if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
          throw purgeError("policy_denied", `resolved path escapes plugin data dir via link: ${rel}`, { state: "PLUGIN_DATA_ACCESS_DENIED" });
        }
        break;
      }
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    return target;
  }

  api(pluginId: string): PluginDataApi {
    assertPluginId(pluginId);
    const storeFile = path.join(this.dirFor(pluginId), "store.json");
    const withKeyGuard = (key: string): string => {
      if (typeof key !== "string" || key.length === 0 || Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
        throw purgeError("invalid_argument", "invalid store key");
      }
      return key;
    };
    return {
      read: async (rel) => {
        const target = await this.resolvePath(pluginId, rel);
        const st = await fsp.stat(target).catch(() => null);
        if (!st || !st.isFile()) throw purgeError("not_found", `plugin data file not found: ${rel}`);
        if (st.size > MAX_READ_BYTES) throw purgeError("invalid_argument", `plugin data file too large: ${rel} (${st.size} bytes)`);
        return fsp.readFile(target);
      },
      write: async (rel, data) => {
        const target = await this.resolvePath(pluginId, rel);
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
        if (buf.length > MAX_READ_BYTES) throw purgeError("invalid_argument", `plugin data write too large (${buf.length} bytes)`);
        await ensureDir(path.dirname(target));
        await atomicWriteFile(target, buf);
        return { path: target, hash: sha256(buf), size: buf.length };
      },
      list: async (rel = ".") => {
        const target = rel === "." ? this.dirFor(pluginId) : await this.resolvePath(pluginId, rel);
        const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => []);
        const out: Array<{ name: string; dir: boolean; size: number }> = [];
        for (const e of entries) {
          const st = await fsp.lstat(path.join(target, e.name)).catch(() => null);
          out.push({ name: e.name, dir: e.isDirectory(), size: st?.size ?? 0 });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
      },
      remove: async (rel) => {
        const target = await this.resolvePath(pluginId, rel);
        const existed = await fsp.lstat(target).then(() => true).catch(() => false);
        if (!existed) return { removed: false };
        await removeTreeNoFollow(target);
        return { removed: true };
      },
      get: async <T,>(key: string) => {
        const data = await readJson<Record<string, unknown>>(storeFile, {});
        return data[withKeyGuard(key)] as T | undefined;
      },
      set: async (key, value) => {
        const data = await readJson<Record<string, unknown>>(storeFile, {});
        data[withKeyGuard(key)] = value;
        await ensureDir(path.dirname(storeFile));
        await atomicWriteFile(storeFile, `${JSON.stringify(data, null, 2)}\n`);
      },
      keys: async () => Object.keys(await readJson<Record<string, unknown>>(storeFile, {})).sort(),
    };
  }

  /** 卸载时按策略处理数据：默认保留；purgeData 才删除（且不允许越界删除）。 */
  async drop(pluginId: string): Promise<{ removed: boolean }> {
    const dir = this.dirFor(pluginId);
    const realRoot = path.resolve(this.root);
    if (path.dirname(dir) !== realRoot) {
      throw purgeError("policy_denied", `refusing to remove outside plugin data root: ${dir}`, { state: "PLUGIN_DATA_ACCESS_DENIED" });
    }
    const existed = await fsp.lstat(dir).then(() => true).catch(() => false);
    if (!existed) return { removed: false };
    await removeTreeNoFollow(dir);
    return { removed: true };
  }

  async exists(pluginId: string): Promise<boolean> {
    return fsp
      .stat(this.dirFor(pluginId))
      .then((s) => s.isDirectory())
      .catch(() => false);
  }

  /** 旧版本数据迁移：把 `<program>/.data/store.json` 迁到新数据目录（目标已存在则不覆盖）。 */
  async migrateLegacy(pluginId: string, legacyDir: string): Promise<{ migrated: boolean; reason?: string }> {
    const legacyStore = path.join(legacyDir, "store.json");
    const raw = await fsp.readFile(legacyStore, "utf8").catch(() => null);
    if (raw === null) return { migrated: false, reason: "no legacy data" };
    try {
      const target = this.dirFor(pluginId);
      await ensureDir(target);
      const existing = await fsp.readFile(path.join(target, "store.json"), "utf8").catch(() => null);
      if (existing !== null) return { migrated: false, reason: "target already has data" };
      JSON.parse(raw);
      await atomicWriteFile(path.join(target, "store.json"), raw);
      return { migrated: true };
    } catch (err) {
      return { migrated: false, reason: asPurgeError(err).message };
    }
  }
}
