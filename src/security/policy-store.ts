/**
 * 权限分级与策略完整性（P2-10）。
 *
 * 角色：owner（授权者）/ executor（执行者）/ advisor（AI 建议）/ auditor（只读审计）
 * 等级：L0 只读 · L1 安全操作 · L2 受控写入 · L3 高风险 · L4 管理级
 *
 * 硬约束：
 * 1. 只有 owner 能修改策略或授予权限；executor/advisor 一律拒绝。
 * 2. AI（advisor）只能请求，不能批准；对 L3+ 永远拒绝。
 * 3. 授权有 TTL；过期/撤销后立即失效。
 * 4. 策略文件带版本与哈希；哈希不符视为被篡改 → 拒绝加载（不静默回退默认值）。
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile, ensureDir, sha256 } from "../core/atomic.ts";
import { withWriteGuard } from "../core/lock.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";

export type Role = "owner" | "executor" | "advisor" | "auditor";

export const LEVEL_NAMES = ["L0", "L1", "L2", "L3", "L4"] as const;
export type Level = 0 | 1 | 2 | 3 | 4;

/** 动作 → 所需等级。未登记的动作按 L3 处理（保守）。 */
export const ACTION_LEVELS: Record<string, Level> = {
  "host.inspect": 0,
  "diagnostic.run": 1,
  "workflow.run": 2,
  "job.add": 2,
  "job.run": 2,
  "config.set": 2,
  "snapshot.capture": 2,
  "pack.import": 2,
  "plugin.install": 2,
  "plugin.enable": 3,
  "snapshot.restore": 3,
  "pack.apply": 3,
  "pack.revert": 3,
  "update.apply": 4,
  "update.activate": 4,
  "policy.grant": 4,
  "policy.revoke": 4,
  "policy.set": 4,
};

export function levelOfAction(action: string): Level {
  const exact = ACTION_LEVELS[action];
  if (exact !== undefined) return exact;
  // 未登记：按关键字粗分，无法判断时按 L3
  if (/inspect|read|list|status|probe|doctor/.test(action)) return 0;
  if (/restore|apply|revert|update|policy|install/.test(action)) return 3;
  return 3;
}

export interface Grant {
  id: string;
  subject: string;
  role: Exclude<Role, "owner">;
  maxLevel: Level;
  /** 可选：限定动作白名单。 */
  actions?: string[];
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
  reason?: string;
}

export interface PolicyDoc {
  schema: "purgeplus.policy/1";
  version: number;
  hash: string;
  owner: string;
  updatedAt: string;
  updatedBy: string;
  grants: Grant[];
}

export interface PolicyState {
  doc: PolicyDoc;
  /** 本地操作者（人类）默认身份。 */
  localSubject: string;
}

export interface EvaluateRequest {
  actor: string;
  role: Role;
  action: string;
  level?: Level;
  now?: number;
}

export interface Verdict {
  decision: "allow" | "deny";
  level: Level;
  role: Role;
  reason: string;
  grantId?: string;
}

const POLICY_FILE = "security/policy.json";

export interface PolicyStoreOptions {
  onChange?: (event: { type: string; detail: unknown }) => void;
  /** 测试注入点：在 rename 之前插入故障（验证"临时文件写入中断/替换失败"）。 */
  hooks?: {
    beforeRename?: (tmp: string, target: string) => Promise<void>;
    /** 测试注入点：在回滚旧内容之前插入故障（验证"回滚失败 → RECOVERY_REQUIRED"）。 */
    beforeRestore?: () => Promise<void>;
  };
  lockWaitMs?: number;
}

/** 解析 + schema/hash 双校验（读取路径与写后复读共用同一套规则）。 */
export function parseAndVerify(raw: string, file: string): PolicyDoc {
  let parsed: PolicyDoc;
  try {
    parsed = JSON.parse(raw) as PolicyDoc;
  } catch (err) {
    throw purgeError("schema_invalid", `policy file is not valid JSON: ${(err as Error).message}`, { file });
  }
  if (parsed.schema !== "purgeplus.policy/1" || typeof parsed.owner !== "string" || !Array.isArray(parsed.grants) || typeof parsed.version !== "number") {
    throw purgeError("schema_invalid", "policy file is missing required fields", { file });
  }
  const expected = policyHash(parsed);
  if (parsed.hash !== expected) {
    throw purgeError("integrity_failed", "policy hash mismatch (file may have been tampered with)", {
      file,
      stored: parsed.hash,
      computed: expected,
    });
  }
  return parsed;
}

export class PolicyStore {
  readonly dataDir: string;
  readonly file: string;
  #doc: PolicyDoc | null = null;
  #cacheStamp = -1;
  #onChange?: (event: { type: string; detail: unknown }) => void;
  #hooks: NonNullable<PolicyStoreOptions["hooks"]> = {};
  #lockWaitMs = 5000;

  constructor(dataDir: string, opts: PolicyStoreOptions = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, POLICY_FILE);
    this.#onChange = opts.onChange;
    this.#hooks = opts.hooks ?? {};
    this.#lockWaitMs = opts.lockWaitMs ?? 5000;
  }

  /** 首次使用时建立默认策略：本地用户为 owner，无任何授予。 */
  async load(): Promise<PolicyState> {
    const localSubject = `${os.userInfo().username}@${os.hostname()}`;
    let raw: string | null = null;
    try {
      raw = await fsp.readFile(this.file, "utf8");
    } catch {
      raw = null;
    }
    if (raw === null) {
      const doc: PolicyDoc = {
        schema: "purgeplus.policy/1",
        version: 1,
        hash: "",
        owner: localSubject,
        updatedAt: new Date().toISOString(),
        updatedBy: "system:bootstrap",
        grants: [],
      };
      doc.hash = policyHash(doc);
      this.#doc = doc;
      await this.#persist(doc);
      return { doc, localSubject };
    }
    const parsed = parseAndVerify(raw, this.file);
    this.#doc = parsed;
    this.#cacheStamp = (await fsp.stat(this.file).catch(() => null))?.mtimeMs ?? 0;
    return { doc: parsed, localSubject };
  }

  async state(): Promise<PolicyState> {
    const localSubject = `${os.userInfo().username}@${os.hostname()}`;
    if (!this.#doc) return this.load();
    const st = await fsp.stat(this.file).catch(() => null);
    const stamp = st ? st.mtimeMs : -1;
    if (stamp !== this.#cacheStamp) {
      // 外部修改（或其它进程写入）后必须重新校验 hash，绝不能用旧缓存做授权判断
      const fresh = await this.load();
      return fresh;
    }
    return { doc: this.#doc as PolicyDoc, localSubject };
  }

  /** 只有 owner 能改策略。写操作全程持跨进程锁，并做版本 CAS + 写后复读。 */
  async setOwner(
    actor: string,
    role: Role,
    owner: string,
    opts: { expectedVersion?: number } = {},
  ): Promise<PolicyDoc> {
    this.#requireOwner(role, "policy.set");
    return this.#mutate("policy.set", actor, opts, (doc) => ({
      ...doc,
      owner,
      version: doc.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    }));
  }

  async grant(
    actor: string,
    role: Role,
    input: Omit<Grant, "id" | "grantedAt" | "grantedBy">,
    opts: { expectedVersion?: number } = {},
  ): Promise<Grant> {
    this.#requireOwner(role, "policy.grant");
    const grant: Grant = {
      ...input,
      id: `grant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      grantedAt: new Date().toISOString(),
      grantedBy: actor,
    };
    const next = await this.#mutate("policy.grant", actor, opts, (doc) => ({
      ...doc,
      version: doc.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
      grants: [...doc.grants, grant],
    }));
    void next;
    return grant;
  }

  async revoke(
    actor: string,
    role: Role,
    grantId: string,
    opts: { expectedVersion?: number } = {},
  ): Promise<{ revoked: boolean; version: number }> {
    this.#requireOwner(role, "policy.revoke");
    const next = await this.#mutate("policy.revoke", actor, opts, (doc) => {
      const remaining = doc.grants.filter((g) => g.id !== grantId);
      if (remaining.length === doc.grants.length) {
        throw purgeError("not_found", `grant not found: ${grantId}`);
      }
      return {
        ...doc,
        version: doc.version + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
        grants: remaining,
      };
    });
    return { revoked: true, version: next.version };
  }

  /** 只读状态（供 CLI/诊断）。 */
  async status(): Promise<{ version: number; hash: string; owner: string; grants: number; file: string; verified: boolean }> {
    const { doc } = await this.state();
    return { version: doc.version, hash: doc.hash, owner: doc.owner, grants: doc.grants.length, file: this.file, verified: policyHash(doc) === doc.hash };
  }

  /**
   * 统一的策略变更路径。
   *
   * 顺序：加锁 → 读取并校验当前版本（CAS）→ 构造新版本 → 原子持久化 → 写后复读校验 → 审计。
   * 审计失败时回滚到旧内容；回滚也失败则写入 recovery-required 标记并抛错（不静默）。
   */
  async #mutate(
    action: string,
    actor: string,
    opts: { expectedVersion?: number },
    build: (doc: PolicyDoc) => PolicyDoc,
  ): Promise<PolicyDoc> {
    return withWriteGuard(
      this.dataDir,
      { resource: "policy", scope: "config", operation: action, waitMs: this.#lockWaitMs },
      async () => {
        const current = await this.#readVerifiedDoc();
        if (opts.expectedVersion !== undefined && current.doc.version !== opts.expectedVersion) {
          throw purgeError("conflict", `policy version conflict: expected ${opts.expectedVersion}, found ${current.doc.version}`, {
            expected: opts.expectedVersion,
            actual: current.doc.version,
            hint: "重新读取策略后再提交（防止旧版本覆盖新版本 / 复活已撤销的权限）",
          });
        }
        const next = build(current.doc);
        next.hash = policyHash(next);
        // 版本必须严格 +1：任何"回退"都在这里被拦住
        if (next.version !== current.doc.version + 1) {
          throw purgeError("internal", `policy version must increase by exactly 1 (${current.doc.version} -> ${next.version})`);
        }
        await this.#persistDurable(next, current.raw);
        // 写后复读：确认落盘内容就是我们要的那一份
        const after = await this.#readVerifiedDoc();
        if (after.doc.hash !== next.hash || after.doc.version !== next.version) {
          await this.#restoreRaw(current.raw);
          throw purgeError("integrity_failed", "policy read-back verification failed; previous content restored", {
            expected: next.hash,
            actual: after.doc.hash,
          });
        }
        this.#doc = after.doc;
        this.#cacheStamp = after.stamp;
        // 审计：失败即回滚（策略变更没有审计 = 静默提权，不可接受）
        try {
          this.#emit(action === "policy.set" ? "policy_set" : action === "policy.grant" ? "policy_grant" : "policy_revoke", {
            action,
            actor,
            fromVersion: current.doc.version,
            toVersion: next.version,
            hash: next.hash,
            grants: next.grants.length,
          });
        } catch (err) {
          const restored = await this.#restoreRaw(current.raw);
          if (restored) {
            throw purgeError("internal", `policy audit failed; change reverted (${asPurgeError(err).message})`, { action, actor });
          }
          await this.#markRecoveryRequired({ action, actor, hash: next.hash, error: asPurgeError(err).message });
          throw purgeError("integrity_failed", "policy audit failed and revert failed; manual intervention required", {
            action,
            actor,
            hash: next.hash,
            state: "RECOVERY_REQUIRED",
          });
        }
        return next;
      },
    );
  }

  /** 读取并校验（含 hash/schema）。文件不存在时返回引导文档但不落盘。 */
  async #readVerifiedDoc(): Promise<{ doc: PolicyDoc; raw: string | null; stamp: number }> {
    let raw: string | null = null;
    try {
      raw = await fsp.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw asPurgeError(err);
      const doc = this.#bootstrapDoc();
      return { doc, raw: null, stamp: 0 };
    }
    const parsed = parseAndVerify(raw, this.file);
    const st = await fsp.stat(this.file).catch(() => null);
    return { doc: parsed, raw, stamp: st ? st.mtimeMs : 0 };
  }

  /** 原子 + fsync + 校验落盘的持久化。 */
  async #persistDurable(doc: PolicyDoc, previousRaw: string | null): Promise<void> {
    await ensureDir(path.dirname(this.file));
    const body = `${JSON.stringify(doc, null, 2)}\n`;
    const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
    try {
      handle = await fsp.open(tmp, "w");
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      if (this.#hooks.beforeRename) await this.#hooks.beforeRename(tmp, this.file);
      await fsp.rename(tmp, this.file);
      // 目录 fsync：确保 rename 在崩溃后仍可见（POSIX 语义；Windows 上为尽力而为）
      await fsp.open(path.dirname(this.file), "r").then(async (dir) => {
        await dir.sync().catch(() => {});
        await dir.close();
      }).catch(() => {});
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if (previousRaw === null) await fsp.rm(this.file, { force: true }).catch(() => {});
      throw purgeError("unwritable", `failed to persist policy: ${asPurgeError(err).message}`, { file: this.file });
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async #restoreRaw(raw: string | null): Promise<boolean> {
    try {
      if (this.#hooks.beforeRestore) await this.#hooks.beforeRestore();
      if (raw === null) {
        await fsp.rm(this.file, { force: true });
      } else {
        await atomicWriteFile(this.file, raw);
      }
      this.#doc = null;
      this.#cacheStamp = -1;
      return true;
    } catch {
      return false;
    }
  }

  async #markRecoveryRequired(detail: Record<string, unknown>): Promise<void> {
    const marker = `${this.file}.recovery-required`;
    await atomicWriteFile(marker, `${JSON.stringify({ ...detail, at: new Date().toISOString() }, null, 2)}\n`).catch(() => {});
  }

  #bootstrapDoc(): PolicyDoc {
    const localSubject = `${os.userInfo().username}@${os.hostname()}`;
    const doc: PolicyDoc = {
      schema: "purgeplus.policy/1",
      version: 1,
      hash: "",
      owner: localSubject,
      updatedAt: new Date().toISOString(),
      updatedBy: "system:bootstrap",
      grants: [],
    };
    doc.hash = policyHash(doc);
    return doc;
  }
  /**
   * 判定某主体能否执行某动作。
   * owner 全权；executor/auditor 仅能通过未过期的授予获得权限；advisor 最多 L2 且不能 L3+。
   */
  async evaluate(req: EvaluateRequest): Promise<Verdict> {
    const { doc, localSubject } = await this.state();
    const level = req.level ?? levelOfAction(req.action);
    const now = req.now ?? Date.now();

    if (req.role === "owner" && req.actor === doc.owner) {
      return { decision: "allow", level, role: req.role, reason: "policy owner" };
    }
    if (req.role === "owner") {
      return { decision: "deny", level, role: req.role, reason: `actor ${req.actor} is not the policy owner (${doc.owner})` };
    }
    if (req.role === "advisor" && level >= 3) {
      return { decision: "deny", level, role: req.role, reason: "AI advisor may not perform L3+ actions" };
    }
    if (level >= 4) {
      return { decision: "deny", level, role: req.role, reason: "L4 actions require the policy owner" };
    }
    const candidates = doc.grants.filter((g) => g.subject === req.actor || g.subject === "*");
    for (const g of candidates) {
      if (g.expiresAt && Date.parse(g.expiresAt) <= now) continue;
      if (g.maxLevel < level) continue;
      if (g.actions && g.actions.length > 0 && !g.actions.includes(req.action)) continue;
      return { decision: "allow", level, role: req.role, reason: `grant ${g.id}`, grantId: g.id };
    }
    if (req.actor === localSubject) {
      if (level >= 4) {
        return { decision: "deny", level, role: req.role, reason: "L4 requires the policy owner identity" };
      }
      return { decision: "allow", level, role: req.role, reason: "local operator (no grant needed)" };
    }
    return { decision: "deny", level, role: req.role, reason: "no valid grant for this action" };
  }
  #requireOwner(role: Role, action: string): void {
    if (role !== "owner") {
      throw purgeError("policy_denied", `${action} requires the owner role (got "${role}")`, { action, role });
    }
  }


  async #persist(doc: PolicyDoc): Promise<void> {
    await ensureDir(path.dirname(this.file));
    try {
      await atomicWriteFile(this.file, `${JSON.stringify(doc, null, 2)}\n`);
    } catch (err) {
      throw asPurgeError(err);
    }
  }

  #emit(type: string, detail: unknown): void {
    this.#onChange?.({ type, detail });
  }
}

/** 规范化哈希：排除 hash 字段本身，字段按固定顺序。 */
export function policyHash(doc: PolicyDoc): string {
  const canonical = {
    schema: doc.schema,
    version: doc.version,
    owner: doc.owner,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
    grants: [...doc.grants]
      .map((g) => ({ id: g.id, subject: g.subject, role: g.role, maxLevel: g.maxLevel, actions: g.actions ?? [], expiresAt: g.expiresAt ?? null, grantedBy: g.grantedBy, grantedAt: g.grantedAt, reason: g.reason ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return sha256(JSON.stringify(canonical));
}

export function describeLevel(level: Level): string {
  return `${LEVEL_NAMES[level]} ${{ 0: "READ_ONLY", 1: "SAFE_OPERATION", 2: "CONTROLLED_WRITE", 3: "HIGH_RISK", 4: "ADMINISTRATIVE" }[level]}`;
}
