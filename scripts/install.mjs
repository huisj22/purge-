#!/usr/bin/env node
/**
 * 安装器 CLI（T-035）。
 *
 * 用法：
 *   node scripts/install.mjs --install-dir <dir> [--source <dir> | --package <file>] [--data-dir <dir>] [--json] [--dry-run]
 *   node scripts/install.mjs --install-dir <dir> --uninstall [--purge-data --data-dir <dir>]
 *   node scripts/install.mjs --install-dir <dir> --preflight
 */
import { Installer, formatPreflight, verifyPackage } from "../src/installer/installer.ts";
import { preflight } from "../src/installer/preflight.ts";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const dryRun = argv.includes("--dry-run");
const doUninstall = argv.includes("--uninstall");
const purgeData = argv.includes("--purge-data");
const preflightOnly = argv.includes("--preflight");

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const installDir = flag("--install-dir");
if (!installDir) {
  process.stderr.write("缺少 --install-dir <目录>\n");
  process.exit(2);
}
const sourceDir = flag("--source");
const packageFile = flag("--package");
const dataDir = flag("--data-dir");

try {
  if (preflightOnly) {
    const r = await preflight({ installDir, ...(dataDir ? { dataDir } : {}) });
    process.stdout.write(`${json ? JSON.stringify(r, null, 2) : formatPreflight(r)}\n`);
    process.exit(r.blocked ? 1 : 0);
  }

  if (packageFile) {
    const v = await verifyPackage(packageFile);
    if (!v.ok) {
      process.stderr.write(`包校验失败：${v.problems.join("; ")}\n`);
      process.exit(1);
    }
    if (!json) process.stdout.write(`包校验通过：purge-plus@${v.version} · ${v.files} 文件\n`);
  }

  const installer = new Installer({
    installDir,
    ...(sourceDir ? { sourceDir } : {}),
    ...(packageFile ? { packageFile } : {}),
    ...(dataDir ? { dataDir } : {}),
  });

  if (dryRun) {
    const r = await preflight({ installDir, ...(dataDir ? { dataDir } : {}) });
    process.stdout.write(`[dry-run] 仅执行前置检查，不写任何文件\n${json ? JSON.stringify(r, null, 2) : formatPreflight(r)}\n`);
    process.exit(r.blocked ? 1 : 0);
  }

  if (doUninstall) {
    const r = await installer.uninstall({ purgeData, ...(dataDir ? { dataDir } : {}) });
    process.stdout.write(`${json ? JSON.stringify(r, null, 2) : `已卸载：${r.removed.join(", ")}${r.keptData ? `\n保留数据目录：${r.keptData}` : ""}`}\n`);
    process.exit(0);
  }

  const result = await installer.install();
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        result.idempotent ? `已是最新：purge-plus@${result.version}（幂等，未做改动）` : `安装完成：purge-plus@${result.version}`,
        `安装目录：${result.installDir}`,
        result.backupDir ? `旧版本备份：${result.backupDir}` : "",
        result.postCheck ? `后置检查：${result.postCheck.ok ? "通过" : "失败"} — ${result.postCheck.detail}` : "",
        `状态文件：${result.stateFile}`,
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );
  }
  process.exit(result.phase === "COMPLETED" ? 0 : 1);
} catch (err) {
  const e = err;
  process.stderr.write(`${e.code ? `${e.code}: ` : ""}${e.message}\n`);
  if (e.detail) process.stderr.write(`${JSON.stringify(e.detail, null, 2)}\n`);
  process.exit(1);
}
