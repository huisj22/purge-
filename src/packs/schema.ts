/**
 * 修改包（Modification Pack）的 schema、校验与内容哈希。
 *
 * 关键设计（相对原项目）：
 * - pack 是**数据**，不是插件里的常量数组；引擎不认识任何具体宿主。
 * - 每条规则必须声明 markers，且替换文本必须包含 marker：
 *   否则无法区分「已应用」与「宿主本来就这样」，也没有可追溯痕迹。
 * - 规则路径一律相对宿主基目录（baseRoot），并做路径边界校验。
 */
import { sha256 } from "../core/atomic.ts";
import { purgeError } from "../core/errors.ts";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface Replacement {
  /** 字面量或 /regex/flags 形式。 */
  pattern: string;
  replace: string;
  /** 期望命中次数；缺省为 1（多命中即拒写）。 */
  expect?: number;
}

export interface PackRule {
  id: string;
  layer: "prompt" | "code" | "tool" | "compat";
  /** 相对宿主基目录的路径（POSIX 分隔符）。 */
  path: string;
  replacements: Replacement[];
  markers: string[];
  /** 目标文件不存在时视为不适用而不是故障。 */
  optional?: boolean;
  description?: string;
}

export interface PackTarget {
  /** 适配器 id，例如 dsh。 */
  adapter: string;
  /** 宿主版本范围（简单 semver 前缀匹配，如 "0.2.2-rc.5" 或 "0.2.x"）。 */
  versions?: string[];
}

export interface PackRisk {
  level: RiskLevel;
  reasons: string[];
}

export interface Pack {
  schema: "purgeplus.pack/1";
  id: string;
  name: string;
  version: string;
  author?: string;
  license?: string;
  source?: string;
  target: PackTarget;
  risk: PackRisk;
  rules: PackRule[];
}

const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high", "critical"];
const LAYERS: PackRule["layer"][] = ["prompt", "code", "tool", "compat"];

export function validatePack(input: unknown): Pack {
  const p = input as Partial<Pack>;
  const problems: string[] = [];
  if (p.schema !== "purgeplus.pack/1") problems.push(`schema must be "purgeplus.pack/1"`);
  if (!p.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(p.id)) problems.push("id must match [a-z0-9._-]");
  if (!p.name) problems.push("name is required");
  if (!p.version) problems.push("version is required");
  if (!p.target || typeof p.target.adapter !== "string") problems.push("target.adapter is required");
  if (!p.risk || !RISK_LEVELS.includes(p.risk.level)) problems.push(`risk.level must be one of ${RISK_LEVELS.join("|")}`);
  if (p.risk && !Array.isArray(p.risk.reasons)) problems.push("risk.reasons must be an array");
  if (!Array.isArray(p.rules) || p.rules.length === 0) problems.push("rules must be a non-empty array");
  const seen = new Set<string>();
  for (const [i, rule] of (p.rules ?? []).entries()) {
    const at = `rules[${i}]`;
    if (!rule.id) problems.push(`${at}.id is required`);
    else if (seen.has(rule.id)) problems.push(`${at}.id duplicated: ${rule.id}`);
    else seen.add(rule.id);
    if (!LAYERS.includes(rule.layer)) problems.push(`${at}.layer must be one of ${LAYERS.join("|")}`);
    if (!rule.path || rule.path.includes("..") || rule.path.startsWith("/")) {
      problems.push(`${at}.path must be a relative path inside the host`);
    }
    if (!Array.isArray(rule.replacements) || rule.replacements.length === 0) problems.push(`${at}.replacements is required`);
    if (!Array.isArray(rule.markers) || rule.markers.length === 0) {
      problems.push(`${at}.markers is required（否则无法证明已应用）`);
      continue;
    }
    const joined = (rule.replacements ?? []).map((r) => r.replace ?? "").join("\n");
    if (!rule.markers.some((m) => m.length > 0 && joined.includes(m))) {
      problems.push(`${at} 的 replace 文本必须包含至少一个 marker，用于可追溯`);
    }
    for (const [j, rep] of (rule.replacements ?? []).entries()) {
      if (!rep.pattern) problems.push(`${at}.replacements[${j}].pattern is required`);
      if (typeof rep.replace !== "string") problems.push(`${at}.replacements[${j}].replace must be a string`);
      if (rep.expect !== undefined && (!Number.isInteger(rep.expect) || rep.expect < 1)) {
        problems.push(`${at}.replacements[${j}].expect must be a positive integer`);
      }
    }
  }
  if (problems.length > 0) {
    throw purgeError("schema_invalid", `pack validation failed: ${problems.slice(0, 3).join("; ")}`, { problems });
  }
  return p as Pack;
}

/** 包内容哈希：用于来源追溯与「同一个包」判定。 */
export function packHash(pack: Pack): string {
  const canonical = {
    schema: pack.schema,
    id: pack.id,
    version: pack.version,
    target: pack.target,
    risk: pack.risk,
    rules: pack.rules.map((r) => ({
      id: r.id,
      layer: r.layer,
      path: r.path,
      markers: r.markers,
      optional: Boolean(r.optional),
      replacements: r.replacements,
    })),
  };
  return sha256(JSON.stringify(canonical));
}

/** 宿主版本是否落在包声明的范围内。空数组=不限制。 */
export function packSupportsVersion(pack: Pack, version: string): boolean {
  const range = pack.target.versions;
  if (!range || range.length === 0) return true;
  return range.some((pattern) => {
    if (pattern.endsWith(".x")) return version.startsWith(pattern.slice(0, -1));
    return version === pattern || version.startsWith(`${pattern}.`);
  });
}
