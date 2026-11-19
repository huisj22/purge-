/**
 * 匹配引擎：字面量/正则替换 + 命中数契约 + marker 判定。
 *
 * 与原项目一致的三条硬规则：
 * 1. expect 默认 1：多命中或零命中都整条拒写（防「宿主复制了相似代码段被连带改错」）。
 * 2. 有 marker = 已应用，不再重复写（幂等）。
 * 3. 文件存在但没有 marker、也没有命中 → drifted（异常），不是 skipped。
 */
import { purgeError } from "../core/errors.ts";
import type { PackRule, Replacement } from "./schema.ts";

export type RuleFileStatus = "applied" | "pending" | "drifted" | "missing" | "hit_mismatch" | "conflict";

export interface RuleEvaluation {
  status: RuleFileStatus;
  /** 每个 replacement 的实际命中数，便于诊断。 */
  hits: number[];
  note?: string;
}

export function parsePattern(pattern: string): RegExp | string {
  if (pattern.length >= 2 && pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const last = pattern.lastIndexOf("/");
    const body = pattern.slice(1, last);
    const flags = pattern.slice(last + 1);
    if (/^[gimsuy]*$/.test(flags)) return new RegExp(body, flags.includes("g") ? flags : `${flags}g`);
  }
  return pattern;
}

export function countHits(text: string, pattern: string): number {
  const parsed = parsePattern(pattern);
  if (typeof parsed === "string") {
    if (parsed.length === 0) return 0;
    return text.split(parsed).length - 1;
  }
  const matches = text.match(parsed);
  return matches ? matches.length : 0;
}

export function hasMarker(text: string, markers: string[]): boolean {
  return markers.some((m) => m.length > 0 && text.includes(m));
}

export function evaluateRule(text: string, rule: PackRule): RuleEvaluation {
  const hits = rule.replacements.map((r) => countHits(text, r.pattern));
  if (hasMarker(text, rule.markers)) return { status: "applied", hits };
  const expected = rule.replacements.map((r) => r.expect ?? 1);
  const mismatch = hits.findIndex((h, i) => h !== expected[i]);
  if (mismatch >= 0) {
    return {
      status: hits.every((h) => h === 0) ? "drifted" : "hit_mismatch",
      hits,
      note: `replacement[${mismatch}] 命中 ${hits[mismatch]}，期望 ${expected[mismatch]}`,
    };
  }
  return { status: "pending", hits };
}

export interface ApplyOutcome {
  text: string;
  changed: boolean;
  hits: number[];
}

/** 应用一条规则到文本；任何一条不满足命中数契约就整体拒写。 */
export function applyRuleToText(text: string, rule: PackRule): ApplyOutcome {
  let out = text;
  const hits: number[] = [];
  for (const [i, rep] of rule.replacements.entries()) {
    const expected = rep.expect ?? 1;
    const actual = countHits(out, rep.pattern);
    hits.push(actual);
    if (actual !== expected) {
      throw purgeError("integrity_failed", `rule ${rule.id} replacement[${i}] hit ${actual}, expected ${expected}`, {
        rule: rule.id,
        index: i,
        expected,
        actual,
      });
    }
    if (actual === 0) continue;
    out = replaceAll(out, rep);
  }
  if (!hasMarker(out, rule.markers)) {
    throw purgeError("integrity_failed", `rule ${rule.id} produced text without any marker`, { markers: rule.markers });
  }
  return { text: out, changed: out !== text, hits };
}

function replaceAll(text: string, rep: Replacement): string {
  const parsed = parsePattern(rep.pattern);
  if (typeof parsed === "string") return text.split(parsed).join(rep.replace);
  return text.replace(parsed, rep.replace);
}

/** 判断规则是否落在某个宿主版本上。 */
export function describeEvaluation(evaluation: RuleEvaluation): string {
  const map: Record<RuleFileStatus, string> = {
    applied: "已应用",
    pending: "待应用",
    drifted: "锚点漂移",
    missing: "目标缺失",
    hit_mismatch: "命中数不符",
    conflict: "冲突",
  };
  return map[evaluation.status];
}
