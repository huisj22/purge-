/**
 * 配置中心（Purge+ 自身配置）。
 *
 * 不变量（有测试）：
 * 1. 校验失败不落盘；错误带字段路径。
 * 2. 每次成功变更写一份历史快照 + 字段级 diff。
 * 3. 未知字段保留在文件中但不生效（避免用户手写字段被静默删除）。
 * 4. 原子写，权限沿用既有文件。
 */
import * as path from "node:path";
import { atomicWriteFile, readJson } from "./atomic.ts";
import { purgeError } from "./errors.ts";
import { withWriteGuard } from "./lock.ts";
import { type Schema, validateSchema } from "./schema.ts";

export const CONFIG_SCHEMA: Schema = {
  port: { kind: "number", optional: true, default: 7801, min: 1, max: 65535, integer: true },
  host: { kind: "string", optional: true, default: "127.0.0.1" },
  logLevel: { kind: "string", optional: true, default: "info", enum: ["debug", "info", "warn", "error"] },
  /** API 访问令牌；为空表示未启用鉴权（此时只允许绑定回环地址）。 */
  apiToken: { kind: "string", optional: true, default: "", maxLength: 512 },
  hosts: {
    kind: "object",
    optional: true,
    fields: { roots: { kind: "string[]", optional: true, default: [] } },
  },
  policy: {
    kind: "object",
    optional: true,
    fields: {
      confirmThreshold: { kind: "number", optional: true, default: 30, min: 0, max: 100, integer: true },
      denyThreshold: { kind: "number", optional: true, default: 70, min: 0, max: 100, integer: true },
      allowActions: { kind: "string[]", optional: true, default: [] },
    },
  },
  scheduler: {
    kind: "object",
    optional: true,
    fields: {
      maxConcurrent: { kind: "number", optional: true, default: 2, min: 1, max: 32, integer: true },
      tickMs: { kind: "number", optional: true, default: 1000, min: 50, max: 60000, integer: true },
    },
  },
  inspector: {
    kind: "object",
    optional: true,
    fields: { timeoutMs: { kind: "number", optional: true, default: 5000, min: 100, max: 120000, integer: true } },
  },
  update: {
    kind: "object",
    optional: true,
    fields: {
      indexUrl: { kind: "string", optional: true, default: "" },
      channel: { kind: "string", optional: true, default: "stable" },
    },
  },
  plugins: {
    kind: "object",
    optional: true,
    fields: {
      enabled: { kind: "boolean", optional: true, default: true },
      /** in-process（默认）或 process（独立子进程，T-036） */
      isolation: { kind: "string", optional: true, default: "in-process", enum: ["in-process", "process"] },
    },
  },
};

export interface PurgeConfig {
  port: number;
  host: string;
  logLevel: "debug" | "info" | "warn" | "error";
  apiToken: string;
  hosts: { roots: string[] };
  policy: { confirmThreshold: number; denyThreshold: number; allowActions: string[] };
  scheduler: { maxConcurrent: number; tickMs: number };
  inspector: { timeoutMs: number };
  update: { indexUrl: string; channel: string };
  plugins: { enabled: boolean; isolation: "in-process" | "process" };
}

export interface ConfigHistoryEntry {
  seq: number;
  ts: string;
  changed: string[];
  diff: Array<{ path: string; from: unknown; to: unknown }>;
  /** 快照文件相对 dataDir 的路径。 */
  snapshot: string;
}

interface HistoryIndex {
  next: number;
  entries: ConfigHistoryEntry[];
}

export class ConfigStore {
  readonly dataDir: string;
  readonly file: string;
  readonly historyDir: string;
  #current: PurgeConfig | null = null;
  #raw: Record<string, unknown> = {};

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "config.json");
    this.historyDir = path.join(dataDir, "config-history");
  }

  async load(): Promise<PurgeConfig> {
    const raw = await readJson<Record<string, unknown>>(this.file, {});
    return this.#apply(raw, false);
  }

  /** 变更配置；patch 为深合并的对象。校验失败抛 schema_invalid，不落盘。 */
  async update(patch: Record<string, unknown>): Promise<PurgeConfig> {
    return withWriteGuard(this.dataDir, { resource: "setting", scope: "config", operation: "config.update" }, () => this.#updateLocked(patch));
  }

  async #updateLocked(patch: Record<string, unknown>): Promise<PurgeConfig> {
    const base = this.#current ?? (await this.load());
    const merged = deepMerge(this.#raw, patch);
    // 1) 先纯校验（不改变任何状态）
    const validated = validateSchema<PurgeConfig>(CONFIG_SCHEMA, merged);
    if (!validated.ok) {
      throw purgeError("schema_invalid", "config validation failed", { issues: validated.issues, file: this.file });
    }
    if (JSON.stringify(merged) === JSON.stringify(this.#raw)) return validated.value;
    // 2) 再落盘；失败则内存态保持原样（P2-01）
    await atomicWriteFile(this.file, `${JSON.stringify(merged, null, 2)}\n`);
    // 3) 落盘成功后才切换内存态
    this.#raw = { ...merged };
    this.#current = validated.value;
    const diff = diffConfig(base, validated.value);
    await this.#appendHistory(validated.value, diff);
    return validated.value;
  }

  get(): PurgeConfig {
    if (!this.#current) throw purgeError("invalid_argument", "config not loaded; call load() first");
    return this.#current;
  }

  async history(): Promise<ConfigHistoryEntry[]> {
    const idx = await readJson<HistoryIndex>(path.join(this.historyDir, "index.json"), { next: 1, entries: [] });
    return idx.entries;
  }

  async readHistorySnapshot(seq: number): Promise<Record<string, unknown>> {
    return readJson<Record<string, unknown>>(path.join(this.historyDir, `config-${seq}.json`), {});
  }

  #apply(raw: Record<string, unknown>, strict: boolean): PurgeConfig {
    const result = validateSchema<PurgeConfig>(CONFIG_SCHEMA, raw);
    if (!result.ok) {
      // strict 与初次加载都不允许损坏配置被默认值顶替：必须报告带路径的问题。
      throw purgeError("schema_invalid", strict ? "config validation failed" : "config file is invalid", {
        issues: result.issues,
        file: this.file,
        unknownKeys: result.unknownKeys,
      });
    }
    this.#raw = { ...raw };
    this.#current = result.value;
    return result.value;
  }

  async #appendHistory(next: PurgeConfig, diff: ConfigHistoryEntry["diff"]): Promise<void> {
    const idxPath = path.join(this.historyDir, "index.json");
    const idx = await readJson<HistoryIndex>(idxPath, { next: 1, entries: [] });
    const seq = idx.next;
    const snapshotRel = `config-history/config-${seq}.json`;
    await atomicWriteFile(path.join(this.historyDir, `config-${seq}.json`), `${JSON.stringify(next, null, 2)}\n`);
    const entry: ConfigHistoryEntry = {
      seq,
      ts: new Date().toISOString(),
      changed: diff.map((d) => d.path),
      diff,
      snapshot: snapshotRel,
    };
    idx.entries.push(entry);
    idx.next = seq + 1;
    await atomicWriteFile(idxPath, `${JSON.stringify(idx, null, 2)}\n`);
  }
}

export function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    if (isPlainObject(prev) && isPlainObject(v)) out[k] = deepMerge(prev, v);
    else out[k] = v;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function diffConfig(a: unknown, b: unknown, prefix = ""): Array<{ path: string; from: unknown; to: unknown }> {
  const out: Array<{ path: string; from: unknown; to: unknown }> = [];
  const walk = (x: unknown, y: unknown, p: string): void => {
    if (isPlainObject(x) && isPlainObject(y)) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of [...keys].sort()) walk(x[k], y[k], p ? `${p}.${k}` : k);
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path: p, from: x, to: y });
  };
  walk(a, b, prefix);
  return out;
}
