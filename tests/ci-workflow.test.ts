/**
 * T055-04 CI 配置回归测试（静态，但针对真实事故）：
 *  - package.json 不得声明 install 生命周期钩子（Phase 5 真实事故）
 *  - workflow 必须是 3 OS × {22,24} 六组合
 *  - workflow 不包含 secrets / 部署步骤
 *  - workflow 的每个矩阵组合都执行 lint / typecheck / test / acceptance / 安装冒烟
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { checkPackageScripts } from "../scripts/check-install-lifecycle.ts";

const root = path.resolve(import.meta.dirname, "..");

async function workflowText(): Promise<string> {
  return readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
}

describe("T055-04 CI matrix configuration", () => {
  it("declares the 3 OS x 2 Node matrix (6 combinations)", async () => {
    const text = await workflowText();
    const os = text.match(/os:\s*\[([^\]]+)\]/)?.[1] ?? "";
    const node = text.match(/node:\s*\[([^\]]+)\]/)?.[1] ?? "";
    const oses = os.split(",").map((s) => s.trim());
    const nodes = node.split(",").map((s) => s.trim().replace(/"/g, ""));
    assert.deepEqual(oses, ["windows-latest", "ubuntu-latest", "macos-latest"]);
    assert.deepEqual(nodes, ["22", "24"]);
    assert.equal(oses.length * nodes.length, 6);
  });

  it("enables the sqlite flag for Node 22 so child processes inherit it", async () => {
    const text = await workflowText();
    assert.match(text, /NODE_OPTIONS/);
    assert.match(text, /--experimental-sqlite/);
  });

  it("runs the full gate on every matrix entry", async () => {
    const text = await workflowText();
    for (const command of ["pnpm run lint", "pnpm run typecheck", "pnpm test", "pnpm run acceptance", "pnpm run ci:install"]) {
      assert.ok(text.includes(command), `workflow must run: ${command}`);
    }
    assert.ok(text.includes("check-install-lifecycle.ts"), "workflow must guard the install lifecycle");
  });

  it("contains no secrets, deploy or publish steps", async () => {
    const text = await workflowText();
    assert.equal(/\bsecrets\.[A-Za-z_]/.test(text), false, "no secret references");
    for (const forbidden of ["npm publish", "gh release create", "docker push", "deploy", "kubectl", "terraform"]) {
      assert.equal(text.toLowerCase().includes(forbidden), false, `workflow must not contain: ${forbidden}`);
    }
  });

  it("keeps the verification branch trigger and skips docs-only pushes", async () => {
    const text = await workflowText();
    assert.match(text, /phase5\.5\/\*\*/);
    assert.match(text, /paths-ignore/);
  });
});

describe("T055-04 install lifecycle regression", () => {
  it("package.json has no install/preinstall/postinstall hook", async () => {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const result = checkPackageScripts(pkg.scripts ?? {});
    assert.equal(result.ok, true, result.problems.join("; "));
    assert.equal(Object.prototype.hasOwnProperty.call(pkg.scripts ?? {}, "install"), false);
    assert.equal(typeof (pkg.scripts ?? {})["install:app"], "string");
  });

  it("detects a reintroduced install hook (the guard itself works)", () => {
    const bad = checkPackageScripts({ install: "node scripts/install.mjs", "install:app": "x" });
    assert.equal(bad.ok, false);
    assert.match(bad.problems.join(" "), /lifecycle hook/);
  });

  it("engines still require a Node version that supports type stripping", async () => {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    assert.match(String(pkg.engines?.node ?? ""), />=\s*22\.18/);
  });
});
