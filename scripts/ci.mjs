#!/usr/bin/env node
/**
 * 本地 CI（T-035 3.7）：在没有 GitHub Actions 的环境里跑与 CI 相同的步骤。
 * 任一步失败即非零退出；不跳过、不放宽。
 *
 * 步骤：deps → lint → typecheck → unit/integration tests → acceptance → package → verify → install smoke
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const steps = [];
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

function run(label, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    // 不用 shell：Windows 下 "C:\Program Files\nodejs\node.exe" 会被 shell 拆断
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      steps.push({ label, code: code ?? -1, ms: Date.now() - started });
      process.stdout.write(`${code === 0 ? "✓" : "✗"} ${label} (${Date.now() - started}ms)\n`);
      if (code !== 0) process.stdout.write(`${out.split("\n").slice(-40).join("\n")}\n`);
      resolve({ code: code ?? -1, out });
    });
    child.on("error", (err) => {
      steps.push({ label, code: -1, ms: Date.now() - started });
      process.stdout.write(`✗ ${label}: ${err.message}\n`);
      resolve({ code: -1, out: err.message });
    });
  });
}

const should = (name) => only.length === 0 || only.includes(name);
const node = process.execPath;

const results = [];

if (should("lint")) results.push(await run("lint", node, ["node_modules/eslint/bin/eslint.js", "src", "tests", "scripts"]));
if (should("typecheck")) results.push(await run("typecheck", node, ["node_modules/typescript/bin/tsc", "--noEmit"]));
if (should("test")) results.push(await run("test (unit+integration+fault)", node, ["--test", "tests/**/*.test.ts"]));
if (should("acceptance")) results.push(await run("acceptance", node, ["scripts/acceptance.ts"]));
if (should("install")) {
  const tmp = await mkdtemp(path.join(tmpdir(), "purge-ci-"));
  try {
    const pkg = path.join(tmp, "pkg.tar.gz");
    results.push(await run("package", node, ["scripts/package.mjs", "--out", pkg]));
    results.push(await run("install (fresh)", node, ["scripts/install.mjs", "--install-dir", path.join(tmp, "app"), "--package", pkg]));
    results.push(await run("install (idempotent)", node, ["scripts/install.mjs", "--install-dir", path.join(tmp, "app"), "--package", pkg]));
    results.push(await run("installed cli doctor", node, [path.join(tmp, "app", "src/cli/main.ts"), "doctor", "--data-dir", path.join(tmp, "data")]));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const failed = steps.filter((s) => s.code !== 0);
process.stdout.write(`\n${steps.length - failed.length}/${steps.length} 通过${failed.length ? `，失败：${failed.map((f) => f.label).join(", ")}` : ""}\n`);
process.exit(failed.length === 0 ? 0 : 1);
