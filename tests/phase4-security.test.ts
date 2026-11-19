/**
 * Phase 4 安全回归（P0-01 / P1-04）：
 *  - API 入口必须拒绝跨源、非 JSON、无令牌的写入
 *  - 绑定非回环地址且无令牌时必须拒绝启动
 *  - 插件必须显式声明特权等级；invoke 必须有超时
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { DshHostAdapter } from "../src/adapters/dsh.ts";
import { createApiServer, type ApiHandle } from "../src/api/server.ts";
import { PurgeApp } from "../src/app.ts";
import { createLogger } from "../src/core/logger.ts";
import { PLUGIN_API_VERSION, PluginHost } from "../src/plugins/host.ts";
import { makeFakeHost } from "./helpers/fixtures.ts";

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

async function post(base: string, p: string, init: { body?: string; contentType?: string; origin?: string; token?: string }) {
  const headers: Record<string, string> = {};
  if (init.contentType) headers["content-type"] = init.contentType;
  if (init.origin) headers.origin = init.origin;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${base}${p}`, { method: "POST", headers, body: init.body });
  return { status: res.status, json: (await res.json()) as Envelope };
}

describe("P0-01: api entry hardening", () => {
  let tmp = "";
  let handle: ApiHandle;
  let base = "";

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "p4-api-sec-"));
    const host = await makeFakeHost(path.join(tmp, "host"), { markerFiles: 0 });
    const app = new PurgeApp({
      dataDir: path.join(tmp, "data"),
      startScheduler: false,
      skipProcessProbe: true,
      adapters: [new DshHostAdapter({ extraRoots: [host.resources], dshHome: host.home, includeDefaults: false, skipProcessProbe: true })],
    });
    handle = createApiServer({ app, host: "127.0.0.1", port: 0 });
    base = await handle.listen();
  });

  after(async () => {
    await handle.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("rejects a text/plain write with 415", async () => {
    const res = await post(base, "/api/config", { body: JSON.stringify({ patch: { port: 7900 }, confirm: true }), contentType: "text/plain" });
    assert.equal(res.status, 415);
    assert.equal(res.json.error?.code, "unsupported_media_type");
  });

  it("rejects a cross-origin JSON write with 403", async () => {
    const res = await post(base, "/api/config", {
      body: JSON.stringify({ patch: { port: 7900 }, confirm: true }),
      contentType: "application/json",
      origin: "https://evil.example",
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error?.message ?? "", /cross-origin/);
  });

  it("accepts a same-origin JSON write", async () => {
    const res = await post(base, "/api/config", {
      body: JSON.stringify({ patch: { port: 7901 }, confirm: true }),
      contentType: "application/json",
      origin: base,
    });
    assert.equal(res.status, 200);
  });

  it("refuses to bind a non-loopback host without a token", async () => {
    const app = new PurgeApp({ dataDir: path.join(tmp, "data2"), startScheduler: false, skipProcessProbe: true, adapters: [] });
    const h = createApiServer({ app, host: "0.0.0.0", port: 0 });
    await assert.rejects(() => h.listen(), /refusing to bind/);
    await app.stop(); // listen() 已 start 过 app，必须回收 DB 句柄再删临时目录
  });

  it("requires a bearer token when one is configured", async () => {
    const dataDir = path.join(tmp, "data3");
    const app = new PurgeApp({ dataDir, startScheduler: false, skipProcessProbe: true, adapters: [] });
    await app.start();
    await app.services.config.update({ apiToken: "s3cret-token" });
    const h = createApiServer({ app, host: "127.0.0.1", port: 0 });
    const url = await h.listen();
    try {
      const noToken = await fetch(`${url}/api/health`);
      assert.equal(noToken.status, 403);
      const wrong = await fetch(`${url}/api/health`, { headers: { authorization: "Bearer nope" } });
      assert.equal(wrong.status, 403);
      const ok = await fetch(`${url}/api/health`, { headers: { authorization: "Bearer s3cret-token" } });
      assert.equal(ok.status, 200);
    } finally {
      await h.close();
    }
  });
});

describe("P1-04: plugin privilege declaration and invoke timeout", () => {
  let base = "";
  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "p4-plugin-sec-"));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const host = (sub: string) =>
    new PluginHost({ dataDir: path.join(base, sub), logger: createLogger({ sink: () => {} }), resolveService: () => ({}) });

  async function makePlugin(name: string, manifestExtra: Record<string, unknown>, entry: string) {
    const dir = path.join(base, `${name}-src`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ name, version: "1.0.0", apiVersion: PLUGIN_API_VERSION, entry: "index.mjs", capabilities: [], ...manifestExtra }),
    );
    await writeFile(path.join(dir, "index.mjs"), entry);
    return dir;
  }

  it("rejects a manifest that does not declare its privilege level", async () => {
    const h = host("a");
    const dir = await makePlugin("no-priv", {}, "export function activate() {}");
    await assert.rejects(() => h.install(dir), /privilege/);
  });

  it("installs a declared host-privilege plugin but requires explicit trust to enable", async () => {
    const h = host("b");
    const dir = await makePlugin(
      "host-priv",
      { privilege: "host" },
      ["export function activate() {}", "export function health() { return { ok: true }; }"].join("\n"),
    );
    const installed = await h.install(dir);
    assert.equal(installed.manifest.privilege, "host");
    await assert.rejects(() => h.enable("host-priv"), /explicit trust/);
    const enabled = await h.enable("host-priv", { trusted: true });
    assert.equal(enabled.state, "enabled");
  });

  it("times out a hanging plugin instead of blocking forever", async () => {
    const h = host("c");
    const dir = await makePlugin(
      "hangs",
      { privilege: "declared" },
      [
        "export function activate() {}",
        "export async function health() { return { ok: true }; }",
        "export async function invoke() { await new Promise((r) => setTimeout(r, 5000)); return 'late'; }",
      ].join("\n"),
    );
    await h.install(dir);
    await h.enable("hangs");
    const t0 = Date.now();
    await assert.rejects(() => h.invoke("hangs", "x", {}, { timeoutMs: 100 }), /timed out/);
    assert.ok(Date.now() - t0 < 2000, "invoke 必须按超时返回");
  });
});
