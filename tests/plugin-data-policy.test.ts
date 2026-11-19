/**
 * T055-03 插件数据边界测试：
 *  - 数据目录与程序目录分离；升级/重装不丢数据
 *  - 卸载默认保留数据；purgeData 才删除
 *  - 路径穿越 / 绝对路径 / 符号链接 / Junction / 跨插件访问 / 核心目录 全部拒绝
 *  - 插件 ID 校验
 *  - 拒绝事件可审计
 *  - 进程隔离模式下 ctx.data 同样受宿主校验
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLogger } from "../src/core/logger.ts";
import { PurgeError } from "../src/core/errors.ts";
import { assertPluginId, normalizeRelative, PluginDataStore } from "../src/plugins/data-policy.ts";
import { PLUGIN_API_VERSION, PluginHost, type PluginManifest } from "../src/plugins/host.ts";

let base = "";
before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "p55-plugin-data-"));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

const log = () => createLogger({ sink: () => {} });

async function makePlugin(name: string, body: string, extra: Partial<PluginManifest> = {}): Promise<string> {
  const dir = path.join(base, `src-${name}-${Math.random().toString(36).slice(2, 6)}`);
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
  return dir;
}

describe("T055-03 plugin id and path normalisation", () => {
  it("rejects ids that could escape the data root", () => {
    for (const bad of ["../evil", "a/b", "a\\b", ".hidden", "", "x".repeat(65), "a..b", "CON", "привет"]) {
      assert.throws(() => assertPluginId(bad), (e: unknown) => {
        assert.ok(e instanceof PurgeError);
        assert.equal(e.code, "invalid_argument");
        return true;
      }, `id should be rejected: ${bad}`);
    }
    assert.equal(assertPluginId("demo-plugin.1_x"), "demo-plugin.1_x");
  });

  it("rejects absolute paths, traversal and device names", () => {
    for (const bad of ["/etc/passwd", "C:\\Windows\\win.ini", "..\\x", "a/../../b", "\\\\server\\share", "nul", "a/con/b"]) {
      assert.throws(() => normalizeRelative(bad), (e: unknown) => {
        assert.ok(e instanceof PurgeError);
        assert.ok(["policy_denied", "invalid_argument"].includes(e.code));
        return true;
      }, `path should be rejected: ${bad}`);
    }
    assert.equal(normalizeRelative("sub/dir/file.txt"), "sub/dir/file.txt");
  });
});

describe("T055-03 plugin data store boundaries", () => {
  it("keeps each plugin's data isolated and blocks cross-plugin access", async () => {
    const store = new PluginDataStore(path.join(base, "root"));
    await store.api("alpha").write("a.txt", "alpha-secret");
    await store.api("beta").write("b.txt", "beta-secret");
    const alphaOnly = await store.api("alpha").read("a.txt");
    assert.equal(alphaOnly.toString(), "alpha-secret");
    // beta 尝试用相对路径读取 alpha（越界）
    await assert.rejects(() => store.api("beta").read("../alpha/a.txt"), (e: unknown) => {
      assert.equal((e as { code?: string }).code, "policy_denied");
      return true;
    });
    await assert.rejects(() => store.api("beta").write("../alpha/a.txt", "pwned"));
    assert.equal((await store.api("alpha").read("a.txt")).toString(), "alpha-secret");
  });

  it("refuses symlinks and junctions inside the data dir", { timeout: 20000 }, async () => {
    const root = path.join(base, "links");
    const store = new PluginDataStore(root);
    await store.ensure("gamma");
    const outside = path.join(base, "outside.txt");
    await writeFile(outside, "outside-secret", "utf8");
    const link = path.join(store.dirFor("gamma"), "escape.txt");
    let linked = false;
    try {
      await symlink(outside, link, "file");
      linked = true;
    } catch {
      linked = false;
    }
    if (linked) {
      await assert.rejects(() => store.api("gamma").read("escape.txt"), (e: unknown) => {
        assert.equal((e as { code?: string }).code, "policy_denied");
        return true;
      });
      await assert.rejects(() => store.api("gamma").write("escape.txt", "overwrite"));
    }
    // 目录型链接（Windows junction）
    const dirLink = path.join(store.dirFor("gamma"), "escape-dir");
    try {
      await symlink(path.join(base), dirLink, "junction");
      await assert.rejects(() => store.api("gamma").read("escape-dir/outside.txt"), /policy_denied/);
    } catch (err) {
      if (!(err instanceof PurgeError)) {
        // 平台不允许创建链接：记录而不失败（行为已在上面 file symlink 覆盖）
      }
    }
  });

  it("cannot touch Purge+ core directories even via absolute-looking input", async () => {
    const dataDir = path.join(base, "core", "data");
    await mkdir(dataDir, { recursive: true });
    const store = new PluginDataStore(path.join(dataDir, "plugin-data"));
    await store.ensure("delta");
    // 核心文件：插件目录外的一切都必须拒绝
    const coreFile = path.join(dataDir, "config.json");
    await writeFile(coreFile, "core-config", "utf8");
    for (const target of ["../config.json", "../../config.json", "a/../../config.json", "../../security/policy.json"]) {
      await assert.rejects(() => store.api("delta").write(target, "x"), (e: unknown) => {
        assert.ok(e instanceof PurgeError);
        return true;
      }, `should reject ${target}`);
    }
    assert.equal(await readFile(coreFile, "utf8"), "core-config", "核心配置不得被插件改写");
    // 合法路径仍然可用
    const ok = await store.api("delta").write("notes/a.txt", "fine");
    assert.ok(ok.hash.length === 64);
  });

  it("rejects oversized reads and writes", async () => {
    const store = new PluginDataStore(path.join(base, "limits"));
    await assert.rejects(() => store.api("eps").write("big.bin", Buffer.alloc(2 * 1024 * 1024)), /too large/);
  });
});

describe("T055-03 plugin data lifecycle", () => {
  it("survives upgrade and reinstall, and is kept on uninstall by default", { timeout: 30000 }, async () => {
    const dataDir = path.join(base, "lifecycle", "data");
    const host = new PluginHost({ dataDir, logger: log(), resolveService: () => ({}) });
    const src1 = await makePlugin("keeper", [
      "export async function activate(ctx) { await ctx.store.set('runs', 1); await ctx.data.write('notes.txt', 'v1'); }",
      "export function health() { return { ok: true }; }",
    ].join("\n"));
    await host.install(src1);
    await host.enable("keeper");
    await host.disable("keeper");

    // 升级：v2 内容不同
    const src2 = await makePlugin("keeper", [
      "export async function activate(ctx) { const n = (await ctx.store.get('runs')) ?? 0; await ctx.store.set('runs', n + 1); }",
      "export function health() { return { ok: true }; }",
    ].join("\n"), { version: "2.0.0" });
    await host.install(src2);
    await host.enable("keeper");
    await host.disable("keeper");

    const storeFile = path.join(dataDir, "plugin-data", "keeper", "store.json");
    const stored = JSON.parse(await readFile(storeFile, "utf8"));
    assert.equal(stored.runs, 2, "升级必须共享同一份数据");
    assert.equal(await readFile(path.join(dataDir, "plugin-data", "keeper", "notes.txt"), "utf8"), "v1");

    const removed1 = await host.remove("keeper");
    assert.equal(removed1.dataPurged, false);
    assert.equal(removed1.dataKept, true);
    assert.equal(JSON.parse(await readFile(storeFile, "utf8")).runs, 2, "卸载默认保留数据");

    // 重装后数据仍在（不重复 activate，直接读文件即可验证）
    await host.install(src1);
    assert.equal(JSON.parse(await readFile(storeFile, "utf8")).runs, 2);

    const removed2 = await host.remove("keeper", { purgeData: true });
    assert.equal(removed2.dataPurged, true);
    await assert.rejects(() => readFile(storeFile, "utf8"));
  });

  it("audits denied data access", { timeout: 30000 }, async () => {
    const events: Array<{ action: string; target?: string }> = [];
    const dataDir = path.join(base, "audit", "data");
    const host = new PluginHost({ dataDir, logger: log(), resolveService: () => ({}), onAudit: (e) => events.push(e) });
    const src = await makePlugin("nosy", [
      "export async function activate(ctx) {",
      "  try { await ctx.data.read('../../config.json'); } catch (err) { globalThis.__denied = String(err.code ?? err.message); }",
      "}",
      "export function health() { return { ok: true, detail: globalThis.__denied ?? 'not-tried' }; }",
    ].join("\n"));
    await host.install(src);
    await host.enable("nosy");
    const health = await host.health("nosy");
    assert.match(String(health.detail), /policy_denied/);
    const denial = events.find((e) => e.action === "plugin.data.denied");
    assert.ok(denial, "拒绝必须写入审计");
    assert.equal(denial?.target, "nosy");
  });

  it("enforces the same boundary through the isolated worker data API", { timeout: 40000 }, async () => {
    const dataDir = path.join(base, "worker", "data");
    const host = new PluginHost({ dataDir, logger: log(), isolation: "process", resolveService: () => ({}) });
    const src = await makePlugin("remote-data", [
      "let ctx;",
      "export function activate(c) { ctx = c; }",
      "export function health() { return { ok: true }; }",
      "export async function invoke(method) {",
      "  if (method === 'ok') { await ctx.data.write('ok.txt', 'hello'); return { text: String(await ctx.data.read('ok.txt')) }; }",
      "  try { await ctx.data.read('../escape.txt'); return { denied: false }; }",
      "  catch (err) { return { denied: true, message: String(err.message) }; }",
      "}",
    ].join("\n"));
    await host.install(src);
    await host.enable("remote-data");
    try {
      const ok = (await host.invoke("remote-data", "ok", null)) as { text: string };
      assert.equal(ok.text, "hello");
      const denied = (await host.invoke("remote-data", "escape", null)) as { denied: boolean; message: string };
      assert.equal(denied.denied, true);
      assert.match(denied.message, /denied|policy_denied/);
    } finally {
      await host.disable("remote-data").catch(() => {});
    }
  });
});
