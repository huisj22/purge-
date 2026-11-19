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

export class PolicyStore {
  readonly dataDir: string;
  readonly file: string;
  #doc: PolicyDoc | null = null;
  #onChange?: (event: { type: string; detail: unknown }) => void;

  constructor(dataDir: string, opts: { onChange?: (event: { type: string; detail: unknown }) => void } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, POLICY_FILE);
    this.#onChange = opts.onChange;
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
    let parsed: PolicyDoc;
    try {
      parsed = JSON.parse(raw) as PolicyDoc;
    } catch (err) {
      throw purgeError("schema_invalid", `policy file is not valid JSON: ${(err as Error).message}`, { file: this.file });
    }
    if (parsed.schema !== "purgeplus.policy/1" || typeof parsed.owner !== "string" || !Array.isArray(parsed.grants)) {
      throw purgeError("schema_invalid", "policy file is missing required fields", { file: this.file });
    }
    const expected = policyHash(parsed);
    if (parsed.hash !== expected) {
      throw purgeError("integrity_failed", "policy hash mismatch (file may have been tampered with)", {
        file: this.file,
        stored: parsed.hash,
        computed: expected,
      });
    }
    this.#doc = parsed;
    return { doc: parsed, localSubject };
  }

  async state(): Promise<PolicyState> {
    if (!this.#doc) return this.load();
    return { doc: this.#doc as PolicyDoc, localSubject: `${os.userInfo().username}@${os.hostname()}` };
  }

  /** 只有 owner 能改策略。 */
  async setOwner(actor: string, role: Role, owner: string): Promise<PolicyDoc> {
    this.#requireOwner(role, "policy.set");
    const doc = await this.#mutableDoc();
    const next: PolicyDoc = { ...doc, owner, version: doc.version + 1, updatedAt: new Date().toISOString(), updatedBy: actor };
    next.hash = policyHash(next);
    this.#doc = next;
    await this.#persist(next);
    this.#emit("policy_set", { actor, owner, version: next.version });
    return next;
  }

  async grant(actor: string, role: Role, input: Omit<Grant, "id" | "grantedAt" | "grantedBy">): Promise<Grant> {
    this.#requireOwner(role, "policy.grant");
    const doc = await this.#mutableDoc();
    const grant: Grant = {
      ...input,
      id: `grant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      grantedAt: new Date().toISOString(),
      grantedBy: actor,
    };
    const next: PolicyDoc = {
      ...doc,
      version: doc.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
      grants: [...doc.grants, grant],
    };
    next.hash = policyHash(next);
    this.#doc = next;
    await this.#persist(next);
    this.#emit("policy_grant", { actor, grant });
    return grant;
  }

  async revoke(actor: string, role: Role, grantId: string): Promise<{ revoked: boolean; version: number }> {
    this.#requireOwner(role, "policy.revoke");
    const doc = await this.#mutableDoc();
    const remaining = doc.grants.filter((g) => g.id !== grantId);
    if (remaining.length === doc.grants.length) {
      throw purgeError("not_found", `grant not found: ${grantId}`);
    }
    const next: PolicyDoc = {
      ...doc,
      version: doc.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
      grants: remaining,
    };
    next.hash = policyHash(next);
    this.#doc = next;
    await this.#persist(next);
    this.#emit("policy_revoke", { actor, grantId, version: next.version });
    return { revoked: true, version: next.version };
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
      // 自称 owner 但不是策略里的 owner → 拒绝（防止执行主体自封）
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
    // 本地 owner 账号默认拥有权限（本机单用户模型），但仍要显式记录
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

  async #mutableDoc(): Promise<PolicyDoc> {
    if (!this.#doc) await this.load();
    return this.#doc as PolicyDoc;
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
