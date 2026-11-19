/**
 * 安全治理：确定性风险评分与策略判定。
 *
 * 设计底线（MASTER PROMPT §07）：
 * - 判定发生在代码里，不在提示词里；AI 建议只能提出 ActionRequest，必须再过 evaluate()。
 * - AI 来源的请求风险只会更高，不会更低。
 * - 拒绝原因必须可解释（逐条因子 + 权重）。
 */
import { purgeError } from "../core/errors.ts";

export type Decision = "allow" | "confirm" | "deny";
export type Origin = "human" | "ai" | "plugin" | "scheduler";

export interface ActionRequest {
  /** 动作标识，例如 host.patch.apply / config.set / plugin.install / shell.run */
  action: string;
  target?: string;
  /** 将被写入/删除的路径。 */
  paths?: string[];
  /** 是否递归删除。 */
  recursive?: boolean;
  /** 是否执行外部命令。 */
  command?: string;
  /** 是否发起出站网络请求。 */
  network?: boolean;
  /** 是否触碰凭据/密钥类路径。 */
  sensitive?: boolean;
  origin?: Origin;
}

export interface RiskFactor {
  code: string;
  weight: number;
  note: string;
}

export interface PolicyVerdict {
  decision: Decision;
  risk: number;
  factors: RiskFactor[];
  /** deny 或 confirm 时给出人类可读的下一步。 */
  hint?: string;
}

export interface PolicyConfig {
  confirmThreshold: number;
  denyThreshold: number;
  allowActions: string[];
}

const SENSITIVE_PATH = /(\.ssh|\.aws|\.gnupg|credentials|\.npmrc|id_rsa|id_ed25519|\.env(\.|$)|secrets?\.(json|ya?ml|toml))/i;

export const DEFAULT_POLICY: PolicyConfig = { confirmThreshold: 30, denyThreshold: 70, allowActions: [] };

export function evaluatePolicy(req: ActionRequest, cfg: PolicyConfig = DEFAULT_POLICY): PolicyVerdict {
  const factors: RiskFactor[] = [];
  const paths = req.paths ?? [];

  const writeish = ["write", "set", "apply", "install", "patch", "restore", "revert", "revert", "remove", "delete"].some((k) =>
    req.action.includes(k),
  );
  if (writeish) factors.push({ code: "mutating_action", weight: 40, note: `动作 ${req.action} 会改变磁盘状态` });
  if (paths.length > 20) factors.push({ code: "wide_scope", weight: 20, note: `影响 ${paths.length} 个路径` });
  else if (paths.length > 5) factors.push({ code: "multi_scope", weight: 10, note: `影响 ${paths.length} 个路径` });
  if (req.recursive) factors.push({ code: "recursive", weight: 50, note: "递归删除/改写" });
  if (req.command) factors.push({ code: "external_command", weight: 30, note: `执行外部命令：${truncate(req.command)}` });
  if (req.network) factors.push({ code: "network_egress", weight: 10, note: "发起出站网络请求" });
  if (req.sensitive === true || paths.some((p) => SENSITIVE_PATH.test(p))) {
    factors.push({ code: "sensitive_path", weight: 40, note: "涉及凭据/密钥路径" });
  }
  if (req.origin === "ai") factors.push({ code: "ai_origin", weight: 10, note: "请求由 AI 提出，需确定性策略复核" });
  if (req.origin === "plugin") factors.push({ code: "plugin_origin", weight: 20, note: "请求来自第三方插件" });
  if (req.origin === "scheduler") factors.push({ code: "unattended", weight: 10, note: "无人值守触发" });

  // 同一 code 只计一次（防止同一请求重复累加）
  const uniq = new Map<string, RiskFactor>();
  for (const f of factors) if (!uniq.has(f.code)) uniq.set(f.code, f);
  const list = [...uniq.values()].sort((a, b) => b.weight - a.weight);
  const raw = list.reduce((n, f) => n + f.weight, 0);
  const risk = Math.max(0, Math.min(100, raw));

  const explicitlyAllowed = cfg.allowActions.includes(req.action);
  if (explicitlyAllowed) {
    return {
      decision: "allow",
      risk,
      factors: [...list, { code: "allowlisted", weight: 0, note: `动作 ${req.action} 在 allowActions 中` }],
      hint: "该动作被显式放行，但仍会写入审计链",
    };
  }
  if (risk >= cfg.denyThreshold) {
    return { decision: "deny", risk, factors: list, hint: `风险 ${risk} ≥ 拒绝阈值 ${cfg.denyThreshold}` };
  }
  if (risk >= cfg.confirmThreshold) {
    return { decision: "confirm", risk, factors: list, hint: `风险 ${risk} ≥ 确认阈值 ${cfg.confirmThreshold}，需要显式确认` };
  }
  return { decision: "allow", risk, factors: list };
}

export interface GuardOptions {
  confirmed?: boolean;
  /** 无论风险如何都要求确认（用于 apply/restore 这类动作）。 */
  forceConfirm?: boolean;
}

/** 在真正执行前调用；返回 verdict 或抛出 policy_denied / confirmation_required。 */
export function guard(req: ActionRequest, cfg: PolicyConfig = DEFAULT_POLICY, opts: GuardOptions = {}): PolicyVerdict {
  const verdict = evaluatePolicy(req, cfg);
  if (verdict.decision === "deny") {
    throw purgeError("policy_denied", `policy denied ${req.action}: ${verdict.hint ?? "risk too high"}`, {
      risk: verdict.risk,
      factors: verdict.factors,
    });
  }
  const needConfirm = verdict.decision === "confirm" || opts.forceConfirm === true;
  if (needConfirm && opts.confirmed !== true) {
    throw purgeError("confirmation_required", `confirmation required for ${req.action}`, {
      risk: verdict.risk,
      factors: verdict.factors,
      hint: verdict.hint,
    });
  }
  return verdict;
}

function truncate(s: string, n = 80): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
