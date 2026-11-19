import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { DshHostAdapter } from "../src/adapters/dsh.ts";
import { createApiServer, type ApiHandle } from "../src/api/server.ts";
import { PurgeApp } from "../src/app.ts";
import { makeFakeHost } from "./helpers/fixtures.ts";

interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function api<T = unknown>(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: ApiResponse<T> }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as ApiResponse<T>;
  return { status: res.status, json };
}

describe("http api", () => {
  let base = "";
  let tmp = "";
  let handle: ApiHandle;
  let app: PurgeApp;

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "purgeplus-api-"));
    const host = await makeFakeHost(path.join(tmp, "host"), { markerFiles: 1 });
    app = new PurgeApp({
      dataDir: path.join(tmp, "data"),
      startScheduler: false,
      skipProcessProbe: true,
      adapters: [
        new DshHostAdapter({ extraRoots: [host.resources], dshHome: host.home, includeDefaults: false, skipProcessProbe: true }),
      ],
    });
    handle = createApiServer({ app, host: "127.0.0.1", port: 0 });
    base = await handle.listen();
  });

  after(async () => {
    await handle.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("serves health and overview with real data", async () => {
    const health = await api<{ version: string; counts: { audit: number } }>(base, "GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.match(health.json.data?.version ?? "", /^\d+\.\d+\.\d+/);

    const overview = await api<{ hosts: Array<{ shape: string }>; audit: { verify: { ok: boolean } } }>(base, "GET", "/api/overview");
    assert.equal(overview.json.data?.hosts.length, 1);
    assert.equal(overview.json.data?.audit.verify.ok, true);
  });

  it("lists hosts and inspects one", async () => {
    const hosts = await api<Array<{ id: string }>>(base, "GET", "/api/hosts");
    assert.equal(hosts.json.data?.length, 1);
    const id = hosts.json.data?.[0]?.id as string;
    const facts = await api<{ identity: { version: string }; shape: string }>(base, "GET", `/api/hosts/${encodeURIComponent(id)}/inspect`);
    assert.equal(facts.status, 200);
    assert.equal(facts.json.data?.identity.version, "0.2.2-rc.1");
    assert.equal(facts.json.data?.shape, "both");
  });

  it("runs diagnostics and lists them", async () => {
    const hosts = await api<Array<{ id: string }>>(base, "GET", "/api/hosts");
    const id = hosts.json.data?.[0]?.id as string;
    const run = await api<{ level: string; summary: { total: number } }>(base, "POST", "/api/diagnostics/run", { hostId: id });
    assert.equal(run.status, 200);
    assert.ok(["ok", "warn", "unknown", "broken"].includes(run.json.data?.level ?? ""));
    const list = await api<{ recent: Array<{ reportId: string }> }>(base, "GET", "/api/diagnostics");
    assert.ok((list.json.data?.recent.length ?? 0) >= 1);
  });

  it("requires confirmation before restoring a snapshot", async () => {
    const hosts = await api<Array<{ id: string }>>(base, "GET", "/api/hosts");
    const id = hosts.json.data?.[0]?.id as string;
    const facts = await api<{ unpacked: { path: string } }>(base, "GET", `/api/hosts/${encodeURIComponent(id)}/inspect`);
    const target = path.join(facts.json.data?.unpacked.path as string, "lib", "main.js");
    const snap = await api<{ snapId: string }>(base, "POST", "/api/snapshots", { label: "api-test", paths: [target], confirm: true });
    assert.equal(snap.status, 200);
    const snapId = snap.json.data?.snapId as string;
    const denied = await api(base, "POST", `/api/snapshots/${snapId}/restore`, {});
    assert.equal(denied.status, 428);
    assert.equal(denied.json.error?.code, "confirmation_required");
    const restored = await api<{ restored: string[] }>(base, "POST", `/api/snapshots/${snapId}/restore`, { confirm: true });
    assert.equal(restored.status, 200);
    assert.equal(restored.json.data?.restored.length, 1);
    const verify = await api<{ ok: boolean }>(base, "GET", `/api/snapshots/${snapId}/verify`);
    assert.equal(verify.json.data?.ok, true);
  });

  it("runs a workflow and exposes the run", async () => {
    const wf = await api<Array<{ id: string }>>(base, "GET", "/api/workflows");
    assert.ok((wf.json.data ?? []).some((w) => w.id === "healthcheck"));
    const run = await api<{ runId: string; state: string }>(base, "POST", "/api/workflows/healthcheck/run", {});
    assert.equal(run.status, 200);
    assert.equal(run.json.data?.state, "succeeded");
    const detail = await api<{ steps: Array<{ stepId: string; state: string }> }>(base, "GET", `/api/runs/${run.json.data?.runId}`);
    assert.equal(detail.json.data?.steps.length, 2);
    assert.ok(detail.json.data?.steps.every((s) => s.state === "succeeded"));
  });

  it("creates and pauses a scheduled job with confirmation", async () => {
    const noConfirm = await api(base, "POST", "/api/jobs", {
      id: "nightly",
      kind: "workflow",
      payload: { workflowId: "healthcheck" },
      schedule: { type: "cron", expr: "0 3 * * *" },
    });
    assert.equal(noConfirm.status, 428, "job creation must require confirmation");
    const created = await api<{ id: string; nextRunMs: number }>(base, "POST", "/api/jobs", {
      id: "nightly",
      kind: "workflow",
      payload: { workflowId: "healthcheck" },
      schedule: { type: "cron", expr: "0 3 * * *" },
      confirm: true,
    });
    assert.equal(created.status, 200);
    assert.ok((created.json.data?.nextRunMs ?? 0) > Date.now());
    const paused = await api<{ state: string }>(base, "POST", "/api/jobs/nightly/pause");
    assert.equal(paused.json.data?.state, "paused");
    const jobs = await api<Array<{ id: string; state: string }>>(base, "GET", "/api/jobs");
    assert.equal(jobs.json.data?.[0]?.state, "paused");
  });

  it("evaluates policy and returns explainable factors", async () => {
    const verdict = await api<{ decision: string; risk: number; factors: Array<{ code: string }> }>(base, "POST", "/api/policy", {
      action: "files.delete",
      paths: Array.from({ length: 30 }, (_, i) => `p${i}`),
      recursive: true,
    });
    assert.equal(verdict.json.data?.decision, "deny");
    assert.ok((verdict.json.data?.factors.length ?? 0) > 0);
  });

  it("keeps the audit chain valid after mutating calls", async () => {
    const audit = await api<{ verify: { ok: boolean; checked: number }; entries: Array<{ action: string }> }>(base, "GET", "/api/audit");
    assert.equal(audit.json.data?.verify.ok, true);
    assert.ok((audit.json.data?.verify.checked ?? 0) > 0);
    assert.ok((audit.json.data?.entries ?? []).some((e) => e.action === "snapshot.capture"));
  });

  it("returns 404 for unknown routes and 400 for bad bodies", async () => {
    const missing = await api(base, "GET", "/api/nope");
    assert.equal(missing.status, 404);
    const bad = await api(base, "POST", "/api/policy", { action: 42 });
    assert.equal(bad.status, 200, "policy evaluate accepts a partial body");
  });

  it("blocks static path traversal", async () => {
    const res = await fetch(`${base}/../package.json`);
    assert.ok([403, 404].includes(res.status), `status ${res.status}`);
  });

  it("imports, plans, applies and reverts a modification pack", async () => {
    const hosts = await api<Array<{ id: string }>>(base, "GET", "/api/hosts");
    const hostId = hosts.json.data?.[0]?.id as string;
    const pack = {
      schema: "purgeplus.pack/1",
      id: "api-demo",
      name: "API 演示包",
      version: "0.1.0",
      target: { adapter: "dsh" },
      risk: { level: "medium", reasons: ["演示用"] },
      rules: [
        {
          id: "r1",
          layer: "code",
          path: "lib/main.js",
          markers: ["[purge-plus]"],
          replacements: [{ pattern: "// entry", replace: "// entry [purge-plus]" }],
        },
      ],
    };
    const imported = await api<{ id: string; hash: string }>(base, "POST", "/api/packs/import", { pack, confirm: true });
    assert.equal(imported.status, 200);
    assert.equal(imported.json.data?.id, "api-demo");

    const plan = await api<{ summary: { pending: number }; entries: Array<{ status: string; path: string }> }>(
      base,
      "POST",
      "/api/packs/api-demo/plan",
      { hostId },
    );
    assert.equal(plan.json.data?.summary.pending, 1);

    const refused = await api(base, "POST", "/api/packs/api-demo/apply", { hostId });
    assert.equal(refused.status, 428, "apply must require confirmation");
    const applied = await api<{ written: string[]; snapshotId: string }>(base, "POST", "/api/packs/api-demo/apply", { hostId, confirm: true });
    assert.equal(applied.status, 200);
    assert.equal(applied.json.data?.written.length, 1);

    const replanned = await api<{ summary: { applied: number; pending: number } }>(base, "POST", "/api/packs/api-demo/plan", { hostId });
    assert.equal(replanned.json.data?.summary.applied, 1);
    assert.equal(replanned.json.data?.summary.pending, 0);

    const reverted = await api<{ restored: string[]; failed: unknown[] }>(base, "POST", "/api/packs/api-demo/revert", {
      snapshotId: applied.json.data?.snapshotId,
      confirm: true,
    });
    assert.equal(reverted.status, 200);
    assert.deepEqual(reverted.json.data?.failed, []);
    const afterRevert = await api<{ summary: { pending: number } }>(base, "POST", "/api/packs/api-demo/plan", { hostId });
    assert.equal(afterRevert.json.data?.summary.pending, 1, "revert must restore the pre-apply bytes");
  });

  it("rejects packs whose replacement text has no marker", async () => {
    const bad = {
      schema: "purgeplus.pack/1",
      id: "bad-pack",
      name: "bad",
      version: "1.0.0",
      target: { adapter: "dsh" },
      risk: { level: "low", reasons: [] },
      rules: [{ id: "r", layer: "code", path: "lib/main.js", markers: ["[purge-plus]"], replacements: [{ pattern: "a", replace: "b" }] }],
    };
    const res = await api(base, "POST", "/api/packs/import", { pack: bad, confirm: true });
    assert.equal(res.status, 400);
    assert.equal(res.json.error?.code, "schema_invalid");
  });

  it("manages rules and composes them by workspace", async () => {
    const created = await api<{ id: string; version: number }>(base, "POST", "/api/rules", {
      id: "style",
      title: "代码风格",
      body: "用 4 空格缩进",
      confirm: true,
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.data?.version, 1);

    const ws = path.join(tmp, "workspace");
    await api(base, "POST", "/api/rules", {
      id: "proj",
      title: "项目规则",
      body: "只用 ESM",
      scope: { kind: "workspace", path: ws },
      confirm: true,
    });

    const composedIn = await api<{ included: string[]; text: string }>(base, "POST", "/api/rules/compose", { workspace: path.join(ws, "sub") });
    assert.deepEqual(composedIn.json.data?.included, ["proj", "style"]);
    assert.match(composedIn.json.data?.text ?? "", /只用 ESM/);

    const composedOut = await api<{ included: string[] }>(base, "POST", "/api/rules/compose", { workspace: path.join(tmp, "elsewhere") });
    assert.deepEqual(composedOut.json.data?.included, ["style"]);

    const disabled = await api<{ enabled: boolean }>(base, "POST", "/api/rules/style/disable", { confirm: true });
    assert.equal(disabled.json.data?.enabled, false);
    const afterDisable = await api<{ included: string[] }>(base, "POST", "/api/rules/compose", {});
    assert.ok(!(afterDisable.json.data?.included ?? []).includes("style"));

    const removed = await api(base, "DELETE", "/api/rules/proj");
    assert.equal(removed.status, 200);
    const list = await api<Array<{ id: string }>>(base, "GET", "/api/rules");
    assert.deepEqual(list.json.data?.map((r) => r.id), ["style"]);
  });

  it("rejects invalid rules with a typed error", async () => {
    const bad = await api(base, "POST", "/api/rules", { id: "Bad Id", title: "x", body: "y", confirm: true });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error?.code, "schema_invalid");
  });

  it("imports, lists and removes skills", async () => {
    const src = path.join(tmp, "skill-src", "demo-skill");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "SKILL.md"), ["---", "name: demo-skill", "description: 演示技能", "---", "", "正文"].join("\n"));
    await writeFile(path.join(src, "run.sh"), "echo hi");

    const scanned = await api<Array<{ name: string; warnings: Array<{ code: string }> }>>(
      base,
      "GET",
      `/api/skills/scan?root=${encodeURIComponent(path.join(tmp, "skill-src"))}`,
    );
    assert.equal(scanned.json.data?.[0]?.name, "demo-skill");
    assert.ok((scanned.json.data?.[0]?.warnings ?? []).some((w) => w.code === "executable_content"));

    const imported = await api<{ name: string }>(base, "POST", "/api/skills/import", { path: src, confirm: true });
    assert.equal(imported.json.data?.name, "demo-skill");
    const list = await api<Array<{ name: string }>>(base, "GET", "/api/skills");
    assert.deepEqual(list.json.data?.map((s) => s.name), ["demo-skill"]);

    const removed = await api(base, "POST", `/api/skills/demo-skill/remove`, {});
    assert.equal(removed.status, 200);
    const after = await api<Array<unknown>>(base, "GET", "/api/skills");
    assert.deepEqual(after.json.data, []);
  });

  it("serves the ui shell and its assets", async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /Purge\+/);
    assert.match(html, /app\.js/);

    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.ok((await js.text()).includes("/api/overview"));

    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  });

  it("refuses oversized bodies", async () => {
    const big = { action: "x", pad: "a".repeat(2 * 1024 * 1024) };
    const res = await fetch(`${base}/api/policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(big),
    });
    assert.equal(res.status, 400);
    const json = (await res.json()) as ApiResponse;
    assert.equal(json.error?.code, "invalid_argument");
  });
});
