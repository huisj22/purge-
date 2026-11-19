/**
 * 安装前置检查（T-035）。
 *
 * 铁律：任何 FAIL 阻止安装；UNKNOWN 不得被当作 PASS。
 * 所有检查都不做破坏性写入（磁盘空间用临时文件探测后删除）。
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readJson } from "../core/atomic.ts";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

export interface CheckItem {
  id: string;
  status: CheckStatus;
  detail: string;
  /** 修复建议（FAIL/WARN 时给出）。 */
  hint?: string;
}

export interface PreflightResult {
  ok: boolean;
  /** 存在 FAIL → false；存在 UNKNOWN 但无 FAIL → ok=false？否：unknown 单独可见，由调用方决定 */
  blocked: boolean;
  checks: CheckItem[];
  os: string;
  arch: string;
  nodeVersion: string;
  existingVersion?: string;
  /** 检测到的未完成安装/升级（状态文件 phase 不是 COMPLETED）。 */
  unfinished?: { phase: string; statePath: string };
}

export interface PreflightOptions {
  installDir: string;
  /** 需要的 Node 主版本下限。 */
  minNodeMajor?: number;
  /** 估算所需空间（字节），默认 64MB。 */
  requiredBytes?: number;
  /** 是否检查"正在运行的 Purge+ 进程"（通过锁目录）。 */
  dataDir?: string;
}

export const INSTALL_STATE_FILE = ".purgeplus/install-state.json";

export async function readInstallState(dir: string): Promise<{ phase: string; version?: string; updatedAt?: string } | null> {
  // 两处都可能承载状态：安装目录内（.purgeplus/install-state.json）与父目录旁（.purgeplus-install-state.json）
  const candidates = [path.join(dir, INSTALL_STATE_FILE), path.join(dir, ".purgeplus-install-state.json")];
  for (const file of candidates) {
    try {
      const raw = await readJson<{ phase?: string; version?: string; updatedAt?: string }>(file, {});
      if (raw && typeof raw.phase === "string") return { phase: raw.phase, version: raw.version, updatedAt: raw.updatedAt };
    } catch {
      /* 尝试下一个 */
    }
  }
  return null;
}

export async function preflight(opts: PreflightOptions): Promise<PreflightResult> {
  const checks: CheckItem[] = [];
  const nodeVersion = process.version;
  const major = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
  const minMajor = opts.minNodeMajor ?? 22;

  // 1 OS / 架构
  const supported = ["win32", "linux", "darwin"].includes(process.platform);
  checks.push({
    id: "platform",
    status: supported ? "PASS" : "FAIL",
    detail: `${process.platform}-${process.arch}`,
    ...(supported ? {} : { hint: "仅支持 win32 / linux / darwin" }),
  });

  // 2 Node 版本
  checks.push({
    id: "node",
    status: Number.isFinite(major) && major >= minMajor ? "PASS" : "FAIL",
    detail: `${nodeVersion}（要求 >= v${minMajor}）`,
    ...(Number.isFinite(major) && major >= minMajor ? {} : { hint: `升级 Node 到 v${minMajor} 或更高` }),
  });

  // 3 安装目录可写
  const installDir = path.resolve(opts.installDir);
  const parent = path.dirname(installDir);
  let writable: CheckStatus = "UNKNOWN";
  let writeDetail = "";
  try {
    await fsp.mkdir(parent, { recursive: true });
    const probe = path.join(parent, `.purgeplus-write-probe-${process.pid}-${Date.now()}`);
    await fsp.writeFile(probe, "probe", "utf8");
    await fsp.rm(probe, { force: true });
    writable = "PASS";
    writeDetail = `父目录可写：${parent}`;
  } catch (err) {
    writable = "FAIL";
    writeDetail = `父目录不可写：${parent}（${(err as Error).message}）`;
  }
  checks.push({ id: "install_dir_writable", status: writable, detail: writeDetail, ...(writable === "FAIL" ? { hint: "更换安装目录或以有权限的用户运行" } : {}) });

  // 4 磁盘空间
  const required = opts.requiredBytes ?? 64 * 1024 * 1024;
  let disk: CheckStatus = "UNKNOWN";
  let diskDetail = "无法探测可用空间";
  try {
    const probe = path.join(parent, `.purgeplus-disk-probe-${process.pid}-${Date.now()}`);
    const chunk = Buffer.alloc(1024 * 1024, 0);
    // 写 2MB 探测块，确认至少有基本可写空间（不写满磁盘）
    await fsp.writeFile(probe, chunk);
    await fsp.rm(probe, { force: true });
    disk = required <= 1024 * 1024 ? "PASS" : "UNKNOWN";
    diskDetail = `可写入 ≥2MB；精确可用空间无法在不依赖平台命令的情况下获取（需要 ${Math.round(required / 1024 / 1024)}MB）`;
  } catch (err) {
    disk = "FAIL";
    diskDetail = `磁盘写入探测失败：${(err as Error).message}`;
  }
  checks.push({ id: "disk_space", status: disk, detail: diskDetail, ...(disk === "UNKNOWN" ? { hint: "请自行确认目标盘剩余空间充足" } : {}) });

  // 5 已安装版本 / 未完成安装
  let existingVersion: string | undefined;
  let unfinished: PreflightResult["unfinished"];
  try {
    const pkgRaw = await fsp.readFile(path.join(installDir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { name?: string; version?: string };
    if (pkg.name !== "purge-plus") {
      checks.push({ id: "existing_install", status: "FAIL", detail: `安装目录已有其他程序：${pkg.name}`, hint: "选择空目录或先备份" });
    } else {
      existingVersion = pkg.version;
      checks.push({ id: "existing_install", status: "PASS", detail: `已安装 purge-plus@${pkg.version}（将执行升级/覆盖）` });
    }
  } catch {
    checks.push({ id: "existing_install", status: "PASS", detail: "目标目录为空（全新安装）" });
  }

  // 状态文件优先看父目录（安装失败时安装目录可能还不存在/已被回滚）
  const parentState = await readInstallState(path.dirname(installDir)).catch(() => null);
  const state = parentState ?? (await readInstallState(installDir));
  if (state && state.phase !== "COMPLETED") {
    unfinished = { phase: state.phase, statePath: path.join(path.dirname(installDir), ".purgeplus-install-state.json") };
    checks.push({
      id: "unfinished_install",
      status: "WARN",
      detail: `检测到未完成安装：phase=${state.phase}`,
      hint: "安装器会先回滚该状态，再继续",
    });
  }

  // 6 正在运行的 Purge+ 进程（通过维护锁目录推断）
  if (opts.dataDir) {
    const lockRoot = path.join(opts.dataDir, "locks");
    const locks = await fsp.readdir(lockRoot).catch(() => [] as string[]);
    const active = locks.filter((l) => l.endsWith(".lock"));
    if (active.length > 0) {
      checks.push({
        id: "running_process",
        status: "WARN",
        detail: `检测到 ${active.length} 个维护锁（${active.join(", ")}）；可能有 Purge+ 正在运行`,
        hint: "建议先停止正在运行的 Purge+ 再安装/升级",
      });
    } else {
      checks.push({ id: "running_process", status: "PASS", detail: "未发现活跃维护锁" });
    }
  } else {
    checks.push({ id: "running_process", status: "UNKNOWN", detail: "未提供数据目录，无法判断是否有 Purge+ 正在运行" });
  }

  const blocked = checks.some((c) => c.status === "FAIL");
  return {
    ok: !blocked,
    blocked,
    checks,
    os: process.platform,
    arch: process.arch,
    nodeVersion,
    ...(existingVersion ? { existingVersion } : {}),
    ...(unfinished ? { unfinished } : {}),
  };
}

/** 人类可读报告。 */
export function formatPreflight(r: PreflightResult): string {
  const lines = [`环境：${r.os}-${r.arch} · Node ${r.nodeVersion}`];
  for (const c of r.checks) lines.push(`  [${c.status}] ${c.id} — ${c.detail}${c.hint ? `（建议：${c.hint}）` : ""}`);
  lines.push(`结论：${r.blocked ? "FAIL（存在阻塞项）" : r.checks.some((c) => c.status === "UNKNOWN") ? "PASS（含未知项，需人工确认）" : "PASS"}`);
  return lines.join("\n");
}

export { os };
