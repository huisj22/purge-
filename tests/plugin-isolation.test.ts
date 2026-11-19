/**
 * T-036 插件进程隔离测试：真实 fork 子进程。
 * 覆盖：生命周期、能力白名单（Host 决定）、超时杀进程、崩溃隔离、非法/超大消息、清理。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLogger } from "../src/core/logger.ts";
import { PLUGIN_API_VERSION, type PluginManifest } from "../src/plugins/host.ts";
import { IsolatedPluginWorker } from "../src/plugins/isolated-host.ts";

let base = "";
before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "p5-workers-"));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

const log = () => createLogger({ sink: () => {} });

async function makePlugin(name: string, body: string, extra: Partial<PluginManifest> = {}): Promise<{ dir: string; manifest: PluginManifest }> {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  const manifest: PluginManifest = {
    name,
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    entry: "index.mjs",
    privilege: "declared",
    capabilities: [],
    ...extra,
  };
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, "index.mjs"), body);
  return { dir, manifest };
}

const resolver = (allowed: Record<string, (...args: unknown[]) => unknown>) => (service: string) => {
  const fn = allowed[service];
  return fn ? { allow: true, invoke: fn } : { allow: false, reason: `service ${service} not wired in test` };
};

describe("T-036 isolated plugin worker", () => {
  it("starts in a separate process, reports health and invokes", { timeout: 20000 }, async () => {
    const { dir, manifest } = await makePlugin(
      "basic",
      [
        "export function activate(ctx) { ctx.log('info', 'activated in worker'); }",
        "export function health() { return { ok: true, pid: process.pid }; }",
        "export async function invoke(method, args) { return { method, args, pid: process.pid }; }",
        "export function deactivate() {}",
      ].join("\n"),
    );
    const worker = new IsolatedPluginWorker({ manifest, pluginDir: dir, logger: log(), capabilityResolver: resolver({}) });
    await worker.start();
    assert.equal(worker.state, "RUNNING");
    assert.ok(worker.pid && worker.pid !== process.pid, "必须运行在独立进程");

    const health = await worker.request("health");
    assert.equal(health.ok, true);
    assert.notEqual((health.value as { pid: number }).pid, process.pid);

    const invoked = await worker.request("invoke", { method: "echo", args: { a: 1 } });
    assert.equal(invoked.ok, true);
    assert.deepEqual((invoked.value as { method: string }).method, "echo");

    await worker.stop();
    assert.equal(worker.state, "STOPPED");
  });

  it("host decides capability access: undeclared capability is denied inside the worker", { timeout: 20000 }, async () => {
    const { dir, manifest } = await makePlugin(
      "caps-denied",
      [
        "let ctx;",
        "export function activate(c) { ctx = c; }",
        "export function health() { return { ok: true }; }",
        "export async function invoke() {",
        "  try { const svc = ctx.use('secret-service'); return { ok: true, svc: typeof svc }; }",
        "  catch (err) { return { ok: false, error: err.message }; }",
        "}",
      ].join("\n"),
    );
    const worker = new IsolatedPluginWorker({ manifest, pluginDir: dir, logger: log(), capabilityResolver: resolver({ "secret-service": () => "leaked" }) });
    await worker.start();
    const result = await worker.request("invoke", { method: "x", args: null });
    assert.equal(result.ok, true);
    assert.equal((result.value as { ok: boolean }).ok, false);
    assert.match(String((result.value as { error: string }).error), /not declared/);
    await worker.stop();
  });

  it("declared capability calls are executed by the host, not by the worker", { timeout: 20000 }, async () => {
    const calls: string[] = [];
    const { dir, manifest } = await makePlugin(
      "caps-ok",
      [
        "let ctx;",
        "export function activate(c) { ctx = c; }",
        "export function health() { return { ok: true }; }",
        "export async function invoke() {",
        "  const diag = ctx.use('diagnostics');",
        "  return { reports: await diag.recentReports(2) };",
        "}",
      ].join("\n"),
      { capabilities: ["diagnostics"] },
    );
    const worker = new IsolatedPluginWorker({
      manifest,
      pluginDir: dir,
      logger: log(),
      capabilityResolver: resolver({
        diagnostics: (limit) => {
          calls.push(`recentReports(${String(limit)})`);
          return [{ reportId: "r1" }];
        },
      }),
    });
    await worker.start();
    const result = await worker.request("invoke", { method: "x", args: null });
    assert.equal(result.ok, true);
    assert.deepEqual((result.value as { reports: unknown[] }).reports, [{ reportId: "r1" }]);
    assert.deepEqual(calls, ["recentReports(2)"], "宿主执行了能力调用");
    await worker.stop();
  });

  it("kills a hanging plugin on timeout and marks TIMEOUT", { timeout: 20000 }, async () => {
    const { dir, manifest } = await makePlugin(
      "hangs",
      ["export function activate() {}", "export function health() { return { ok: true }; }", "export async function invoke() { await new Promise((r) => setTimeout(r, 30000)); return 'late'; }"].join("\n"),
    );
    const worker = new IsolatedPluginWorker({ manifest, pluginDir: dir, logger: log(), capabilityResolver: resolver({}), requestTimeoutMs: 300 });
    await worker.start();
    const started = Date.now();
    const result = await worker.request("invoke", { method: "sleep" });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.state, "TIMEOUT");
    assert.ok(elapsed < 3000, `超时必须及时返回（实际 ${elapsed}ms）`);
    await worker.stop();
  });

  it("isolates a crashing plugin: core process survives and state is CRASHED", { timeout: 20000 }, async () => {
    const { dir, manifest } = await makePlugin(
      "crasher",
      ["export function activate() {}", "export function health() { return { ok: true }; }", "export async function invoke() { process.exit(7); }"].join("\n"),
    );
    const worker = new IsolatedPluginWorker({ manifest, pluginDir: dir, logger: log(), capabilityResolver: resolver({}), requestTimeoutMs: 5000 });
    await worker.start();
    const result = await worker.request("invoke", { method: "die" });
    assert.equal(result.ok, false);
    assert.equal(worker.state, "CRASHED");
    // 核心进程仍然存活（本测试仍在运行即证明）
    assert.equal(process.exitCode, undefined);
    await worker.stop();
  });

  it("rejects a plugin whose activate throws (startup failure is explicit)", { timeout: 20000 }, async () => {
    const { dir, manifest } = await makePlugin("bad-activate", "export function activate() { throw new Error('boom on activate'); }\n");
    const worker = new IsolatedPluginWorker({ manifest, pluginDir: dir, logger: log(), capabilityResolver: resolver({}), startupTimeoutMs: 3000 });
    await assert.rejects(() => worker.start(), /exited before ready|failed to start|timeout/);
    assert.ok(["CRASHED", "FAILED", "TIMEOUT"].includes(worker.state));
    await worker.stop();
  });

  it("reports STOPPED and releases the child process after stop", { timeout: 20000 }, async () => {
    const { dir, manifest } = await makePlugin("stoppable", "export function activate() {}\nexport function health() { return { ok: true }; }\n");
    const worker = new IsolatedPluginWorker({ manifest, pluginDir: dir, logger: log(), capabilityResolver: resolver({}) });
    await worker.start();
    const pid = worker.pid;
    assert.ok(pid);
    await worker.stop();
    assert.equal(worker.state, "STOPPED");
    let alive = true;
    try {
      process.kill(pid as number, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "子进程必须真正退出");
  });

  it("refuses invoke when the worker is not running", { timeout: 20000 }, async () => {
    const { dir, manifest } = await makePlugin("never-started", "export function activate() {}\n");
    const worker = new IsolatedPluginWorker({ manifest, pluginDir: dir, logger: log(), capabilityResolver: resolver({}) });
    // 未 start 时 request 会自动 start；先 stop 再请求，应得到明确错误
    await worker.start();
    await worker.stop();
    const result = await worker.request("invoke", { method: "x" });
    assert.equal(result.ok, false);
    // stop 后 request 会因为 CREATED→start 而重新拉起，或直接返回非 RUNNING；两种都必须是"明确失败/成功"，不能静默
    assert.ok(typeof result.ok === "boolean");
  });
});

describe("T-036 plugin host in process-isolation mode", () => {
  it("installs, enables and invokes a plugin through the isolated host", { timeout: 25000 }, async () => {
    const { PluginHost } = await import("../src/plugins/host.ts");
    const { mkdir: mkdirAsync, writeFile: writeAsync } = await import("node:fs/promises");
    const dataDir = path.join(base, "host-iso");
    const src = path.join(base, "host-iso-src");
    await mkdirAsync(src, { recursive: true });
    await writeAsync(
      path.join(src, "plugin.json"),
      JSON.stringify({ name: "iso-plugin", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, entry: "index.mjs", privilege: "declared", capabilities: ["diagnostics"] }),
    );
    await writeAsync(
      path.join(src, "index.mjs"),
      [
        "let ctx;",
        "export function activate(c) { ctx = c; }",
        "export function health() { return { ok: true, detail: 'iso' }; }",
        "export async function invoke() { const d = ctx.use('diagnostics'); return { n: await d.recentReports(1) }; }",
      ].join("\n"),
    );
    const host = new PluginHost({
      dataDir,
      logger: log(),
      isolation: "process",
      resolveService: (service) => {
        if (service !== "diagnostics") throw new Error(`unexpected service ${service}`);
        return { recentReports: (n: number) => [{ reportId: `r-${n}` }] };
      },
    });
    await host.install(src);
    try {
      const enabled = await host.enable("iso-plugin");
      assert.equal(enabled.state, "enabled");
      const health = await host.health("iso-plugin");
      assert.equal(health.ok, true);
      assert.equal(health.detail, "iso");
      const value = (await host.invoke("iso-plugin", "any", null)) as { n: Array<{ reportId: string }> };
      assert.deepEqual(value.n, [{ reportId: "r-1" }]);
    } finally {
      // 无论断言是否失败，都必须关掉子进程，否则测试运行器会一直等待句柄
      await host.disable("iso-plugin").catch(() => {});
    }
    const afterDisable = await host.health("iso-plugin");
    assert.equal(afterDisable.ok, false);
  });
});