/**
 * T055-01 写入口闭合测试：
 *  - snapshot.prune 与 capture 并发（真实子进程）不破坏快照
 *  - snapshot.prune 保留无法识别为哈希的对象（UNKNOWN 不删除）
 *  - update.prune 保护 active / 最新 / 最少保留数量 / 未知目录
 *  - PackStore 并发导入不丢 index 条目（真实子进程）
 *  - plugin enable 在外部持锁时被阻止
 *  - audit.prune 保留策略 + 裁剪后链仍可验证 + 并发 append 不产生空洞
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLogger } from "../src/core/logger.ts";
import { PackStore } from "../src/packs/store.ts";
import { PluginHost, PLUGIN_API_VERSION } from "../src/plugins/host.ts";
import { SnapshotStore } from "../src/recovery/snapshot.ts";
import { AuditLog } from "../src/storage/audit.ts";
import { openDatabase, openMemoryDatabase } from "../src/storage/database.ts";
import { UpdateService } from "../src/update/service.ts";

const LOCK_MODULE = new URL("../src/core/lock.ts", import.meta.url).href;
let base = "";
before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "p5.5-t1-"));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = () => createLogger({ sink: () => {} });

async function holdGlobal(dataDir: string, holdMs: number): Promise<void> {
  const script = path.join(base, `hold-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mjs`);
  await writeFile(
    script,
    `import { FileLock } from ${JSON.stringify(LOCK_MODULE)};
const lock = new FileLock({ dataDir: process.argv[2], resource: "global", operation: "child" });
const r = await lock.acquire();
console.log("STATE " + r.state);
if (r.state !== "ACQUIRED") process.exit(1);
console.log("HELD");
await new Promise((res) => setTimeout(res, Number(process.argv[3])));
await lock.release();
console.log("RELEASED");
`,
    "utf8",
  );
  const child = spawn(process.execPath, [script, dataDir, String(holdMs)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (out.includes("HELD")) return;
    await sleep(20);
  }
  throw new Error(`child did not hold global: ${out}`);
}

describe("T055-01 snapshot object GC", () => {
  it("does not corrupt snapshots when capture runs in another process during prune", { timeout: 60000 }, async () => {
    const dataDir = path.join(base, "gc", "data");
    const targets = path.join(base, "gc", "targets");
    await mkdir(targets, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, "purgeplus.db");
    openDatabase(dbFile).close();

    const captureScript = path.join(base, "capture-loop.mjs");
    await writeFile(
      captureScript,
      `import { openDatabase } from ${JSON.stringify(new URL("../src/storage/database.ts", import.meta.url).href)};
import { SnapshotStore } from ${JSON.stringify(new URL("../src/recovery/snapshot.ts", import.meta.url).href)};
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
const [dataDir, dbFile, targets, rounds] = process.argv.slice(2);
const db = openDatabase(dbFile);
const store = new SnapshotStore(dataDir, db);
for (let i = 0; i < Number(rounds); i += 1) {
  const f = path.join(targets, "f" + i + ".txt");
  await writeFile(f, "content-" + i + "-" + "x".repeat(200));
  // 并发 GC 会持锁：capture 允许有限重试，重试耗尽才算真失败
  for (let attempt = 0; ; attempt += 1) {
    try { await store.capture("loop-" + i, [f]); break; }
    catch (err) { if (!/conflict/.test(String(err && err.code)) || attempt >= 50) throw err; await new Promise((r) => setTimeout(r, 20)); }
  }
}
console.log("DONE");
db.close();
`,
      "utf8",
    );

    const child = spawn(process.execPath, [captureScript, dataDir, dbFile, targets, "14"], { stdio: ["ignore", "pipe", "pipe"] });
    let childOut = "";
    child.stdout.on("data", (d: Buffer) => (childOut += d.toString()));
    child.stderr.on("data", (d: Buffer) => (childOut += d.toString()));

    const db = openDatabase(dbFile);
    const store = new SnapshotStore(dataDir, db);
    let prunes = 0;
    let conflicts = 0;
    // 与 capture 并发地反复 GC：锁生效时 prune 可能被拒（conflict），这本身是正确行为；
    // 断言重点是：无论竞争结果如何，都不能破坏任何快照。
    const childExit = new Promise((r) => child.once("close", r));
    while (!childOut.includes("DONE") && child.exitCode === null) {
      try {
        await store.prune();
        prunes += 1;
      } catch (err) {
        if ((err as { code?: string }).code !== "conflict") throw err;
        conflicts += 1;
      }
      await sleep(10);
    }
    await childExit;
    assert.match(childOut, /DONE/, `子进程应完成：${childOut}`);

    const records = store.list(200);
    assert.ok(records.length >= 14, `应保留全部快照记录，实际 ${records.length}`);
    let verified = 0;
    for (const rec of records) {
      const v = await store.verify(rec.snapId);
      assert.equal(v.ok, true, `快照 ${rec.snapId} 被 GC 破坏：${v.issues.join(";")}`);
      verified += 1;
    }
    db.close();
    assert.ok(prunes + conflicts > 0, "prune 至少尝试过一次");
    assert.equal(verified, records.length);
  });

  it("keeps files whose names are not content hashes (UNKNOWN is never deleted)", { timeout: 20000 }, async () => {
    const dataDir = path.join(base, "gc-unknown", "data");
    const db = openMemoryDatabase();
    const store = new SnapshotStore(dataDir, db);
    const unknown = path.join(dataDir, "objects", "zz", "not-a-hash.bin");
    await mkdir(path.dirname(unknown), { recursive: true });
    await writeFile(unknown, "keep-me", "utf8");
    const result = await store.prune();
    assert.equal(result.removed, 0);
    assert.equal(await readFile(unknown, "utf8"), "keep-me");
    db.close();
  });
});

describe("T055-01 update prune", () => {
  it("protects the active version, the newest version and keeps at least two", { timeout: 30000 }, async () => {
    const dataDir = path.join(base, "upd", "data");
    const versions = path.join(dataDir, "update", "versions");
    for (const v of ["1.0.0", "1.1.0", "1.2.0", "2.0.0", "2.1.0"]) {
      await mkdir(path.join(versions, v), { recursive: true });
      await writeFile(path.join(versions, v, "marker.txt"), v, "utf8");
    }
    await mkdir(path.join(versions, "corrupt-dir"), { recursive: true });
    await writeFile(path.join(dataDir, "update", "state.json"), JSON.stringify({ activeVersion: "1.2.0" }), "utf8");

    const svc = new UpdateService({ dataDir, currentVersion: "1.2.0", logger: log() } as never);
    const result = await svc.prune(2);
    const remaining = (await readdir(versions)).sort();
    assert.ok(remaining.includes("1.2.0"), "活跃版本必须保留");
    assert.ok(remaining.includes("2.1.0"), "最新版本必须保留");
    assert.ok(remaining.includes("corrupt-dir"), "无法识别的目录必须保留（UNKNOWN）");
    assert.ok(remaining.length >= 3, `最少保留 2 个版本 + UNKNOWN，实际 ${remaining.join(",")}`);
    assert.ok(result.removed.length > 0, "应当清理掉最旧的版本");
    assert.ok(!result.removed.includes("1.2.0"));
    assert.ok(!result.removed.includes("2.1.0"));
  });
});

describe("T055-01 pack store concurrency", () => {
  it("does not lose index entries when two processes import at the same time", { timeout: 40000 }, async () => {
    const dataDir = path.join(base, "packs", "data");
    await mkdir(dataDir, { recursive: true });
    const script = path.join(base, "import-pack.mjs");
    await writeFile(
      script,
      `import { PackStore } from ${JSON.stringify(new URL("../src/packs/store.ts", import.meta.url).href)};
const store = new PackStore(process.argv[2]);
const id = process.argv[3];
for (let i = 0; i < 6; i += 1) {
  await store.importPack({
    schema: "purgeplus.pack/1", id: id + "-" + i, name: "p" + i, version: "1.0.0",
    target: { adapter: "dsh" }, risk: { level: "low", reasons: ["x"] },
    rules: [{ id: "r", layer: "code", path: "a.txt", markers: ["M"], replacements: [{ pattern: "M", replace: "M", expect: 1 }] }],
  }, "test");
}
console.log("DONE");
`,
      "utf8",
    );
    const run = (id: string) =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [script, dataDir, id], { stdio: ["ignore", "pipe", "pipe"] });
        let err = "";
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        child.on("close", (code) => {
          if (err) process.stderr.write(err);
          resolve(code ?? -1);
        });
      });
    const codes = await Promise.all([run("a"), run("b"), run("c")]);
    assert.deepEqual(codes, [0, 0, 0]);
    const store = new PackStore(dataDir);
    const list = await store.list();
    assert.equal(list.length, 18, `三个进程各导入 6 个，应全部保留（实际 ${list.length}）`);
  });
});

describe("T055-01 plugin state lock", () => {
  it("blocks plugin enable while another process holds the global lock", { timeout: 30000 }, async () => {
    const dataDir = path.join(base, "plugin", "data");
    const src = path.join(base, "plugin", "src");
    await mkdir(src, { recursive: true });
    await writeFile(
      path.join(src, "plugin.json"),
      JSON.stringify({ name: "lock-demo", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, entry: "index.mjs", privilege: "declared", capabilities: [] }),
    );
    await writeFile(path.join(src, "index.mjs"), "export function activate() {}\n");
    const host = new PluginHost({ dataDir, logger: log(), resolveService: () => ({}) });
    await host.install(src);

    // 有界等待语义：外部持锁期间 enable 会等待而不是立刻失败；
    // 断言重点是"不会在对方持锁期间完成写入"，因此检查开始时间。
    await holdGlobal(dataDir, 2000); // 该函数在子进程真正持锁后才返回
    const started = Date.now();
    const enabled = await host.enable("lock-demo");
    const elapsed = Date.now() - started;
    assert.equal(enabled.state, "enabled");
    assert.ok(elapsed >= 1500, `必须等外部锁释放后才写入（实际 ${elapsed}ms）`);
    const state = JSON.parse(await readFile(path.join(dataDir, "plugin-state.json"), "utf8"));
    assert.equal(state.plugins.find((p: { name: string }) => p.name === "lock-demo").enabled, true);
  });
});

describe("T055-01 audit prune", () => {
  it("keeps the tail, records a checkpoint and keeps the chain verifiable", { timeout: 20000 }, async () => {
    const db = openMemoryDatabase();
    const audit = new AuditLog(db);
    for (let i = 0; i < 20; i += 1) audit.append({ actor: "a", action: "op", risk: 0, detail: { i } });
    assert.equal(audit.count(), 20);

    const first = audit.prune({ keepLast: 5, actor: "ops", reason: "retention" });
    assert.equal(first.removed, 15);
    assert.equal(audit.verify().ok, true);
    const cp = audit.lastCheckpoint();
    assert.ok(cp);
    assert.equal(cp?.prunedUpToSeq, 15);

    // 再次裁剪仍保持可验证
    audit.prune({ keepLast: 3, actor: "ops" });
    assert.equal(audit.verify().ok, true);
    const seqs = (db.raw.prepare("SELECT seq FROM audit ORDER BY seq").all() as unknown as Array<{ seq: number }>).map((r) => r.seq);
    assert.ok(seqs.length >= 3);
    // 没有空洞：相邻差为 1
    for (let i = 1; i < seqs.length; i += 1) {
      assert.equal((seqs[i] as number) - (seqs[i - 1] as number), 1, "裁剪后不得出现序列空洞");
    }
    db.close();
  });

  it("detects a hole that has no prune checkpoint", { timeout: 20000 }, async () => {
    const db = openMemoryDatabase();
    const audit = new AuditLog(db);
    for (let i = 0; i < 6; i += 1) audit.append({ actor: "a", action: "op", risk: 0 });
    // 直接删掉最老的两条（模拟外部篡改/误删），不留 checkpoint
    db.raw.prepare("DELETE FROM audit WHERE seq <= 2").run();
    const v = audit.verify();
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /gap with no prune checkpoint/);
    db.close();
  });

  it("keeps the chain valid when appends race with prune", { timeout: 45000 }, async () => {
    const dataDir = path.join(base, "audit-race", "data");
    await mkdir(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, "purgeplus.db");
    openDatabase(dbFile).close();
    const script = path.join(base, "append-loop.mjs");
    await writeFile(
      script,
      `import { openDatabase } from ${JSON.stringify(new URL("../src/storage/database.ts", import.meta.url).href)};
import { AuditLog } from ${JSON.stringify(new URL("../src/storage/audit.ts", import.meta.url).href)};
const db = openDatabase(process.argv[2]);
const audit = new AuditLog(db);
for (let i = 0; i < Number(process.argv[3]); i += 1) {
  for (let attempt = 0; ; attempt += 1) {
    try { audit.append({ actor: process.argv[4], action: "race.append", risk: 0 }); break; }
    catch (err) { if (!/SQLITE_BUSY|database is locked/i.test(String(err && err.message)) || attempt >= 20) throw err; }
  }
}
console.log("DONE");
db.close();
`,
      "utf8",
    );
    const children = ["w1", "w2"].map((name) => spawn(process.execPath, [script, dbFile, "10", name], { stdio: ["ignore", "pipe", "pipe"] }));
    const childOut: string[] = ["", ""];
    children.forEach((c, i) => {
      c.stdout?.on("data", (d: Buffer) => (childOut[i] += d.toString()));
      c.stderr?.on("data", (d: Buffer) => (childOut[i] += d.toString()));
    });
    const db = openDatabase(dbFile);
    const audit = new AuditLog(db);
    let pruned = 0;
    let busy = 0;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && childOut.some((o) => !o.includes("DONE"))) {
      try {
        const r = audit.prune({ keepLast: 8, actor: "ops" });
        if (r.removed > 0) pruned += 1;
      } catch (err) {
        if (!/SQLITE_BUSY|database is locked/i.test(String((err as Error).message))) throw err;
        busy += 1;
      }
      await sleep(15);
    }
    // 子进程可能已经退出：先检查 exitCode，避免错过 close 事件导致永久等待
    await Promise.all(children.map((c) => waitExit(c)));
    assert.deepEqual(childOut.map((o) => o.includes("DONE")), [true, true], `写进程应完成：${childOut.join(" | ")}`);
    const v = audit.verify();
    assert.equal(v.ok, true, `裁剪与并发追加不得破坏链：${v.reason ?? ""}`);
    assert.ok(pruned + busy > 0, "至少发生过一次裁剪尝试");
    const seqs = (db.raw.prepare("SELECT seq FROM audit ORDER BY seq").all() as unknown as Array<{ seq: number }>).map((r) => r.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      assert.equal((seqs[i] as number) - (seqs[i - 1] as number), 1, "裁剪后不得出现序列空洞");
    }
    db.close();
  });
});
function waitExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}