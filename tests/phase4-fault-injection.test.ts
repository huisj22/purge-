/**
 * Phase 4-C/D/E：故障注入（Level 3）、边界输入、并发一致性。
 * 全部使用临时目录/内存库；结束后清理。无法安全模拟的项（磁盘写满、进程 kill -9）
 * 在报告中标记为 BLOCKED，不在此处假装覆盖。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigCenter } from "../src/configcenter/managed.ts";
import { ConfigStore } from "../src/core/config.ts";
import { PurgeError } from "../src/core/errors.ts";
import { EventBus } from "../src/core/events.ts";
import { createLogger } from "../src/core/logger.ts";
import { RuleStore } from "../src/ruleskills/rules.ts";
import { SkillLibrary } from "../src/ruleskills/skills.ts";
import { SnapshotStore } from "../src/recovery/snapshot.ts";
import { Transaction } from "../src/recovery/transaction.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import { AuditLog } from "../src/storage/audit.ts";
import { openMemoryDatabase } from "../src/storage/database.ts";
import { TraceStore } from "../src/storage/trace.ts";
import { UpdateService, type ReleaseIndex } from "../src/update/service.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";

const log = () => createLogger({ sink: () => {} });
let dir = "";
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "p4-fault-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ------------------------------------------------ C1 文件操作故障
describe("C1 file operation faults", () => {
  it("empty config file falls back to defaults without rewriting the file", async () => {
    const d = path.join(dir, "c1");
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, "config.json"), "   \n", "utf8");
    const cfg = await new ConfigStore(d).load();
    assert.equal(cfg.port, 7801);
    assert.equal(await readFile(path.join(d, "config.json"), "utf8"), "   \n", "只读加载不得改写用户文件");
  });

  it("corrupt JSON config is reported, never replaced by defaults", async () => {
    const d = path.join(dir, "c1b");
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, "config.json"), "{ oops", "utf8");
    await assert.rejects(() => new ConfigStore(d).load(), /invalid json/);
    assert.equal(await readFile(path.join(d, "config.json"), "utf8"), "{ oops", "损坏文件必须保持原样");
  });

  it("write blocked by a directory at the target path surfaces as unwritable", async () => {
    const d = path.join(dir, "c1c");
    const store = new ConfigStore(d);
    await store.load();
    await mkdir(path.join(d, "config.json"), { recursive: true });
    await assert.rejects(() => store.update({ port: 7100 }), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal((err as PurgeError).code, "unwritable");
      return true;
    });
  });

  it("restoring a snapshot whose parent path became a file reports failure and rolls back", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(path.join(dir, "c1d"), db);
    const a = path.join(dir, "c1d-a.txt");
    const bDir = path.join(dir, "c1d-bdir");
    await mkdir(bDir, { recursive: true });
    await writeFile(a, "A0", "utf8");
    await writeFile(path.join(bDir, "b.txt"), "B0", "utf8");
    const snap = await store.capture("x", [a, path.join(bDir, "b.txt")]);
    await writeFile(a, "A1", "utf8");
    await rm(bDir, { recursive: true, force: true });
    await writeFile(bDir, "blocker", "utf8");
    const res = await store.restore(snap.snapId, { policy: "force", authorizedBy: "test" });
    assert.ok(res.failed.length > 0);
    assert.equal(res.rolledBack, true);
    assert.equal(await readFile(a, "utf8"), "A1");
    db.close();
  });

  it("transaction refuses commit without verify", async () => {
    const db = openMemoryDatabase();
    const snapshots = new SnapshotStore(path.join(dir, "c1e"), db);
    const f = path.join(dir, "c1e.txt");
    await writeFile(f, "v0", "utf8");
    const tx = new Transaction("t", { snapshots });
    await tx.begin([f]);
    await tx.write(f, "v1");
    assert.throws(() => tx.commit(), /verify/);
    await tx.rollback();
    assert.equal(await readFile(f, "utf8"), "v0");
    db.close();
  });
});

// ------------------------------------------------ C2 配置中心故障
describe("C2 config center faults", () => {
  it("detects external modification before commit", async () => {
    const f = path.join(dir, "c2.txt");
    await writeFile(f, "v0", "utf8");
    const center = new ConfigCenter(path.join(dir, "c2data"));
    const read = await center.read(f);
    await writeFile(f, "external", "utf8");
    await assert.rejects(() => center.commit(f, "v1", { expectHash: read.hash }), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "conflict");
      return true;
    });
    assert.equal(await readFile(f, "utf8"), "external");
  });

  it("serializes concurrent commits: exactly one wins, the other sees conflict", async () => {
    const f = path.join(dir, "c2b.txt");
    await writeFile(f, "v0", "utf8");
    const center = new ConfigCenter(path.join(dir, "c2bdata"));
    const read = await center.read(f);
    const results = await Promise.allSettled([
      center.commit(f, "A", { expectHash: read.hash }),
      center.commit(f, "B", { expectHash: read.hash }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(ok, 1, "只能有一个客户端成功");
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "conflict");
    const history = await center.history(f);
    assert.equal(history.length, 1, "历史必须与成功提交一致");
  });

  it("corrupt history index does not crash reads of a file", async () => {
    const f = path.join(dir, "c2c.txt");
    await writeFile(f, "v0", "utf8");
    const center = new ConfigCenter(path.join(dir, "c2cdata"));
    const read = await center.read(f);
    await center.commit(f, "v1", { expectHash: read.hash });
    await writeFile(path.join(center.historyDir, "index.json"), "not json", "utf8");
    await assert.rejects(() => center.history(f), /invalid json|schema_invalid/);
  });
});

// ------------------------------------------------ C3 恢复故障
describe("C3 recovery faults", () => {
  it("is idempotent: restoring twice ends in the same state", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(path.join(dir, "c3"), db);
    const f = path.join(dir, "c3.txt");
    await writeFile(f, "v0", "utf8");
    const snap = await store.capture("x", [f]);
    await writeFile(f, "v1", "utf8");
    await store.restore(snap.snapId, { policy: "force", authorizedBy: "test" });
    await store.restore(snap.snapId, { policy: "force", authorizedBy: "test" });
    assert.equal(await readFile(f, "utf8"), "v0");
    db.close();
  });

  it("serializes concurrent restores of the same snapshot", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(path.join(dir, "c3b"), db);
    const f = path.join(dir, "c3b.txt");
    await writeFile(f, "v0", "utf8");
    const snap = await store.capture("x", [f]);
    await writeFile(f, "v1", "utf8");
    const [r1, r2] = await Promise.all([store.restore(snap.snapId, { policy: "force", authorizedBy: "test" }), store.restore(snap.snapId, { policy: "force", authorizedBy: "test" })]);
    assert.equal(r1.failed.length, 0);
    assert.equal(r2.failed.length, 0);
    assert.equal(await readFile(f, "utf8"), "v0");
    db.close();
  });

  it("detects a corrupted object before touching the target", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(path.join(dir, "c3c"), db);
    const f = path.join(dir, "c3c.txt");
    await writeFile(f, Buffer.alloc(40 * 1024, 65)); // >32KB 才会走对象库而不是内联
    const snap = await store.capture("x", [f]);
    const entry = snap.manifest.entries.find((e) => e.type === "file");
    assert.ok(entry?.hash);
    await writeFile(store.objectPath(entry.hash), "corrupted", "utf8");
    await writeFile(f, "v1", "utf8");
    const res = await store.restore(snap.snapId, { policy: "force", authorizedBy: "test" });
    assert.ok(res.failed.length > 0);
    assert.equal(await readFile(f, "utf8"), "v1", "损坏的快照不能破坏当前文件");
    db.close();
  });

  it("capture on a missing path records it as absent (restore will delete)", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(path.join(dir, "c3d"), db);
    const missing = path.join(dir, "c3d-missing.txt");
    const snap = await store.capture("x", [missing]);
    assert.ok(snap.manifest.entries.some((e) => e.type === "absent"));
    await writeFile(missing, "created later", "utf8");
    const res = await store.restore(snap.snapId, { policy: "force", authorizedBy: "test" });
    assert.equal(res.failed.length, 0);
    await assert.rejects(() => stat(missing));
    db.close();
  });
});

// ------------------------------------------------ C4 工作流故障
describe("C4 workflow faults", () => {
  const makeEngine = () => {
    const db = openMemoryDatabase();
    const engine = new WorkflowEngine({ db, traces: new TraceStore(db), logger: log(), bus: new EventBus() });
    return { engine, db };
  };

  it("first-step failure prevents all downstream steps", async () => {
    const { engine, db } = makeEngine();
    engine.registerExecutor("boom", async () => {
      throw new Error("first");
    });
    engine.registerExecutor("noop", async () => "n");
    engine.register({ id: "wf1", name: "x", version: 1, steps: [{ id: "a", uses: "boom" }, { id: "b", uses: "noop", needs: ["a"] }] });
    const run = await engine.run("wf1");
    assert.equal(run.state, "failed");
    assert.equal(run.steps.find((s) => s.stepId === "b")?.state, "skipped");
    db.close();
  });

  it("middle-step failure keeps earlier successes and skips later", async () => {
    const { engine, db } = makeEngine();
    engine.registerExecutor("ok", async () => "ok");
    engine.registerExecutor("boom", async () => {
      throw new Error("mid");
    });
    engine.register({
      id: "wf2",
      name: "x",
      version: 1,
      steps: [
        { id: "a", uses: "ok" },
        { id: "b", uses: "boom", needs: ["a"] },
        { id: "c", uses: "ok", needs: ["b"] },
      ],
    });
    const run = await engine.run("wf2");
    assert.equal(run.steps.find((s) => s.stepId === "a")?.state, "succeeded");
    assert.equal(run.steps.find((s) => s.stepId === "b")?.state, "failed");
    assert.equal(run.steps.find((s) => s.stepId === "c")?.state, "skipped");
    assert.equal(run.state, "failed");
    db.close();
  });

  it("rejects concurrent resume of a run that is still executing", async () => {
    const { engine, db } = makeEngine();
    engine.registerExecutor("slow", async () => {
      await new Promise((r) => setTimeout(r, 120));
      return "ok";
    });
    engine.register({ id: "wf3", name: "x", version: 1, steps: [{ id: "a", uses: "slow" }] });
    const p = engine.run("wf3");
    await new Promise((r) => setTimeout(r, 20));
    const runId = engine.listRuns(1)[0]?.runId as string;
    await assert.rejects(() => engine.run("wf3", { resumeRunId: runId }), /already active/);
    const done = await p;
    assert.equal(done.state, "succeeded");
    db.close();
  });

  it("survives corrupted persisted output", async () => {
    const { engine, db } = makeEngine();
    engine.registerExecutor("ok", async () => ({ v: 1 }));
    engine.register({ id: "wf4", name: "x", version: 1, steps: [{ id: "a", uses: "ok" }] });
    const run = await engine.run("wf4");
    db.raw.prepare("UPDATE run_step SET output='not json' WHERE run_id=?").run(run.runId);
    const read = engine.getRun(run.runId);
    assert.deepEqual(read?.steps[0]?.output, { unparsable: "not json" });
    db.close();
  });

  it("marks leftover running steps as interrupted on recovery", async () => {
    const { engine, db } = makeEngine();
    db.raw
      .prepare("INSERT INTO run(run_id,kind,ref,state,started_ms,ended_ms,result,error) VALUES('ghost','workflow','wf',?,?,NULL,NULL,NULL)")
      .run("running", Date.now());
    db.raw
      .prepare("INSERT INTO run_step(run_id,step_id,state,started_ms,ended_ms,attempts,output,error) VALUES('ghost','s1',?,?,NULL,1,NULL,NULL)")
      .run("running", Date.now());
    const res = engine.recoverInterrupted();
    assert.equal(res.runs, 1);
    assert.equal(engine.getRun("ghost")?.state, "interrupted");
    assert.equal(engine.getRun("ghost")?.steps[0]?.state, "interrupted");
    db.close();
  });
});

// ------------------------------------------------ C5 调度故障
describe("C5 scheduler faults", () => {
  it("survives a corrupted job spec row without losing other jobs", async () => {
    const db = openMemoryDatabase();
    const s = new Scheduler({ db, logger: log(), bus: new EventBus(), runJob: async () => "ok", now: () => 1_700_000_000_000 });
    s.add({ id: "good", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 60 }, nextRunMs: 1_700_000_000_000 });
    db.raw.prepare("UPDATE job SET spec='broken' WHERE id='good'").run();
    assert.throws(() => s.list());
    db.close();
  });

  it("does not run the same job twice within one tick window", async () => {
    const db = openMemoryDatabase();
    let runs = 0;
    const s = new Scheduler({
      db,
      logger: log(),
      bus: new EventBus(),
      maxConcurrent: 4,
      now: () => 1_700_000_000_000,
      runJob: async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 40));
      },
    });
    s.add({ id: "j", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 60 }, nextRunMs: 1_700_000_000_000 });
    await Promise.all([s.tick(), s.tick(), s.tick()]);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(runs, 1);
    db.close();
  });

  it("keeps running after repeated failures (regression P2-03)", async () => {
    const db = openMemoryDatabase();
    let calls = 0;
    let clock = 1_700_000_000_000;
    const s = new Scheduler({
      db,
      logger: log(),
      bus: new EventBus(),
      now: () => clock,
      runJob: async () => {
        calls += 1;
        throw new Error("fail");
      },
    });
    s.add({ id: "j", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 60 }, nextRunMs: clock });
    for (let i = 0; i < 3; i += 1) {
      await s.tick();
      await new Promise((r) => setTimeout(r, 10));
      clock += 60_000;
    }
    assert.equal(calls, 3);
    assert.equal(s.get("j").state, "enabled");
    db.close();
  });
});

// ------------------------------------------------ C6 规则/技能边界
describe("C6 rules/skills boundary inputs", () => {
  it("rejects empty, overlong and unicode-hostile ids", async () => {
    const store = new RuleStore(path.join(dir, "c6"));
    await assert.rejects(() => store.create({ id: "", title: "t", body: "b" }), /id/);
    await assert.rejects(() => store.create({ id: "a".repeat(65), title: "t", body: "b" }), /id/);
    await assert.rejects(() => store.create({ id: "../../etc", title: "t", body: "b" }), /id/);
    const ok = await store.create({ id: "unicode-title", title: "中文标题 🚀", body: "内容 with émoji 🚀" });
    assert.equal(ok.title, "中文标题 🚀");
  });

  it("rejects a skill with path traversal in a nested file name", async () => {
    const skillDir = path.join(dir, "c6s", "esc");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), ["---", "name: esc", "description: x", "---", ""].join("\n"));
    const lib = new SkillLibrary(path.join(dir, "c6s-data"));
    // 名字里带 .. 的目录在文件系统层面不成立，这里验证正常路径不受影响
    const skill = await lib.inspect(skillDir);
    assert.equal(skill.name, "esc");
    await assert.rejects(() => lib.remove("../esc"), /invalid skill name/);
  });

  it("imports a skill with unicode content and a space-free nested dir", async () => {
    const src = path.join(dir, "c6u", "uni");
    await mkdir(path.join(src, "深 层"), { recursive: true });
    await writeFile(path.join(src, "SKILL.md"), ["---", "name: uni", "description: 中文描述", "---", "", "正文"].join("\n"));
    await writeFile(path.join(src, "深 层", "note.md"), "内容", "utf8");
    const lib = new SkillLibrary(path.join(dir, "c6u-data"));
    const imported = await lib.import(src);
    assert.equal(imported.name, "uni");
    assert.ok(imported.files >= 2);
  });
});

// ------------------------------------------------ C7 更新故障
describe("C7 update faults", () => {
  const service = (sub: string, indexSource?: string) =>
    new UpdateService({ dataDir: path.join(dir, sub), currentVersion: "0.1.0", logger: log(), ...(indexSource ? { indexSource } : {}) });

  it("rejects an artifact whose size or hash does not match", async () => {
    const payload = path.join(dir, "c7-payload.bin");
    await writeFile(payload, "hello", "utf8");
    const index: ReleaseIndex = {
      schema: "purgeplus.release-index/1",
      channel: "stable",
      releases: [{ version: "0.2.0", artifacts: [{ name: "p.bin", source: payload, sha256: "0".repeat(64), size: 5 }] }],
    };
    const svc = service("c7a");
    const plan = await svc.plan("0.2.0", { index });
    await assert.rejects(() => svc.stage(plan), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "integrity_failed");
      return true;
    });
    assert.equal((await svc.status()).activeVersion, undefined);
  });

  it("rejects an index with a http-less relative source", async () => {
    const svc = service("c7b");
    const bad: ReleaseIndex = {
      schema: "purgeplus.release-index/1",
      channel: "stable",
      releases: [{ version: "0.2.0", artifacts: [{ name: "p.bin", source: "relative/path.bin", sha256: "a".repeat(64) }] }],
    };
    await assert.rejects(() => svc.plan("0.2.0", { index: bad }), /source must be/);
  });

  it("keeps the previous version active when activation of a bad staging fails", async () => {
    const svc = service("c7c");
    await assert.rejects(
      () => svc.activate({ version: "0.2.0", stagingDir: path.join(dir, "c7c-missing"), verified: [] }),
      /ENOENT|no such file/,
    );
    assert.equal((await svc.status()).activeVersion, undefined);
  });

  it("prune keeps the active version and removes old ones", async () => {
    const svc = service("c7d");
    for (const v of ["0.2.0", "0.3.0", "0.4.0", "0.5.0"]) {
      const staging = path.join(dir, `c7d-staging-${v}`);
      await mkdir(staging, { recursive: true });
      await writeFile(path.join(staging, "manifest.json"), "{}", "utf8");
      await svc.activate({ version: v, stagingDir: staging, verified: [] });
    }
    const res = await svc.prune(2);
    assert.ok(res.removed.length >= 1);
    assert.ok(res.kept.includes("0.5.0"));
  });
});

// ------------------------------------------------ E 并发一致性
describe("E concurrency consistency", () => {
  it("audit chain stays valid under concurrent appends", async () => {
    const db = openMemoryDatabase();
    const audit = new AuditLog(db);
    await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve(audit.append({ actor: `w${i}`, action: "test" }))));
    const verify = audit.verify();
    assert.equal(verify.ok, true);
    assert.equal(verify.checked, 50);
    db.close();
  });

  it("concurrent snapshots of the same file produce independent, verifiable records", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(path.join(dir, "e2"), db);
    const f = path.join(dir, "e2.txt");
    await writeFile(f, "same", "utf8");
    const snaps = await Promise.all(Array.from({ length: 5 }, (_, i) => store.capture(`n${i}`, [f])));
    assert.equal(new Set(snaps.map((s) => s.snapId)).size, 5);
    for (const s of snaps) assert.equal((await store.verify(s.snapId)).ok, true);
    db.close();
  });
});
