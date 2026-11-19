#!/usr/bin/env node
/**
 * CI 回归守卫：确保 `pnpm install` 不会触发应用安装逻辑。
 *
 * 背景（Phase 5 收尾轮真实事故）：package.json 曾声明
 *   "install": "node scripts/install.mjs"
 * npm/pnpm 把 `install` 当作生命周期钩子自动执行，该脚本要求 --install-dir，
 * 于是三个平台的依赖安装阶段全部 exit 2。本地从不跑裸 `pnpm install` 所以没暴露。
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const LIFECYCLE_HOOKS = ["preinstall", "install", "postinstall", "prepare", "prepublish"] as const;

export function checkPackageScripts(scripts: Record<string, string>): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const hook of LIFECYCLE_HOOKS) {
    if (Object.prototype.hasOwnProperty.call(scripts, hook)) {
      problems.push(
        `"${hook}" is a lifecycle hook and runs automatically on pnpm install; ` +
          `our app installer requires --install-dir, so it must be named differently (e.g. install:app)`,
      );
    }
  }
  if (!Object.prototype.hasOwnProperty.call(scripts, "install:app")) {
    problems.push('missing "install:app" script (the explicit, non-lifecycle installer entry)');
  }
  return { ok: problems.length === 0, problems };
}

export function checkPackageJson(root: string): { ok: boolean; problems: string[]; file: string } {
  const file = path.join(root, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> };
  return { ...checkPackageScripts(pkg.scripts ?? {}), file };
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(selfPath)) {
  const root = path.resolve(path.dirname(selfPath), "..");
  const result = checkPackageJson(root);
  if (result.ok) {
    process.stdout.write(`✓ install lifecycle clean (${result.file})\n`);
    process.exit(0);
  }
  process.stderr.write(`✗ install lifecycle check failed:\n${result.problems.map((p) => `  - ${p}`).join("\n")}\n`);
  process.exit(1);
}