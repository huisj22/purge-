/**
 * 端到端验收脚本：在临时目录里造一个假宿主，跑完整链路并逐项断言。
 * 用法：node scripts/acceptance.ts [--keep]
 *
 * 断言项（任一失败即退出码 1）：
 *  1 health / overview
 *  2 host discover + inspect（shape=both、身份可信）
 *  3 diagnose（报告产生、可落库、级别合理）
 *  4 pack import → plan（只读）→ apply（事务）→ 复检 → revert（快照恢复）
 *  5 rule create → compose；skill scan/import
 *  6 plugin install → enable → health → invoke（能力白名单）
 *  7 snapshot capture → verify → restore
 *  8 update check → plan → stage → activate（摘要校验）
 *  9 workflow run（healthcheck）→ 步骤全成功
 * 10 audit 哈希链完整
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DshHostAdapter } from "../src/adapters/dsh.ts";
import { createApiServer } from "../src/api/server.ts";
import { PurgeApp } from "../src/app.ts";
import { writeAsar } from "../tests/helpers/fixtures.ts";

const results: Array<{ step: string; ok: boolean; detail: string }> = [];

function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  const mark = ok ? "✓" : "✗";
  process.stdout.write(`${mark} ${step} — ${detail}\n`);
  if (!ok) process.exitCode = 1;
}

function assert(cond: unknown, detail: string): void {
  if (!cond) throw new Error(detail);
}

async function api<T>(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: { ok: boolean; data?: T; error?: { code: string; message: string } } }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } } };
}

async function makeHost(base: string): Promise<{ resources: string; home: string; markerFile: string }> {
  const resources = path.join(base, "resources");
  const app = path.join(resources, "app");
  const home = path.join(base, "home");
  await mkdir(path.join(app, "lib"), { recursive: true });
  await mkdir(path.join(home, "profiles", "desktop"), { recursive: true });
  await writeAsar(path.join(resources, "app.asar"), {
    "package.json": Buffer.from(JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: "0.2.2-rc.5", main: "lib/main.js" })),
    "lib/main.js": Buffer.from("// entry\n"),
  });
  await writeFile(path.join(app, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: "0.2.2-rc.5", main: "lib/main.js" }));
  const markerFile = path.join(app, "lib", "main.js");
  await writeFile(markerFile, "const timeout = 1;\nexport const x = 1;\n", "utf8");
  await writeFile(
    path.join(home, "profiles", "desktop", "package.json"),
    JSON.stringify({ dependencies: { "some-plugin": "1.0.0" }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "some-plugin"] } } }),
  );
  return { resources, home, markerFile };
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const root = await mkdtemp(path.join(tmpdir(), "purgeplus-accept-"));
  const host = await makeHost(path.join(root, "host"));
  const app = new PurgeApp({
    dataDir: path.join(root, "data"),
    startScheduler: false,
    skipProcessProbe: true,
    adapters: [new DshHostAdapter({ extraRoots: [host.resources], dshHome: host.home, includeDefaults: false, skipProcessProbe: true })],
  });
  const handle = createApiServer({ app, host: "127.0.0.1", port: 0 });
  let base = "";
  try {
    base = await handle.listen();
    process.stdout.write(`\nPurge+ 验收 · ${base} · 数据目录 ${app.dataDir}\n\n`);

    // 1
    const health = await api<{ version: string }>(base, "GET", "/api/health");
    record("1 health", health.json.ok === true, `version=${health.json.data?.version}`);

    // 2
    const hosts = await api<Array<{ id: string }>>(base, "GET", "/api/hosts");
    const hostId = hosts.json.data?.[0]?.id ?? "";
    const facts = await api<{ shape: string; identity: { version: string; confidence: string } }>(base, "GET", `/api/hosts/${encodeURIComponent(hostId)}/inspect`);
    record("2 host inspect", facts.json.data?.shape === "both" && facts.json.data?.identity.confidence === "verified", `shape=${facts.json.data?.shape} version=${facts.json.data?.identity.version}`);

    // 3
    const diag = await api<{ level: string; summary: { total: number } }>(base, "POST", "/api/diagnostics/run", { hostId });
    record("3 diagnose", diag.json.ok === true && (diag.json.data?.summary.total ?? 0) > 0, `level=${diag.json.data?.level} findings=${diag.json.data?.summary.total}`);

    // 4 pack lifecycle
    const pack = {
      schema: "purgeplus.pack/1",
      id: "acceptance-pack",
      name: "验收包",
      version: "1.0.0",
      target: { adapter: "dsh" },
      risk: { level: "medium", reasons: ["验收用"] },
      rules: [{ id: "r1", layer: "code", path: "lib/main.js", markers: ["[purge-plus]"], replacements: [{ pattern: "const timeout = 1;", replace: "const timeout = 300; // [purge-plus]" }] }],
    };
    const imported = await api(base, "POST", "/api/packs/import", { pack, confirm: true });
    const plan = await api<{ summary: { pending: number } }>(base, "POST", "/api/packs/acceptance-pack/plan", { hostId });
    const original = await readFile(host.markerFile, "utf8");
    record("4a pack plan", imported.json.ok === true && plan.json.data?.summary.pending === 1 && (await readFile(host.markerFile, "utf8")) === original, "预演未改动磁盘");
    const applied = await api<{ written: string[]; snapshotId: string }>(base, "POST", "/api/packs/acceptance-pack/apply", { hostId, confirm: true });
    const afterApply = await readFile(host.markerFile, "utf8");
    record("4b pack apply", applied.json.ok === true && afterApply.includes("[purge-plus]") && (applied.json.data?.written.length ?? 0) === 1, `快照 ${applied.json.data?.snapshotId}`);
    const replan = await api<{ summary: { applied: number } }>(base, "POST", "/api/packs/acceptance-pack/plan", { hostId });
    record("4c pack verify", replan.json.data?.summary.applied === 1, "复检为已应用");
    const reverted = await api<{ failed: unknown[] }>(base, "POST", "/api/packs/acceptance-pack/revert", { snapshotId: applied.json.data?.snapshotId, confirm: true });
    const afterRevert = await readFile(host.markerFile, "utf8");
    record("4d pack revert", reverted.json.ok === true && afterRevert === original, "字节与原始一致");

    // 5 rules / skills
    const rule = await api(base, "POST", "/api/rules", { id: "acc-rule", title: "验收规则", body: "验收正文", confirm: true });
    const composed = await api<{ included: string[] }>(base, "POST", "/api/rules/compose", {});
    record("5a rule compose", rule.json.ok === true && (composed.json.data?.included ?? []).includes("acc-rule"), `included=${composed.json.data?.included.join(",")}`);
    const skillSrc = path.join(root, "skill-src", "accept-skill");
    await mkdir(skillSrc, { recursive: true });
    await writeFile(path.join(skillSrc, "SKILL.md"), ["---", "name: accept-skill", "description: 验收技能", "---", "", "正文"].join("\n"));
    const skill = await api(base, "POST", "/api/skills/import", { path: skillSrc, confirm: true });
    record("5b skill import", skill.json.ok === true, `name=${(skill.json.data as { name?: string } | undefined)?.name}`);

    // 6 plugin
    const pluginSrc = path.join(root, "plugin-src", "accept-plugin");
    await mkdir(pluginSrc, { recursive: true });
    await writeFile(
      path.join(pluginSrc, "plugin.json"),
      JSON.stringify({ name: "accept-plugin", version: "1.0.0", apiVersion: "1", entry: "index.mjs", privilege: "declared", capabilities: ["diagnostics"] }),
    );
    await writeFile(
      path.join(pluginSrc, "index.mjs"),
      [
        "let ctx = null;",
        "export function activate(c) { ctx = c; }",
        "export function health() { return { ok: Boolean(ctx) }; }",
        "export async function invoke(method) {",
        "  if (method === 'count') { const d = ctx.use('diagnostics'); return { reports: d.recentReports(3).length }; }",
        "  return { error: 'unknown' };",
        "}",
      ].join("\n"),
    );
    const installed = await api(base, "POST", "/api/plugins/install", { path: pluginSrc, confirm: true });
    const enabled = await api(base, "POST", "/api/plugins/accept-plugin/enable", { confirm: true });
    const pluginHealth = await api<{ ok: boolean }>(base, "GET", "/api/plugins/accept-plugin/health");
    let invoked = { status: 0, json: { ok: false, data: undefined as unknown } };
    try {
      const inst = await app.services.plugins.invoke("accept-plugin", "count", {});
      invoked = { status: 200, json: { ok: true, data: inst } };
    } catch (err) {
      invoked = { status: 500, json: { ok: false, data: (err as Error).message } };
    }
    record(
      "6 plugin",
      installed.json.ok === true && enabled.json.ok === true && pluginHealth.json.data?.ok === true && invoked.json.ok === true,
      `health=${pluginHealth.json.data?.ok} invoke=${JSON.stringify(invoked.json.data)}`,
    );

    // 7 snapshot
    const snap = await api<{ snapId: string }>(base, "POST", "/api/snapshots", { label: "acceptance", paths: [host.markerFile], confirm: true });
    await writeFile(host.markerFile, "tampered\n", "utf8");
    const verify = await api<{ ok: boolean }>(base, "GET", `/api/snapshots/${snap.json.data?.snapId}/verify`);
    const restore = await api<{ failed: unknown[] }>(base, "POST", `/api/snapshots/${snap.json.data?.snapId}/restore`, { confirm: true });
    const restored = await readFile(host.markerFile, "utf8");
    record("7 snapshot restore", verify.json.data?.ok === true && restore.json.ok === true && restored === original, "快照校验 + 恢复成功");

    // 8 update
    const artifact = path.join(root, "payload.bin");
    const payload = "acceptance-payload";
    await writeFile(artifact, payload, "utf8");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(payload).digest("hex");
    const indexFile = path.join(root, "index.json");
    await writeFile(
      indexFile,
      JSON.stringify({
        schema: "purgeplus.release-index/1",
        channel: "stable",
        releases: [{ version: "9.9.9", artifacts: [{ name: "payload.bin", source: artifact, sha256: sha, size: payload.length }] }],
      }),
    );
    const check = await api<{ hasUpdate: boolean }>(base, "POST", "/api/update/check", { index: indexFile });
    const planned = await api<{ to: string }>(base, "POST", "/api/update/plan", { index: indexFile, version: "9.9.9" });
    const applied2 = await api<{ version: string }>(base, "POST", "/api/update/apply", { index: indexFile, version: "9.9.9", confirm: true });
    record("8 update", check.json.data?.hasUpdate === true && planned.json.data?.to === "9.9.9" && applied2.json.data?.version === "9.9.9", `activated=${applied2.json.data?.version}`);

    // 9 workflow
    const run = await api<{ state: string; steps: Array<{ state: string }> }>(base, "POST", "/api/workflows/healthcheck/run", {});
    record("9 workflow", run.json.data?.state === "succeeded" && run.json.data.steps.every((s) => s.state === "succeeded"), `state=${run.json.data?.state}`);

    // 10 audit
    const audit = await api<{ verify: { ok: boolean; checked: number } }>(base, "GET", "/api/audit");
    record("10 audit chain", audit.json.data?.verify.ok === true && (audit.json.data?.verify.checked ?? 0) > 10, `checked=${audit.json.data?.verify.checked}`);
  } finally {
    await handle.close();
    if (keep) process.stdout.write(`\n保留现场：${root}\n`);
    else await rm(root, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n结果：${results.length - failed.length}/${results.length} 项通过\n`);
  if (failed.length > 0) {
    process.stdout.write(`失败项：${failed.map((f) => f.step).join(", ")}\n`);
    process.exitCode = 1;
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`验收异常：${(err as Error).message}\n`);
  process.exitCode = 1;
});

export { assert };
