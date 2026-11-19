import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLogger } from "../src/core/logger.ts";
import { PurgeError } from "../src/core/errors.ts";
import { PLUGIN_API_VERSION, PluginHost } from "../src/plugins/host.ts";

async function makePlugin(root: string, name: string, opts: { capabilities?: string[]; entryBody?: string; version?: string } = {}) {
  const dir = path.join(root, `${name}-${opts.version ?? "1.0.0"}`);
  await mkdir(dir, { recursive: true });
  const manifest = {
    name,
    version: opts.version ?? "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    entry: "index.mjs",
    privilege: "declared",
    description: "测试插件",
    capabilities: opts.capabilities ?? [],
  };
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(dir, "index.mjs"),
    opts.entryBody ??
      [
        "let activated = false;",
        "export function activate(ctx) { activated = true; ctx.log('info', 'activated'); }",
        "export function health() { return { ok: activated, detail: activated ? 'ok' : 'not activated' }; }",
        "export async function invoke(method, args) { return { method, args, activated }; }",
        "export function deactivate() { activated = false; }",
      ].join("\n"),
  );
  return dir;
}

describe("plugin host", () => {
  let base = "";
  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "purgeplus-plugins-"));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const makeHost = (sub: string, services: Record<string, unknown> = {}) =>
    new PluginHost({
      dataDir: path.join(base, sub),
      logger: createLogger({ sink: () => {} }),
      resolveService: (name) => {
        if (!(name in services)) throw new Error(`service not wired in test: ${name}`);
        return services[name];
      },
    });

  it("installs a plugin, keeps it disabled until enabled, then reports health", async () => {
    const host = makeHost("a");
    const src = await makePlugin(path.join(base, "src-a"), "demo-a");
    const installed = await host.install(src);
    assert.equal(installed.state, "disabled");
    assert.equal(installed.manifest.name, "demo-a");

    const listed = await host.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.state, "disabled");

    const beforeHealth = await host.health("demo-a");
    assert.equal(beforeHealth.ok, false, "disabled plugin must not report healthy");

    const enabled = await host.enable("demo-a");
    assert.equal(enabled.state, "enabled");
    const health = await host.health("demo-a");
    assert.equal(health.ok, true, health.detail);

    const invoked = (await host.invoke("demo-a", "ping", { n: 1 })) as { method: string; activated: boolean };
    assert.equal(invoked.method, "ping");
    assert.equal(invoked.activated, true);

    await host.disable("demo-a");
    await assert.rejects(() => host.invoke("demo-a", "ping", null), /not enabled/);
  });

  it("rejects duplicate content mismatches and accepts identical reinstalls", async () => {
    const host = makeHost("b");
    const src = await makePlugin(path.join(base, "src-b"), "demo-b");
    await host.install(src);
    const again = await host.install(src);
    assert.equal(again.manifest.name, "demo-b");

    await writeFile(path.join(src, "extra.txt"), "changed", "utf8");
    await assert.rejects(() => host.install(src), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "conflict");
      return true;
    });
    const overwritten = await host.install(src, { overwrite: true });
    assert.equal(overwritten.manifest.name, "demo-b");
  });

  it("enforces the capability whitelist", async () => {
    const host = makeHost("c", { diagnostics: { ping: () => "ok" }, rules: { ping: () => "rules" } });
    const src = await makePlugin(path.join(base, "src-c"), "needs-diag", {
      capabilities: ["diagnostics"],
      entryBody: [
        "let granted = null;",
        "export function activate(ctx) { granted = ctx.use('diagnostics').ping(); }",
        "export function health() { return { ok: granted === 'ok', detail: String(granted) }; }",
      ].join("\n"),
    });
    await host.install(src);
    const enabled = await host.enable("needs-diag");
    assert.equal(enabled.state, "enabled");
    assert.equal((await host.health("needs-diag")).ok, true);

    const forbidden = await makePlugin(path.join(base, "src-c2"), "greedy", {
      capabilities: [],
      entryBody: ["export function activate(ctx) { ctx.use('rules'); }"].join("\n"),
    });
    await host.install(forbidden);
    await assert.rejects(() => host.enable("greedy"), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.match(err.message, /did not declare capability/);
      return true;
    });
    const broken = (await host.list()).find((p) => p.manifest.name === "greedy");
    assert.equal(broken?.state, "broken", "load failure must be recorded, not hidden");
  });

  it("rejects malformed manifests and entry escapes", async () => {
    const host = makeHost("d");
    const badVersion = await makePlugin(path.join(base, "src-d"), "bad-api", { version: "1.0.0" });
    await writeFile(
      path.join(badVersion, "plugin.json"),
      JSON.stringify({ name: "bad-api", version: "1.0.0", apiVersion: "999", entry: "index.mjs", privilege: "declared", capabilities: [] }),
    );
    await assert.rejects(() => host.install(badVersion), /apiVersion/);

    const escape = await makePlugin(path.join(base, "src-d2"), "escape", { version: "1.0.0" });
    await writeFile(
      path.join(escape, "plugin.json"),
      JSON.stringify({ name: "escape", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, entry: "../outside.mjs", privilege: "declared", capabilities: [] }),
    );
    await assert.rejects(() => host.install(escape), /entry/);
  });

  it("removes a plugin and its state", async () => {
    const host = makeHost("e");
    const src = await makePlugin(path.join(base, "src-e"), "demo-e");
    await host.install(src);
    await host.enable("demo-e");
    await host.remove("demo-e");
    assert.deepEqual(await host.list(), []);
    await assert.rejects(() => host.health("demo-e"), /not installed/);
  });

  it("gives plugins a private store", async () => {
    const host = makeHost("f");
    const src = await makePlugin(path.join(base, "src-f"), "store-plugin", {
      entryBody: [
        "export async function activate(ctx) { await ctx.store.set('count', 7); }",
        "export async function health() { return { ok: true }; }",
        "export async function invoke() { return null; }",
        "export async function read(ctx) { return null; }",
      ].join("\n"),
    });
    await host.install(src);
    await host.enable("store-plugin");
    const dir = (await host.list())[0]?.dir as string;
    const stored = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(dir, ".data", "store.json"), "utf8"));
    assert.equal(stored.count, 7);
  });
});
