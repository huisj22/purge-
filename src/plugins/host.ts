/**
 * 插件宿主：清单校验 / 安装（内容寻址）/ 启停 / 能力白名单 / 健康检查。
 *
 * 设计（见 MASTER_PROMPT §5.12 与安全评审 §4）：
 * - 插件是**受能力约束的进程内模块**：只能拿到 manifest.capabilities 声明的服务。
 * - 越权访问抛 CapabilityError，不靠"插件自觉"。
 * - 安装时复制到 <dataDir>/plugins/<name>@<version>/，记录文件树哈希；
 *   同名不同内容 = 冲突，不静默覆盖。
 * - 加载失败只把该插件标记 broken，不影响其它插件与宿主。
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteFile, ensureDir, readJson, removeTreeNoFollow, sha256File } from "../core/atomic.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";
import { withWriteGuard } from "../core/lock.ts";
import { PluginDataStore } from "./data-policy.ts";
import type { Logger } from "../core/logger.ts";

export const PLUGIN_API_VERSION = "1";

export type PluginPrivilege = "host" | "declared";

export interface PluginManifest {
  name: string;
  version: string;
  apiVersion: string;
  entry: string;
  /**
   * 权限等级（必填，P1-04）：
   * - "declared"：只通过 ctx.use() 访问能力（仍然与宿主同进程，不是沙箱）
   * - "host"：明确承认拥有宿主同等权限，启用时必须显式 trust
   */
  privilege: PluginPrivilege;
  description?: string;
  /** 允许访问的宿主服务名（白名单）。 */
  capabilities: string[];
  /** 声明式权限说明，仅用于展示与审计。 */
  permissions?: string[];
}

export interface PluginContext {
  readonly name: string;
  readonly version: string;
  readonly dataDir: string;
  log: (level: "debug" | "info" | "warn" | "error", msg: string, ctx?: unknown) => void;
  /** 取一个已声明的服务；未声明 → CapabilityError。 */
  use<T>(service: string): T;
  /** 插件私有 KV（落在插件数据目录）。 */
  store: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  /**
   * 宿主调解的数据访问（T055-03）：所有路径由宿主校验，限制在本插件数据目录内。
   * 这不是 OS 沙箱：插件仍可直接使用 node:fs 访问其它路径。
   */
  data: {
    read(rel: string): Promise<Buffer>;
    write(rel: string, data: Buffer | string): Promise<{ path: string; hash: string; size: number }>;
    list(rel?: string): Promise<Array<{ name: string; dir: boolean; size: number }>>;
    remove(rel: string): Promise<{ removed: boolean }>;
  };
}

export interface PluginInstance {
  activate?(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  health?(): { ok: boolean; detail?: string } | Promise<{ ok: boolean; detail?: string }>;
  invoke?(method: string, args: unknown): unknown | Promise<unknown>;
}

export type PluginState = "enabled" | "disabled" | "broken";

export interface InstalledPlugin {
  manifest: PluginManifest;
  dir: string;
  state: PluginState;
  hash: string;
  installedAt: string;
  error?: string;
}

export interface PluginHostOptions {
  dataDir: string;
  /** in-process（默认）或 process（独立子进程，T-036）。 */
  isolation?: "in-process" | "process";
  /** 数据访问被拒绝时的审计回调（T055-03）。 */
  onAudit?: (event: { action: string; target?: string; risk?: number; detail?: unknown }) => void;
  logger: Logger;
  /** 服务解析器：能力名 → 服务实例。由组合根注入（通常是 kernel.get）。 */
  resolveService: (name: string) => unknown;
}

interface StateFile {
  plugins: Array<{ name: string; version: string; state: PluginState; installedAt: string; enabled: boolean }>;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class PluginHost {
  readonly dir: string;
  readonly dataDir: string;
  /** 插件私有数据根目录（与程序目录分离）。 */
  readonly dataRoot: string;
  readonly stateFile: string;
  #dataStore: PluginDataStore;
  readonly #o: PluginHostOptions;
  readonly #instances = new Map<string, PluginInstance>();
  readonly #workers = new Map<string, import("./isolated-host.ts").IsolatedPluginWorker>();

  constructor(opts: PluginHostOptions) {
    this.#o = opts;
    this.dataDir = opts.dataDir;
    this.dir = path.join(opts.dataDir, "plugins");
    this.dataRoot = path.join(opts.dataDir, "plugin-data");
    this.#dataStore = new PluginDataStore(this.dataRoot);
    this.stateFile = path.join(opts.dataDir, "plugin-state.json");
  }

  async list(): Promise<InstalledPlugin[]> {
    await ensureDir(this.dir);
    const state = await this.#state();
    const entries = await fsp.readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const out: InstalledPlugin[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = path.join(this.dir, entry.name);
      const manifestPath = path.join(dir, "plugin.json");
      try {
        const manifest = await this.#readManifest(manifestPath);
        const record = state.plugins.find((p) => p.name === manifest.name && p.version === manifest.version);
        out.push({
          manifest,
          dir,
          state: record?.state ?? "disabled",
          hash: await this.#treeHash(dir),
          installedAt: record?.installedAt ?? new Date(0).toISOString(),
        });
      } catch (err) {
        out.push({
          manifest: { name: entry.name, version: "?", apiVersion: "?", entry: "", privilege: "declared", capabilities: [] },
          dir,
          state: "broken",
          hash: "",
          installedAt: new Date(0).toISOString(),
          error: asPurgeError(err).message,
        });
      }
    }
    return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  async install(sourceDir: string, opts: { overwrite?: boolean } = {}): Promise<InstalledPlugin> {
    return withWriteGuard(this.dataDir, { resource: "plugin", scope: "plugin", operation: "plugin.install" }, () => this.#installLocked(sourceDir, opts));
  }

  async #installLocked(sourceDir: string, opts: { overwrite?: boolean }): Promise<InstalledPlugin> {
    const src = path.resolve(sourceDir);
    const manifest = await this.#readManifest(path.join(src, "plugin.json"));
    const dest = path.join(this.dir, `${manifest.name}@${manifest.version}`);
    const destExists = await fsp.stat(dest).then((s) => s.isDirectory()).catch(() => false);
    const srcHash = await this.#treeHash(src);
    if (destExists) {
      const destHash = await this.#treeHash(dest);
      if (destHash === srcHash) {
        return { manifest, dir: dest, state: (await this.#stateOf(manifest.name, manifest.version)) ?? "disabled", hash: destHash, installedAt: new Date().toISOString() };
      }
      if (opts.overwrite !== true) {
        throw purgeError("conflict", `plugin ${manifest.name}@${manifest.version} already installed with different content`, {
          installed: destHash,
          incoming: srcHash,
        });
      }
      await removeTreeNoFollow(dest);
    }
    await ensureDir(this.dir);
    await copyDir(src, dest);
    const installedHash = await this.#treeHash(dest);
    if (installedHash !== srcHash) {
      await removeTreeNoFollow(dest);
      throw purgeError("integrity_failed", "installed plugin content differs from source", { expected: srcHash, actual: installedHash });
    }
    const state = await this.#state();
    state.plugins = state.plugins.filter((p) => !(p.name === manifest.name && p.version === manifest.version));
    state.plugins.push({ name: manifest.name, version: manifest.version, state: "disabled", installedAt: new Date().toISOString(), enabled: false });
    await this.#saveState(state);
    return { manifest, dir: dest, state: "disabled", hash: installedHash, installedAt: new Date().toISOString() };
  }

  async enable(name: string, opts: { trusted?: boolean } = {}): Promise<InstalledPlugin> {
    return withWriteGuard(this.dataDir, { resource: "plugin", scope: "plugin", operation: "plugin.enable", waitMs: 5000 }, () => this.#enableLocked(name, opts));
  }

  async #enableLocked(name: string, opts: { trusted?: boolean } = {}): Promise<InstalledPlugin> {
    const plugin = await this.#find(name);
    if (this.#o.isolation === "process") {
      // 进程隔离模式（T-036）：插件跑在独立子进程，能力调用由 Host 审批
      if (plugin.manifest.privilege === "host" && opts.trusted !== true) {
        throw purgeError("policy_denied", `plugin ${name} runs with host privileges and needs explicit trust`, { privilege: plugin.manifest.privilege });
      }
      const { IsolatedPluginWorker } = await import("./isolated-host.ts");
      const worker = new IsolatedPluginWorker({
        manifest: plugin.manifest,
        pluginDir: plugin.dir,
        dataDir: this.#dataStore.dirFor(plugin.manifest.name),
        logger: this.#o.logger,
        capabilityResolver: (service, capabilityMethod) => {
          // 数据通道：走宿主的数据边界校验（T055-03），不经过能力白名单
          if (service === "__data__") {
            const api = this.#deniedAuditedApi(plugin.manifest.name);
            return {
              allow: true,
              invoke: (...args: unknown[]) => {
                const [rel, payload] = args as [string, unknown];
                switch (capabilityMethod) {
                  case "data.read":
                    return api.read(rel);
                  case "data.write": {
                    const buf =
                      payload && typeof payload === "object" && (payload as { type?: string }).type === "Buffer"
                        ? Buffer.from((payload as { data: number[] }).data)
                        : Buffer.from(String(payload ?? ""), "utf8");
                    return api.write(rel, buf);
                  }
                  case "data.list":
                    return api.list(rel);
                  case "data.remove":
                    return api.remove(rel);
                  case "data.get":
                    return api.get(rel);
                  case "data.set":
                    return api.set(rel, payload).then(() => ({ ok: true }));
                  default:
                    throw new Error(`unknown data operation: ${capabilityMethod}`);
                }
              },
            };
          }
          if (!plugin.manifest.capabilities.includes(service)) return { allow: false, reason: `capability ${service} not declared` };
          const svc = this.#o.resolveService(service) as Record<string, unknown> | undefined;
          return {
            allow: true,
            invoke: (...args: unknown[]) => {
              // 只允许调用服务上真实存在的方法，避免任意属性透传
              if (!svc) throw new Error(`service ${service} is not available`);
              const method = String(capabilityMethod);
              const fn = (svc as Record<string, unknown>)[method];
              if (typeof fn !== "function") throw new Error(`service ${service} has no method ${method}`);
              return (fn as (...a: unknown[]) => unknown).apply(svc, args);
            },
          };
        },
      });
      await worker.start();
      this.#workers.set(name, worker);
      const state = await this.#state();
      const record = state.plugins.find((p) => p.name === name);
      if (record) {
        record.state = "enabled";
        record.enabled = true;
      }
      await this.#saveState(state);
      return { ...plugin, state: "enabled" };
    }
    // P1-04：host 特权插件必须显式信任；这不是沙箱，只是让用户明确知道后果。
    if (plugin.manifest.privilege === "host" && opts.trusted !== true) {
      throw purgeError("policy_denied", `plugin ${name} runs with host privileges and needs explicit trust`, {
        privilege: plugin.manifest.privilege,
        hint: "使用 --trust（CLI）或 confirm:true（API）确认你知道它会以宿主权限运行",
      });
    }
    const instance = await this.#load(plugin);
    const state = await this.#state();
    const record = state.plugins.find((p) => p.name === name);
    if (record) {
      record.state = "enabled";
      record.enabled = true;
    }
    await this.#saveState(state);
    this.#instances.set(name, instance);
    return { ...plugin, state: "enabled" };
  }

  async disable(name: string): Promise<InstalledPlugin> {
    return withWriteGuard(this.dataDir, { resource: "plugin", scope: "plugin", operation: "plugin.disable", waitMs: 5000 }, () => this.#disableLocked(name));
  }

  async #disableLocked(name: string): Promise<InstalledPlugin> {
    const worker = this.#workers.get(name);
    if (worker) {
      await worker.stop();
      this.#workers.delete(name);
    }
    const instance = this.#instances.get(name);
    if (instance?.deactivate) {
      try {
        await instance.deactivate();
      } catch (err) {
        this.#o.logger.warn("plugin deactivate failed", { name, error: asPurgeError(err).message });
      }
    }
    this.#instances.delete(name);
    const plugin = await this.#find(name);
    const state = await this.#state();
    const record = state.plugins.find((p) => p.name === name);
    if (record) {
      record.state = "disabled";
      record.enabled = false;
    }
    await this.#saveState(state);
    return { ...plugin, state: "disabled" };
  }

  async health(name: string, opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; state: PluginState; detail?: string }> {
    const plugin = await this.#find(name);
    if (plugin.state !== "enabled") return { ok: false, state: plugin.state, detail: "插件未启用" };
    const workerFirst = this.#workers.get(name);
    if (workerFirst) {
      const r = await workerFirst.request("health");
      if (!r.ok) return { ok: false, state: "broken", detail: r.error };
      const value = r.value as { ok?: boolean; detail?: string } | undefined;
      return { ok: value?.ok !== false, state: "enabled", detail: value?.detail ?? "worker health ok" };
    }
    const instance = this.#instances.get(name);
    if (!instance) {
      try {
        this.#instances.set(name, await this.#load(plugin));
      } catch (err) {
        return { ok: false, state: "broken", detail: asPurgeError(err).message };
      }
    }
    const worker = this.#workers.get(name);
    if (worker) {
      const r = await worker.request("health");
      if (!r.ok) return { ok: false, state: worker.state === "TIMEOUT" ? "broken" : "broken", detail: r.error };
      const value = r.value as { ok?: boolean; detail?: string } | undefined;
      return { ok: value?.ok !== false, state: "enabled", detail: value?.detail ?? "worker health ok" };
    }
    const inst = this.#instances.get(name);
    if (!inst?.health) return { ok: true, state: "enabled", detail: "未实现 health()，视为已加载" };
    try {
      const r = await withPluginTimeout(Promise.resolve(inst.health()), opts.timeoutMs ?? 5000, `health of ${name}`);
      return { ok: r.ok, state: r.ok ? "enabled" : "broken", detail: r.detail };
    } catch (err) {
      return { ok: false, state: "broken", detail: asPurgeError(err).message };
    }
  }

  /** 调用插件方法（受启用状态约束；默认 5s 超时，P1-04）。 */
  async invoke(name: string, method: string, args: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    const plugin = await this.#find(name);
    if (plugin.state !== "enabled") throw purgeError("conflict", `plugin is not enabled: ${name}`, { state: plugin.state });
    let instance = this.#instances.get(name);
    if (!instance) {
      instance = await this.#load(plugin);
      this.#instances.set(name, instance);
    }
    const worker = this.#workers.get(name);
    if (worker) {
      const r = await worker.request("invoke", { method, args }, );
      if (!r.ok) throw purgeError(r.state === "TIMEOUT" ? "timeout" : "internal", r.error ?? "worker invoke failed");
      return r.value;
    }
    if (!instance.invoke) throw purgeError("unsupported", `plugin ${name} does not export invoke()`);
    return withPluginTimeout(Promise.resolve(instance.invoke(method, args)), opts.timeoutMs ?? 5000, `invoke ${name}.${method}`);
  }

  /**
   * 卸载插件。
   * 默认**保留**插件私有数据（用户数据不因卸载而消失）；只有 purgeData=true 才删除。
   */
  async remove(name: string, opts: { purgeData?: boolean } = {}): Promise<{ removed: string; dataPurged: boolean; dataKept: boolean }> {
    return withWriteGuard(this.dataDir, { resource: "plugin", scope: "plugin", operation: "plugin.remove", waitMs: 5000 }, () =>
      this.#removeLocked(name, opts),
    );
  }

  async #removeLocked(name: string, opts: { purgeData?: boolean } = {}): Promise<{ removed: string; dataPurged: boolean; dataKept: boolean }> {
    const plugin = await this.#find(name);
    if (plugin.state === "enabled") await this.disable(name);
    // 只删程序文件；私有数据在 plugin-data/<id>/，与版本目录分离
    await removeTreeNoFollow(plugin.dir);
    let dataPurged = false;
    let dataKept = false;
    if (opts.purgeData === true) {
      const dropped = await this.#dataStore.drop(name);
      dataPurged = dropped.removed;
      this.#o.onAudit?.({ action: "plugin.data.purged", target: name, risk: 60, detail: { removed: dropped.removed } });
    } else {
      dataKept = await this.#dataStore.exists(name);
    }
    const state = await this.#state();
    state.plugins = state.plugins.filter((p) => p.name !== name);
    await this.#saveState(state);
    return { removed: plugin.dir, dataPurged, dataKept };
  }

  async #load(plugin: InstalledPlugin): Promise<PluginInstance> {
    const entryPath = path.join(plugin.dir, plugin.manifest.entry);
    const normalized = path.resolve(entryPath);
    if (!normalized.startsWith(path.resolve(plugin.dir) + path.sep)) {
      throw purgeError("policy_denied", `plugin entry escapes its directory: ${plugin.manifest.entry}`);
    }
    const exists = await fsp.stat(normalized).then((s) => s.isFile()).catch(() => false);
    if (!exists) throw purgeError("not_found", `plugin entry not found: ${normalized}`);
    // 数据目录独立于程序目录；首次加载时把旧版 `<program>/.data` 迁移过来
    await this.#dataStore.ensure(plugin.manifest.name);
    await this.#dataStore.migrateLegacy(plugin.manifest.name, path.join(plugin.dir, ".data"));
    const ctx = this.#context(plugin);
    try {
      const mod = (await import(pathToFileURL(normalized).href)) as PluginInstance;
      if (typeof mod.activate === "function") await mod.activate(ctx);
      return mod;
    } catch (err) {
      const e = asPurgeError(err);
      const state = await this.#state();
      const record = state.plugins.find((p) => p.name === plugin.manifest.name);
      if (record) record.state = "broken";
      await this.#saveState(state);
      throw purgeError("service_failed", `plugin ${plugin.manifest.name} failed to load: ${e.message}`, { cause: e.toJSON() });
    }
  }

  #context(plugin: InstalledPlugin): PluginContext {
    const granted = new Set(plugin.manifest.capabilities);
    // 数据目录与程序目录分离：升级/重装不会丢数据，卸载默认保留数据
    const dataDir = this.#dataStore.dirFor(plugin.manifest.name);
    const api = this.#deniedAuditedApi(plugin.manifest.name);
    return {
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      dataDir,
      data: {
        read: api.read,
        write: api.write,
        list: api.list,
        remove: api.remove,
      },
      log: (level, msg, ctx) => this.#o.logger[level](`[plugin:${plugin.manifest.name}] ${msg}`, ctx),
      use: <T,>(service: string): T => {
        if (!granted.has(service)) {
          throw purgeError("policy_denied", `plugin ${plugin.manifest.name} did not declare capability "${service}"`, {
            declared: [...granted],
          });
        }
        return this.#o.resolveService(service) as T;
      },
      store: {
        get: <T,>(key: string) => api.get<T>(key),
        set: (key: string, value: unknown) => api.set(key, value),
      },
    };
  }

  /** 数据访问被拒绝时写入审计（T055-03）：拒绝必须可追溯。 */
  #deniedAuditedApi(name: string): ReturnType<PluginDataStore["api"]> {
    const api = this.#dataStore.api(name);
    const audit = this.#o.onAudit;
    const wrap = <A extends unknown[], R>(op: string, fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err) {
        const e = asPurgeError(err);
        if (e.code === "policy_denied" || e.code === "invalid_argument") {
          audit?.({ action: "plugin.data.denied", target: name, risk: 40, detail: { op, args: args.slice(0, 1), code: e.code, message: e.message } });
          throw purgeError("policy_denied", `plugin ${name} data access denied: ${e.message}`, {
            ...(e.detail !== undefined ? { detail: e.detail } : {}),
            plugin: name,
            operation: op,
          });
        }
        throw err;
      }
    };
    return {
      read: wrap("read", api.read),
      write: wrap("write", api.write),
      list: wrap("list", api.list),
      remove: wrap("remove", api.remove),
      get: wrap("get", api.get),
      set: wrap("set", api.set),
      keys: wrap("keys", api.keys),
    } as ReturnType<PluginDataStore["api"]>;
  }
  async #readManifest(file: string): Promise<PluginManifest> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(file, "utf8"));
    } catch (err) {
      throw purgeError("schema_invalid", `cannot read plugin manifest ${file}: ${(err as Error).message}`);
    }
    const m = raw as Partial<PluginManifest>;
    const problems: string[] = [];
    if (!m.name || !NAME_RE.test(m.name)) problems.push("name must match [a-z0-9._-]");
    if (!m.version) problems.push("version is required");
    if (m.apiVersion !== PLUGIN_API_VERSION) problems.push(`apiVersion must be "${PLUGIN_API_VERSION}"`);
    if (!m.entry || m.entry.includes("..") || path.isAbsolute(m.entry)) problems.push("entry must be a relative path");
    if (!Array.isArray(m.capabilities)) problems.push("capabilities must be an array");
    if (m.privilege !== "host" && m.privilege !== "declared") {
      problems.push('privilege must be "host" or "declared"（运行在宿主进程内，无法提供沙箱）');
    }
    if (problems.length > 0) {
      throw purgeError("schema_invalid", `invalid plugin manifest: ${problems.join("; ")}`, { file, problems });
    }
    return {
      name: m.name as string,
      version: m.version as string,
      apiVersion: m.apiVersion as string,
      entry: m.entry as string,
      privilege: m.privilege as PluginPrivilege,
      description: m.description,
      capabilities: m.capabilities as string[],
      permissions: m.permissions ?? [],
    };
  }

  async #find(name: string): Promise<InstalledPlugin> {
    const all = await this.list();
    const found = all.filter((p) => p.manifest.name === name).sort((a, b) => a.manifest.version.localeCompare(b.manifest.version)).at(-1);
    if (!found) throw purgeError("not_found", `plugin not installed: ${name}`);
    return found;
  }

  async #stateOf(name: string, version: string): Promise<PluginState | undefined> {
    const state = await this.#state();
    return state.plugins.find((p) => p.name === name && p.version === version)?.state;
  }

  async #state(): Promise<StateFile> {
    return readJson<StateFile>(this.stateFile, { plugins: [] });
  }

  async #saveState(state: StateFile): Promise<void> {
    await ensureDir(path.dirname(this.stateFile));
    await atomicWriteFile(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  async #treeHash(dir: string): Promise<string> {
    const hash = createHash("sha256");
    const walk = async (current: string, rel: string): Promise<void> => {
      const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === ".data") continue;
        const abs = path.join(current, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(abs, relPath);
        } else if (entry.isFile()) {
          hash.update(`${relPath}:${await sha256File(abs)}\n`);
        }
      }
    };
    await walk(dir, "");
    return hash.digest("hex");
  }
}

/** 插件调用超时：插件代码是任意代码，不能让它无限阻塞调用方。 */
async function withPluginTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(purgeError("timeout", `${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".data") continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await copyDir(from, to);
      continue;
    }
    if (entry.isFile()) await fsp.copyFile(from, to);
  }
}
