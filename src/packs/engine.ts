/**
 * Pack 引擎：plan（只读）→ apply（事务）→ revert（快照恢复）。
 *
 * 与上一个世代的关键差别：
 * - **plan 不改磁盘**，输出逐规则状态 + 实际 diff 片段，先给人看。
 * - **apply 走事务**：快照 → 写 → 回读校验 → 提交；任一步失败整体回滚。
 * - **revert 用快照恢复**，不做「反向替换」（反向替换在正则有捕获组时不可逆）。
 * - 风险等级不在这里判定：apply 必须由上层带着策略结论调用。
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "../core/atomic.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";
import type { Transaction } from "../recovery/transaction.ts";
import type { SnapshotStore } from "../recovery/snapshot.ts";
import { applyRuleToText, describeEvaluation, evaluateRule, type RuleFileStatus } from "./matcher.ts";
import { validatePack, type Pack, type PackRule } from "./schema.ts";

export interface RulePlanEntry {
  ruleId: string;
  path: string;
  status: RuleFileStatus;
  detail: string;
  /** 变更预览（前 400 字符）。 */
  preview?: string;
}

export interface PackPlan {
  packId: string;
  packVersion: string;
  baseRoot: string;
  hostVersion: string;
  supported: boolean;
  entries: RulePlanEntry[];
  summary: Record<RuleFileStatus, number>;
  /** 是否有任何规则会被写入。 */
  changes: boolean;
}

export interface PackApplyResult {
  plan: PackPlan;
  txId: string;
  snapshotId: string;
  written: string[];
}

export interface PackEngineOptions {
  snapshots: SnapshotStore;
  /** 事务工厂：由组合根注入，便于统一审计与测试。 */
  createTransaction: (label: string, targets: string[]) => Promise<Transaction>;
}

export class PackEngine {
  readonly #o: PackEngineOptions;

  constructor(opts: PackEngineOptions) {
    this.#o = opts;
  }

  /** 只读规划：不写任何字节。 */
  async plan(pack: Pack, opts: { baseRoot: string; hostVersion: string }): Promise<PackPlan> {
    validatePack(pack);
    const baseRoot = path.resolve(opts.baseRoot);
    const entries: RulePlanEntry[] = [];
    const summary: Record<RuleFileStatus, number> = {
      applied: 0,
      pending: 0,
      drifted: 0,
      missing: 0,
      hit_mismatch: 0,
      conflict: 0,
    };
    for (const rule of pack.rules) {
      const file = safeJoin(baseRoot, rule.path);
      let text: string;
      try {
        text = await fsp.readFile(file, "utf8");
      } catch {
        const status: RuleFileStatus = rule.optional ? "missing" : "missing";
        entries.push({ ruleId: rule.id, path: file, status, detail: rule.optional ? "目标不存在（声明为可缺省）" : "目标文件不存在" });
        if (!rule.optional) summary.missing += 1;
        continue;
      }
      const evaluation = evaluateRule(text, rule);
      summary[evaluation.status] += 1;
      const entry: RulePlanEntry = {
        ruleId: rule.id,
        path: file,
        status: evaluation.status,
        detail: evaluation.note ?? describeEvaluation(evaluation),
      };
      if (evaluation.status === "pending") {
        try {
          const applied = applyRuleToText(text, rule);
          entry.preview = firstDiff(text, applied.text);
        } catch (err) {
          entry.status = "conflict";
          entry.detail = asPurgeError(err).message;
          summary.pending -= 1;
          summary.conflict += 1;
        }
      }
      entries.push(entry);
    }
    return {
      packId: pack.id,
      packVersion: pack.version,
      baseRoot,
      hostVersion: opts.hostVersion,
      supported: true,
      entries,
      summary,
      changes: summary.pending > 0,
    };
  }

  /**
   * 应用：对 plan 中 pending 的规则在单个事务内写入。
   * 事务内容 = {文件内容}；校验失败/写入失败 → 整体回滚。
   */
  async apply(pack: Pack, opts: { baseRoot: string; hostVersion: string }): Promise<PackApplyResult> {
    const plan = await this.plan(pack, opts);
    const pending = plan.entries.filter((e) => e.status === "pending");
    if (pending.length === 0) {
      throw purgeError("conflict", "pack has no pending rules to apply", { summary: plan.summary });
    }
    const files = [...new Set(pending.map((e) => e.path))];
    const tx = await this.#o.createTransaction(`pack:${pack.id}@${pack.version}`, files);
    const written: string[] = [];
    try {
      for (const file of files) {
        const original = await fsp.readFile(file, "utf8");
        let text = original;
        for (const rule of rulesForPath(pack.rules, plan.baseRoot, file)) {
          if (!pending.some((p) => p.ruleId === rule.id)) continue;
          text = applyRuleToText(text, rule).text;
        }
        if (text !== original) {
          await tx.write(file, text);
          written.push(file);
        }
      }
      const verdict = await tx.verify();
      if (!verdict.ok) {
        await tx.rollback();
        throw purgeError("integrity_failed", "post-write verification failed; rolled back", { problems: verdict.problems });
      }
      tx.commit();
      const result = tx.result();
      // 二次确认：提交后重新 plan，pending 必须归零
      const after = await this.plan(pack, opts);
      if (after.summary.pending > 0) {
        throw purgeError("integrity_failed", "pack still reports pending rules after apply", { summary: after.summary });
      }
      return { plan, txId: result.txId, snapshotId: result.snapshotId, written };
    } catch (err) {
      if (tx.state === "open" || tx.state === "verified") await tx.rollback().catch(() => {});
      throw err;
    }
  }

  /** 用快照恢复（推荐的回退路径）。 */
  async revert(snapshotId: string): Promise<{ restored: string[]; removed: string[]; failed: Array<{ path: string; error: string }> }> {
    return this.#o.snapshots.restore(snapshotId);
  }
}

function rulesForPath(rules: PackRule[], baseRoot: string, absPath: string): PackRule[] {
  const target = path.resolve(absPath);
  return rules.filter((r) => safeJoin(baseRoot, r.path) === target);
}

function normalizeRel(rel: string): string {
  return rel.split("/").filter(Boolean).join(path.sep);
}

function safeJoin(baseRoot: string, rel: string): string {
  const resolved = path.resolve(baseRoot, normalizeRel(rel));
  const normalizedBase = path.resolve(baseRoot);
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + path.sep)) {
    throw purgeError("policy_denied", `pack path escapes base root: ${rel}`, { baseRoot, rel });
  }
  return resolved;
}

/** 生成一段只保留变化行的预览。 */
function firstDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && out.length < 12; i += 1) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) out.push(`- ${a[i]}`);
      if (b[i] !== undefined) out.push(`+ ${b[i]}`);
    }
  }
  return out.join("\n").slice(0, 2000);
}

export function packDigest(pack: Pack): string {
  return createHash("sha256").update(JSON.stringify(pack)).digest("hex");
}

/** 用于 UI/CLI：把 plan 变成人可读文本。 */
export function formatPlan(plan: PackPlan): string {
  const lines = [
    `包 ${plan.packId}@${plan.packVersion} → ${plan.baseRoot}（宿主 ${plan.hostVersion}）`,
    `状态：待应用 ${plan.summary.pending} · 已应用 ${plan.summary.applied} · 漂移 ${plan.summary.drifted} · 缺失 ${plan.summary.missing} · 命中不符 ${plan.summary.hit_mismatch}`,
  ];
  for (const e of plan.entries) {
    lines.push(`  [${e.status}] ${e.ruleId} → ${e.path}`);
    if (e.detail) lines.push(`      ${e.detail}`);
  }
  return lines.join("\n");
}

export { atomicWriteFile };
