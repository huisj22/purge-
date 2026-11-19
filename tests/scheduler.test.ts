import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventBus } from "../src/core/events.ts";
import { createLogger } from "../src/core/logger.ts";
import { computeNext, nextRun, parseCron } from "../src/scheduler/cron.ts";
import { Scheduler, type JobSpec } from "../src/scheduler/scheduler.ts";
import { openMemoryDatabase } from "../src/storage/database.ts";

function sched(overrides: Partial<ConstructorParameters<typeof Scheduler>[0]> = {}) {
  const db = openMemoryDatabase();
  const executed: string[] = [];
  const s = new Scheduler({
    db,
    logger: createLogger({ sink: () => {} }),
    bus: new EventBus(),
    runJob: async (job: JobSpec) => {
      executed.push(job.id);
      return "ok";
    },
    maxConcurrent: 2,
    now: () => 1_700_000_000_000,
    ...overrides,
  });
  return { db, s, executed };
}

describe("cron parsing", () => {
  it("parses lists, ranges and steps", () => {
    const spec = parseCron("*/15 9-17 1,15 * 1-5");
    assert.deepEqual([...spec.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
    assert.equal(spec.hours.size, 9);
    assert.deepEqual([...spec.days].sort((a, b) => a - b), [1, 15]);
    assert.equal(spec.weekdays.size, 5);
  });

  it("maps sunday 7 to 0", () => {
    const spec = parseCron("0 0 * * 7");
    assert.deepEqual([...spec.weekdays], [0]);
  });

  it("rejects malformed expressions", () => {
    assert.throws(() => parseCron("0 0 * *"), /5 fields/);
    assert.throws(() => parseCron("60 0 * * *"), /out of range/);
    assert.throws(() => parseCron("*/0 0 * * *"), /bad cron step/);
    assert.throws(() => parseCron("5-1 0 * * *"), /out of range/);
  });

  it("computes the next firing time", () => {
    const from = new Date("2026-01-01T10:07:30").getTime();
    const spec = parseCron("*/15 * * * *");
    const next = nextRun(spec, from);
    assert.equal(new Date(next as number).toISOString(), new Date("2026-01-01T10:15:00").toISOString());
    const hourly = parseCron("0 * * * *");
    assert.equal(new Date(nextRun(hourly, from) as number).getMinutes(), 0);
  });

  it("handles dom/dow OR semantics", () => {
    // 每月 1 号 或 每周一
    const spec = parseCron("0 0 1 * 1");
    const next = nextRun(spec, new Date("2026-01-02T00:00:00").getTime());
    const d = new Date(next as number);
    assert.ok(d.getDate() === 1 || d.getDay() === 1);
  });

  it("computes interval and cron schedules uniformly", () => {
    assert.equal(computeNext({ type: "interval", seconds: 30 }, 1000), 31_000);
    assert.ok(computeNext({ type: "cron", expr: "* * * * *" }, 0) > 0);
  });
});

describe("scheduler", () => {
  it("adds, executes due jobs and advances next_run", async () => {
    const { s, executed, db } = sched();
    const job = s.add({ id: "job1", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 60 }, nextRunMs: 1_700_000_000_000 });
    assert.equal(job.state, "enabled");
    const started = await s.tick();
    assert.deepEqual(started, ["job1"]);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(executed, ["job1"]);
    const after = s.get("job1");
    assert.equal(after.attempts, 1);
    assert.equal(after.nextRunMs, 1_700_000_060_000);
    db.close();
  });

  it("does not run jobs that are not due yet", async () => {
    const { s, executed, db } = sched();
    s.add({ id: "later", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 600 } });
    assert.deepEqual(await s.tick(), []);
    assert.deepEqual(executed, []);
    db.close();
  });

  it("never runs the same job concurrently", async () => {
    const gate: { release?: () => void } = {};
    const started: string[] = [];
    const db = openMemoryDatabase();
    let clock = 1_700_000_000_000;
    const s = new Scheduler({
      db,
      logger: createLogger({ sink: () => {} }),
      bus: new EventBus(),
      maxConcurrent: 4,
      now: () => clock,
      runJob: async (job) => {
        started.push(job.id);
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      },
    });
    s.add({ id: "long", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 60 }, nextRunMs: clock });
    await s.tick();
    clock += 120_000;
    await s.tick();
    assert.deepEqual(started, ["long"], "still-running job must not be dispatched twice");
    gate.release?.();
    await new Promise((r) => setTimeout(r, 10));
    await s.tick();
    assert.deepEqual(started, ["long", "long"]);
    db.close();
  });

  it("marks failures and keeps the error", async () => {
    const db = openMemoryDatabase();
    const s = new Scheduler({
      db,
      logger: createLogger({ sink: () => {} }),
      bus: new EventBus(),
      runJob: async () => {
        throw new Error("boom");
      },
      now: () => 1_700_000_000_000,
    });
    s.add({ id: "bad", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 60 }, nextRunMs: 1_700_000_000_000 });
    await s.tick();
    await new Promise((r) => setTimeout(r, 10));
    const job = s.get("bad");
    // P2-03：一次失败不应让任务永久停摆 —— 保持 enabled，错误与次数可查
    assert.equal(job.state, "enabled");
    assert.equal(job.lastError, "boom");
    assert.equal(job.attempts, 1);
    db.close();
  });

  it("pauses and resumes", async () => {
    const clock = { t: 1_700_000_000_000 };
    const db = openMemoryDatabase();
    const executed: string[] = [];
    const s = new Scheduler({
      db,
      logger: createLogger({ sink: () => {} }),
      bus: new EventBus(),
      now: () => clock.t,
      runJob: async (job) => {
        executed.push(job.id);
      },
    });
    s.add({ id: "p", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 60 }, nextRunMs: clock.t });
    s.pause("p");
    assert.deepEqual(await s.tick(), []);
    s.resume("p");
    assert.equal(s.get("p").state, "enabled");
    clock.t += 61_000;
    const started = await s.tick();
    assert.deepEqual(started, ["p"]);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(executed, ["p"]);
    db.close();
  });

  it("rejects duplicate job ids and unknown jobs", () => {
    const { s, db } = sched();
    s.add({ id: "dup", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 5 } });
    assert.throws(() => s.add({ id: "dup", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 5 } }), /already exists/);
    assert.throws(() => s.get("ghost"), /not found/);
    assert.throws(() => s.add({ id: "bad-cron", kind: "demo", payload: {}, schedule: { type: "cron", expr: "nope" } }), /5 fields/);
    db.close();
  });

  it("runNow executes immediately without waiting for schedule", async () => {
    const { s, executed, db } = sched();
    s.add({ id: "manual", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 600 } });
    const res = await s.runNow("manual");
    assert.equal(res.ok, true);
    assert.deepEqual(executed, ["manual"]);
    db.close();
  });

  it("persists jobs across scheduler instances", () => {
    const { s, db } = sched();
    s.add({ id: "persist", kind: "demo", payload: { a: 1 }, schedule: { type: "cron", expr: "*/5 * * * *" }, nextRunMs: 1_700_000_100_000 });
    const reopened = new Scheduler({
      db,
      logger: createLogger({ sink: () => {} }),
      bus: new EventBus(),
      runJob: async () => "ok",
      now: () => 1_700_000_000_000,
    });
    const job = reopened.get("persist");
    assert.deepEqual(job.payload, { a: 1 });
    assert.equal(job.schedule.type, "cron");
    db.close();
  });
});
