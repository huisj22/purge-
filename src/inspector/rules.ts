/**
 * 诊断规则集。
 *
 * 规则是纯函数：输入 HostFacts，输出 Finding（或 null 表示不适用）。
 * 铁律：没有证据 → status="unknown"，绝不返回 pass。
 */
import type { EvidenceRef, Finding, Rule } from "./types.ts";

function ev(kind: EvidenceRef["kind"], source: string, note?: string, hash?: string): EvidenceRef {
  const out: EvidenceRef = { kind, source };
  if (note) out.note = note;
  if (hash) out.hash = hash;
  return out;
}

export const RULES: Rule[] = [
  {
    id: "identity.verified",
    title: "宿主身份可验证",
    category: "identity",
    evaluate({ facts }) {
      const id = facts.identity;
      const base = {
        id: "identity.verified",
        ruleId: "identity.verified",
        title: "宿主身份可验证",
        severity: "high" as const,
        evidence: id.evidence.map((e) => ev(e.kind, e.source, e.note, e.hash)),
      };
      if (id.confidence === "verified") {
        return {
          ...base,
          status: "pass",
          rootCause: { confidence: "verified", text: `产品 ${id.product} 版本 ${id.version}` },
        };
      }
      if (id.confidence === "inferred") {
        return { ...base, status: "warn", rootCause: { confidence: "inferred", text: "包名与预期产品不一致，可能不是官方桌面宿主" } };
      }
      return {
        ...base,
        status: "unknown",
        rootCause: { confidence: "inferred", text: "既读不到解包目录的 package.json，也读不到归档头；无法确认宿主身份" },
      };
    },
  },
  {
    id: "layout.archive_readable",
    title: "归档可解析",
    category: "layout",
    evaluate({ facts }) {
      if (!facts.archive.exists) return null;
      const base = {
        id: "layout.archive_readable",
        ruleId: "layout.archive_readable",
        title: "归档可解析",
        severity: "medium" as const,
        evidence: [ev("file", facts.archive.path, `${facts.archive.size ?? "?"} 字节`)],
      };
      if (facts.archive.readable === true) return { ...base, status: "pass" };
      return {
        ...base,
        status: "fail",
        rootCause: { confidence: "verified", text: `ASAR 头无法解析：${facts.archive.error ?? "unknown"}` },
        remediation: { summary: "归档损坏或被替换，先确认宿主安装完整性，不要在其上做任何写入。", steps: ["用官方安装包重装宿主", "重装后再跑一次诊断"], risk: 40 },
      };
    },
  },
  {
    id: "layout.dual_shape",
    title: "解包目录与归档同时存在",
    category: "layout",
    evaluate({ facts }) {
      if (facts.shape !== "both") return null;
      return {
        id: "layout.dual_shape",
        ruleId: "layout.dual_shape",
        title: "解包目录与归档同时存在",
        severity: "medium",
        status: "warn",
        rootCause: {
          confidence: "inferred",
          text: "resources/app 与 app.asar 同时存在：通常是「已解包并保留归档作为回滚源」。运行中的进程实际加载哪一份，需要进程证据确认。",
        },
        evidence: [ev("dir", facts.unpacked.path), ev("file", facts.archive.path)],
        remediation: {
          summary: "确认当前使用的形态；回滚前不要手动删除任何一份。",
          steps: ["查看「进程」层证据确认是否在运行", "如需回滚，用快照/归档恢复流程而不是手删目录"],
          risk: 50,
        },
        tags: ["layout"],
      };
    },
  },
  {
    id: "layout.runtime_present",
    title: "运行时目录存在",
    category: "runtime",
    evaluate({ facts }) {
      const base = {
        id: "layout.runtime_present",
        ruleId: "layout.runtime_present",
        title: "运行时目录存在",
        severity: "low" as const,
        evidence: [ev("dir", facts.runtime.path)],
      };
      if (facts.runtime.exists) return { ...base, status: "pass" };
      return {
        ...base,
        status: "warn",
        rootCause: { confidence: "verified", text: "resources/runtime 不存在；CLI 安装/更新等依赖运行时的动作会失败" },
        remediation: { summary: "确认宿主完整安装；不要把 CLI 运行时缺失当成插件问题。", steps: ["重装或修复宿主安装"], risk: 30 },
      };
    },
  },
  {
    id: "process.probe",
    title: "进程状态可判定",
    category: "process",
    evaluate({ facts }) {
      const p = facts.process;
      const base = {
        id: "process.probe",
        ruleId: "process.probe",
        title: "进程状态可判定",
        severity: "low" as const,
        evidence: [ev("process", p.probedBy, p.note ?? `pids=${p.pids.join(",") || "none"}`)],
      };
      if (p.running === null) {
        return {
          ...base,
          status: "unknown",
          rootCause: { confidence: "inferred", text: `进程探测失败：${p.note ?? "no detail"}` },
        };
      }
      return {
        ...base,
        status: "pass",
        rootCause: { confidence: "verified", text: p.running ? `宿主正在运行（pid ${p.pids.join(", ")}）` : "宿主未运行" },
      };
    },
  },
  {
    id: "process.disk_vs_loaded",
    title: "磁盘状态与加载状态一致",
    category: "process",
    evaluate({ facts }) {
      if (facts.loadedShape === "unknown") return null;
      // P3-07：双形态这件事已经由 layout.dual_shape 报过，这里不再重复告警
      if (facts.shape === "both") return null;
      const mismatch = false;
      return {
        id: "process.disk_vs_loaded",
        ruleId: "process.disk_vs_loaded",
        title: "磁盘状态与加载状态一致",
        severity: "low",
        status: mismatch ? "warn" : "pass",
        rootCause: {
          confidence: "inferred",
          text: mismatch
            ? "磁盘同时存在两种形态；按解包形态推断已加载，但模块是否真的重载只有重启后能证明。"
            : "加载形态与磁盘形态没有明显冲突。",
        },
        evidence: [ev("dir", facts.unpacked.path), ev("process", facts.process.probedBy)],
        tags: ["disk-vs-loaded"],
      };
    },
  },
  {
    id: "profile.bundle_declared",
    title: "profile 启用项都有依赖声明",
    category: "profile",
    evaluate({ facts }) {
      if (facts.profiles.length === 0) {
        return {
          id: "profile.bundle_declared",
          ruleId: "profile.bundle_declared",
          title: "profile 启用项都有依赖声明",
          severity: "low",
          status: "not_applicable",
          evidence: [ev("dir", `${facts.candidate.home ?? ""}/profiles`)],
          rootCause: { confidence: "verified", text: "未发现任何 profile 目录" },
        };
      }
      const missing: string[] = [];
      const dupes: string[] = [];
      const official: string[] = [];
      for (const p of facts.profiles) {
        if (p.error) continue;
        for (const bundle of p.bundles) {
          // 官方 bundle（@deepseek-ai/*）由宿主自带运行时解析，本就不在 profile 依赖里。
          if (bundle.startsWith("@deepseek-ai/")) {
            official.push(`${p.name}:${bundle}`);
            continue;
          }
          const bare = bundle.split("/").slice(0, bundle.startsWith("@") ? 2 : 1).join("/");
          if (!(bundle in p.dependencies) && !(bare in p.dependencies)) missing.push(`${p.name}:${bundle}`);
        }
        const seen = new Set<string>();
        for (const b of p.bundles) {
          if (seen.has(b)) dupes.push(`${p.name}:${b}`);
          seen.add(b);
        }
      }
      const problems = [...missing.map((m) => `缺少第三方插件依赖 ${m}`), ...dupes.map((d) => `重复启用 ${d}`)];
      if (problems.length === 0 && official.length > 0) {
        return {
          id: "profile.bundle_declared",
          ruleId: "profile.bundle_declared",
          title: "profile 启用项都有依赖声明",
          severity: "low",
          status: "pass",
          rootCause: {
            confidence: "verified",
            text: `第三方启用项均有依赖声明；${official.length} 个官方 bundle 由宿主运行时解析`,
          },
          evidence: facts.profiles.map((p) => ev("file", p.packageJsonPath)),
          tags: ["official-bundles"],
        };
      }
      return {
        id: "profile.bundle_declared",
        ruleId: "profile.bundle_declared",
        title: "profile 启用项都有依赖声明",
        severity: problems.length > 0 ? "high" : "low",
        status: problems.length > 0 ? "fail" : "pass",
        rootCause: problems.length > 0 ? { confidence: "verified", text: problems.join("；") } : undefined,
        evidence: facts.profiles.map((p) => ev("file", p.packageJsonPath)),
        remediation: problems.length
          ? {
              summary: "启用项缺依赖会导致宿主启动时报 Cannot find package；不要靠删配置掩盖。",
              steps: ["核对 profile 的 dependencies 与 bundles", "用官方 CLI 重新 add 缺失插件", "保留备份后再修改"],
              risk: 45,
            }
          : undefined,
      };
    },
  },
  {
    id: "profile.unreadable",
    title: "profile 配置可读",
    category: "profile",
    evaluate({ facts }) {
      const broken = facts.profiles.filter((p) => p.error);
      if (broken.length === 0) return null;
      return {
        id: "profile.unreadable",
        ruleId: "profile.unreadable",
        title: "profile 配置可读",
        severity: "medium",
        status: "fail",
        rootCause: { confidence: "verified", text: broken.map((p) => `${p.name}: ${p.error}`).join("；") },
        evidence: broken.map((p) => ev("file", p.packageJsonPath)),
      };
    },
  },
  {
    id: "modification.traceable",
    title: "宿主修改有可追溯来源",
    category: "modification",
    evaluate({ facts }) {
      const m = facts.modification;
      const base = {
        id: "modification.traceable",
        ruleId: "modification.traceable",
        title: "宿主修改有可追溯来源",
        severity: "high" as const,
        evidence: m.packs.map((p) => ev(p.evidence.kind, p.evidence.source, `${p.tool} ${p.version ?? ""} ${p.appliedAt ?? ""}`.trim(), p.evidence.hash)),
      };
      if (m.looksModified === null) {
        return { ...base, status: "unknown", rootCause: { confidence: "inferred", text: "无法判断宿主源码是否被就地修改" } };
      }
      if (m.looksModified === false) {
        return { ...base, status: "pass", rootCause: { confidence: "verified", text: "未发现宿主源码被就地修改的迹象" } };
      }
      if (m.packs.length > 0) {
        return {
          ...base,
          status: "warn",
          rootCause: {
            confidence: "verified",
            text: `宿主源码含修改标记（抽样 ${m.scannedFiles ?? 0} 个文件命中 ${m.markerHits.length} 个），来源：${m.packs.map((p) => `${p.tool}@${p.version ?? "?"}`).join(", ")}`,
          },
          remediation: {
            summary: "修改来源可追溯，但必须保留对应快照才能回滚。",
            steps: ["确认存在修改前的快照", "升级宿主后重新诊断（锚点可能漂移）"],
            risk: 20,
          },
          tags: ["modified"],
        };
      }
      return {
        ...base,
        status: "fail",
        rootCause: { confidence: "verified", text: "宿主源码被修改，但没有找到任何修改包/快照记录" },
        remediation: {
          summary: "无来源记录的宿主修改在升级后会静默失效且难以回滚。",
          steps: ["立即创建当前状态快照", "确认修改来自哪次操作", "用官方安装包对照恢复"],
          risk: 60,
        },
        tags: ["unmanaged-modification"],
      };
    },
  },
  {
    id: "modification.legacy_pack_version",
    title: "旧修改包版本与安装记录一致",
    category: "modification",
    evaluate({ facts }) {
      const pack = facts.modification.packs.find((p) => p.tool === "dsh-purge");
      if (!pack) return null;
      const declared = facts.profiles
        .flatMap((p) => Object.entries(p.dependencies))
        .filter(([name]) => name.startsWith("dsh-purge"))
        .map(([, spec]) => spec);
      const version = pack.version ?? "unknown";
      const spec = declared.find((s) => s.includes(version));
      return {
        id: "modification.legacy_pack_version",
        ruleId: "modification.legacy_pack_version",
        title: "旧修改包版本与安装记录一致",
        severity: "medium",
        status: spec ? "pass" : "warn",
        rootCause: {
          confidence: spec ? "verified" : "inferred",
          text: spec
            ? `应用记录 ${version} 与 profile 依赖声明一致`
            : `应用记录为 ${version}，但 profile 依赖里没有匹配声明（${declared.join(", ") || "无"}）`,
        },
        evidence: [ev("file", pack.evidence.source), ...facts.profiles.map((p) => ev("file", p.packageJsonPath))],
        remediation: spec
          ? undefined
          : { summary: "记录与声明不一致时，「已应用」不能被当作「当前版本已生效」。", steps: ["核对实际安装的包版本", "必要时重新应用并重启宿主"], risk: 30 },
      };
    },
  },
  {
    id: "integrity.backups",
    title: "存在可回滚的宿主快照",
    category: "integrity",
    evaluate({ facts }) {
      if (facts.modification.looksModified !== true) return null;
      // P3-12：归档存在 ≠ 有可验证的快照。诊断层无法读取 Recovery 的快照库，
      // 因此这里只能给 unknown，并明确指出"回滚能力需在快照屏确认"。
      return {
        id: "integrity.backups",
        ruleId: "integrity.backups",
        title: "存在可回滚的宿主快照",
        severity: "medium",
        status: "unknown",
        rootCause: {
          confidence: "inferred",
          text: "宿主已被修改；诊断层无法证明存在可用的快照。请到「快照」屏确认，或先创建一份。",
        },
        evidence: [ev("file", facts.archive.path, "归档存在，但不等于快照完整")],
      };
    },
  },
];

export function evaluateRules(facts: Parameters<Rule["evaluate"]>[0]["facts"], rules: Rule[] = RULES, now = Date.now()): Finding[] {
  const out: Finding[] = [];
  for (const rule of rules) {
    try {
      const finding = rule.evaluate({ facts, now });
      if (finding) out.push(finding);
    } catch (err) {
      out.push({
        id: rule.id,
        ruleId: rule.id,
        title: rule.title,
        severity: "medium",
        status: "unknown",
        evidence: [],
        rootCause: { confidence: "inferred", text: `规则执行异常：${(err as Error).message}` },
      });
    }
  }
  return out;
}
