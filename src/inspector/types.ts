/**
 * 诊断类型与状态词表。
 * 词表直接继承原项目并收敛：unknown 永远是黄，不允许被当成绿。
 */
import type { HostFacts } from "../adapters/types.ts";

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type FindingStatus = "pass" | "warn" | "fail" | "unknown" | "not_applicable";
export type Level = "ok" | "warn" | "unknown" | "broken";

export interface EvidenceRef {
  kind: "file" | "archive" | "process" | "env" | "dir" | "db" | "probe";
  source: string;
  note?: string;
  hash?: string;
}

export interface Finding {
  id: string;
  ruleId: string;
  title: string;
  severity: Severity;
  status: FindingStatus;
  /** 根因假设：明确标注是「已验证事实」还是「推断」。 */
  rootCause?: { confidence: "verified" | "inferred"; text: string };
  evidence: EvidenceRef[];
  remediation?: { summary: string; steps: string[]; risk?: number };
  tags?: string[];
}

export interface RuleContext {
  facts: HostFacts;
  now?: number;
}

export interface Rule {
  id: string;
  title: string;
  category: "identity" | "layout" | "process" | "profile" | "modification" | "runtime" | "integrity";
  /** 纯函数：只读 facts，不做 IO。 */
  evaluate(ctx: RuleContext): Finding | null;
}

export interface DiagnosticReport {
  reportId: string;
  hostId: string;
  hostLabel: string;
  level: Level;
  host: {
    product: string;
    version: string;
    confidence: string;
    shape: HostFacts["shape"];
    loadedShape: HostFacts["loadedShape"];
    running: boolean | null;
  };
  findings: Finding[];
  summary: { total: number; pass: number; warn: number; fail: number; unknown: number; notApplicable: number };
  generatedAt: string;
  durationMs: number;
}

export function levelFromFindings(findings: Finding[]): Level {
  if (findings.some((f) => f.status === "fail" && f.severity !== "info" && f.severity !== "low")) return "broken";
  if (findings.some((f) => f.status === "unknown")) return "unknown";
  if (findings.some((f) => f.status === "warn")) return "warn";
  return "ok";
}
