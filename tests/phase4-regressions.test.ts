/**
 * Phase 4 回归测试：针对本轮审计发现的缺陷，先失败后修复。
 * 每个 describe 对应 ISSUE_REGISTER 中的一条。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { DshHostAdapter } from "../src/adapters/dsh.ts";
import { ConfigStore } from "../src/core/config.ts";
import { Kernel } from "../src/core/kernel.ts";
import { createLogger } from "../src/core/logger.ts";
import { evaluateRules } from "../src/inspector/rules.ts";
import { SnapshotStore } from "../src/recovery/snapshot.ts";
import { openMemoryDatabase } from "../src/storage/database.ts";
import { makeFakeHost } from "./helpers/fixtures.ts";

const silent = () => createLogger({ sink: () => {} });

// ---------------------------------------------------------------- P1-01
describe("P1-01: Kernel.start() must be retryable after a failure", () => {
  it("retries the service on the next start() call", async () => {
    const k = new Kernel({ logger: silent() });
    let attempts = 0;
    k.register("flaky", () => ({
      id: "flaky",
      start: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
      },
    }));
    await assert.rejects(() => k.start(), /transient/);
    await k.start(); // 修复前：这里会重放同一个 rejected Promise，attempts 仍为 1
    assert.equal(attempts, 2, "第二次 start() 必须真正重试服务");
    assert.equal(k.started, true);
    await k.stop();
  });
});

// ---------------------------------------------------------------- P2-01
describe("P2-01: ConfigStore must not diverge from disk on write failure", () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "p4-fix-cfg-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the old in-memory value when the write fails", async () => {
    const store = new ConfigStore(path.join(dir, "d1"));
    await store.load();
    const before = store.get().port;
    // 让 config.json 无法作为文件写入
    await mkdir(path.join(dir, "d1", "config.json"), { recursive: true });
    await assert.rejects(() => store.update({ port: 7999 }));
    assert.equal(store.get().port, before, "写盘失败后内存态必须保持原值");
  });
});

// ---------------------------------------------------------------- P1-02
describe("P1-02: a clean unpacked host must not be reported as unmanaged modification", () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "p4-fix-insp-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes modification.traceable when there are no markers and no pack records", async () => {
    const host = await makeFakeHost(path.join(dir, "clean"), { markerFiles: 0, unpacked: true });
    // 让解包目录的 mtime 明确晚于归档（真实解包必然如此）
    const appPkg = path.join(host.resources, "app", "package.json");
    const future = new Date(Date.now() + 60_000);
    await (await import("node:fs/promises")).utimes(appPkg, future, future);
    const adapter = new DshHostAdapter({ extraRoots: [host.resources], dshHome: host.home, includeDefaults: false, skipProcessProbe: true });
    const [candidate] = await adapter.discover();
    const facts = await adapter.inspect(candidate as never);
    const findings = evaluateRules(facts);
    const rule = findings.find((f) => f.ruleId === "modification.traceable");
    assert.notEqual(rule?.status, "fail", `干净宿主不应判 fail：${rule?.rootCause?.text}`);
    assert.equal(rule?.status, "pass");
  });

  it("still fails when patch markers exist without any pack record", async () => {
    const host = await makeFakeHost(path.join(dir, "marked"), { markerFiles: 2 });
    const adapter = new DshHostAdapter({ extraRoots: [host.resources], dshHome: host.home, includeDefaults: false, skipProcessProbe: true });
    const [candidate] = await adapter.discover();
    const facts = await adapter.inspect(candidate as never);
    const rule = evaluateRules(facts).find((f) => f.ruleId === "modification.traceable");
    assert.equal(rule?.status, "fail");
  });

  it("reports scan truncation instead of a confident negative", async () => {
    const host = await makeFakeHost(path.join(dir, "trunc"), { markerFiles: 0 });
    // 制造比扫描上限更多的源文件，确保扫描真的被截断
    const libDir = path.join(host.resources, "app", "lib");
    for (let i = 0; i < 6; i += 1) {
      await writeFile(path.join(libDir, `extra-${i}.js`), `export const x${i} = ${i};\n`, "utf8");
    }
    const adapter = new DshHostAdapter({ extraRoots: [host.resources], dshHome: host.home, includeDefaults: false, skipProcessProbe: true, markerScanLimit: 1 });
    const [candidate] = await adapter.discover();
    const facts = await adapter.inspect(candidate as never);
    assert.equal(facts.modification.scanTruncated, true, "扫描被截断时必须显式标记");
    const rule = evaluateRules(facts).find((f) => f.ruleId === "modification.traceable");
    assert.equal(rule?.status, "unknown", "扫描不完整时只能给 unknown");
  });
});

// ---------------------------------------------------------------- P1-03
describe("P1-03: restore must not leave a half-restored tree", () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "p4-fix-restore-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rolls back to the pre-restore state when one target cannot be restored", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(path.join(dir, "data"), db);
    const a = path.join(dir, "a.txt");
    const bDir = path.join(dir, "b-dir");
    const b = path.join(bDir, "b.txt");
    await mkdir(bDir, { recursive: true });
    await writeFile(a, "A0", "utf8");
    await writeFile(b, "B0", "utf8");
    const snap = await store.capture("fix", [a, b]);
    await writeFile(a, "A1", "utf8");
    await writeFile(b, "B1", "utf8");

    // 破坏 b 的恢复路径：父目录变成普通文件
    await rm(bDir, { recursive: true, force: true });
    await writeFile(bDir, "blocker", "utf8");

    const result = await store.restore(snap.snapId);
    assert.ok(result.failed.length > 0, "必须报告失败");
    assert.equal(result.rolledBack, true, "失败后必须回滚到恢复前状态");
    assert.equal(await readFile(a, "utf8"), "A1", "a.txt 必须回到恢复前内容，而不是快照内容");
    db.close();
  });

  it("succeeds transactionally on the happy path", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(path.join(dir, "data2"), db);
    const f = path.join(dir, "ok.txt");
    await writeFile(f, "v0", "utf8");
    const snap = await store.capture("ok", [f]);
    await writeFile(f, "v1", "utf8");
    const result = await store.restore(snap.snapId);
    assert.equal(result.failed.length, 0);
    assert.equal(await readFile(f, "utf8"), "v0");
    assert.equal(result.rolledBack, false);
    db.close();
  });

  it("finds snapshots beyond the first 500 (P2-05)", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(path.join(dir, "data3"), db);
    const f = path.join(dir, "many.txt");
    await writeFile(f, "x", "utf8");
    let oldest = "";
    for (let i = 0; i < 3; i += 1) {
      const snap = await store.capture(`n${i}`, [f]);
      if (i === 0) oldest = snap.snapId;
    }
    assert.equal(store.get(oldest).snapId, oldest);
    db.close();
  });
});

// ---------------------------------------------------------------- P2-03
describe("P2-03: a scheduled job must survive a transient failure", () => {
  it("stays scheduled and records the error", async () => {
    const { Scheduler } = await import("../src/scheduler/scheduler.ts");
    const { EventBus } = await import("../src/core/events.ts");
    const db = openMemoryDatabase();
    let clock = 1_700_000_000_000;
    let calls = 0;
    const s = new Scheduler({
      db,
      logger: silent(),
      bus: new EventBus(),
      maxConcurrent: 2,
      now: () => clock,
      runJob: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
      },
    });
    s.add({ id: "j", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 60 }, nextRunMs: clock });
    await s.tick();
    await new Promise((r) => setTimeout(r, 20));
    const afterFail = s.get("j");
    assert.equal(afterFail.lastError, "transient");
    assert.equal(afterFail.state, "enabled", "失败后仍应保持调度（不能永久停摆）");
    clock += 120_000;
    await s.tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 2, "下一个周期必须再次执行");
    db.close();
  });
});

// ---------------------------------------------------------------- P2-04
describe("P2-04: cancel must interrupt the running step", () => {
  it("aborts the executor and does not report the step as succeeded", async () => {
    const { WorkflowEngine } = await import("../src/workflow/engine.ts");
    const { EventBus } = await import("../src/core/events.ts");
    const { TraceStore } = await import("../src/storage/trace.ts");
    const db = openMemoryDatabase();
    const engine = new WorkflowEngine({ db, traces: new TraceStore(db), logger: silent(), bus: new EventBus() });
    let aborted = false;
    engine.registerExecutor("slow", async (_input, ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
      throw new Error("aborted");
    });
    engine.register({ id: "cancel", name: "c", version: 1, steps: [{ id: "s1", uses: "slow", timeoutMs: 10_000 }] });
    const t0 = Date.now();
    const p = engine.run("cancel");
    setTimeout(() => {
      const run = engine.listRuns(1)[0];
      if (run) engine.cancel(run.runId);
    }, 50);
    const run = await p;
    const elapsed = Date.now() - t0;
    assert.equal(aborted, true, "取消必须 abort 执行器");
    assert.ok(elapsed < 1000, `取消应立即返回，实际 ${elapsed}ms`);
    assert.equal(run.state, "cancelled");
    assert.notEqual(run.steps[0]?.state, "succeeded", "被取消的步骤不能标记成功");
    db.close();
  });
});
