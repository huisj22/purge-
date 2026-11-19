import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventBus } from "../src/core/events.ts";
import { createLogger } from "../src/core/logger.ts";
import { openMemoryDatabase } from "../src/storage/database.ts";
import { TraceStore } from "../src/storage/trace.ts";
import { WorkflowEngine, validateWorkflow, type StepDef } from "../src/workflow/engine.ts";

function makeEngine() {
  const db = openMemoryDatabase();
  const traces = new TraceStore(db);
  const bus = new EventBus();
  const logger = createLogger({ sink: () => {} });
  const engine = new WorkflowEngine({ db, traces, logger, bus });
  return { db, engine, traces, bus };
}

describe("workflow validation", () => {
  it("rejects unknown executors, duplicate ids, unknown deps and cycles", () => {
    const known = new Set(["a"]);
    const base = (steps: StepDef[]) => ({ id: "wf", name: "wf", version: 1, steps });
    assert.throws(() => validateWorkflow(base([{ id: "s1", uses: "nope" }]), known), /unregistered executor/);
    assert.throws(() => validateWorkflow(base([{ id: "s1", uses: "a" }, { id: "s1", uses: "a" }]), known), /duplicate step id/);
    assert.throws(() => validateWorkflow(base([{ id: "s1", uses: "a", needs: ["ghost"] }]), known), /needs unknown step/);
    assert.throws(
      () =>
        validateWorkflow(
          base([
            { id: "s1", uses: "a", needs: ["s2"] },
            { id: "s2", uses: "a", needs: ["s1"] },
          ]),
          known,
        ),
      /dependency cycle/,
    );
    assert.throws(() => validateWorkflow(base([{ id: "s1", uses: "a", needs: ["s1"] }]), known), /depends on itself/);
  });
});

describe("workflow engine", () => {
  it("runs independent steps in parallel and dependent steps after them", async () => {
    const { engine, db } = makeEngine();
    const order: string[] = [];
    engine.registerExecutor("slow", async (input: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 40));
      order.push(`slow:${input.tag}`);
      return input.tag;
    });
    engine.registerExecutor("fast", async () => {
      order.push("fast");
      return "f";
    });
    const wf = engine.register({
      id: "parallel-wf",
      name: "parallel",
      version: 1,
      concurrency: 2,
      steps: [
        { id: "a", uses: "slow", with: { tag: "a" } },
        { id: "b", uses: "slow", with: { tag: "b" } },
        { id: "c", uses: "fast", needs: ["a", "b"] },
      ],
    });
    const run = await engine.run(wf.id);
    assert.equal(run.state, "succeeded");
    assert.equal(run.steps.length, 3);
    assert.ok(order.indexOf("fast") > order.indexOf("slow:a"), "dependent step must run after dependencies");
    assert.equal(run.steps.find((s) => s.stepId === "c")?.output, "f");
    db.close();
  });

  it("retries a flaky step and records attempts", async () => {
    const { engine, db } = makeEngine();
    let calls = 0;
    engine.registerExecutor("flaky", async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "ok";
    });
    const wf = engine.register({
      id: "retry-wf",
      name: "retry",
      version: 1,
      steps: [{ id: "s", uses: "flaky", retry: { attempts: 3, delayMs: 1 } }],
    });
    const run = await engine.run(wf.id);
    assert.equal(run.state, "succeeded");
    assert.equal(run.steps[0]?.attempts, 3);
    assert.equal(run.steps[0]?.output, "ok");
    db.close();
  });

  it("fails the run and skips downstream steps after exhausted retries", async () => {
    const { engine, db } = makeEngine();
    engine.registerExecutor("boom", async () => {
      throw new Error("always");
    });
    engine.registerExecutor("noop", async () => "n");
    const wf = engine.register({
      id: "fail-wf",
      name: "fail",
      version: 1,
      steps: [
        { id: "bad", uses: "boom", retry: { attempts: 2, delayMs: 1 } },
        { id: "after", uses: "noop", needs: ["bad"] },
        { id: "independent", uses: "noop" },
      ],
    });
    const run = await engine.run(wf.id);
    assert.equal(run.state, "failed");
    assert.equal(run.steps.find((s) => s.stepId === "bad")?.state, "failed");
    assert.equal(run.steps.find((s) => s.stepId === "after")?.state, "skipped");
    assert.equal(run.steps.find((s) => s.stepId === "independent")?.state, "succeeded");
    db.close();
  });

  it("honours continueOnError and reports partial", async () => {
    const { engine, db } = makeEngine();
    engine.registerExecutor("boom", async () => {
      throw new Error("nope");
    });
    engine.registerExecutor("noop", async () => "n");
    const wf = engine.register({
      id: "soft-wf",
      name: "soft",
      version: 1,
      steps: [
        { id: "optional", uses: "boom", continueOnError: true },
        { id: "next", uses: "noop", needs: ["optional"] },
      ],
    });
    const run = await engine.run(wf.id);
    assert.equal(run.state, "partial");
    assert.equal(run.steps.find((s) => s.stepId === "optional")?.state, "failed");
    db.close();
  });

  it("times out a slow step and aborts it", async () => {
    const { engine, db } = makeEngine();
    let aborted = false;
    engine.registerExecutor("hang", async (_input, ctx) => {
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise((r) => setTimeout(r, 500));
      return "late";
    });
    const wf = engine.register({ id: "timeout-wf", name: "t", version: 1, steps: [{ id: "slow", uses: "hang", timeoutMs: 30 }] });
    const run = await engine.run(wf.id);
    assert.equal(run.state, "failed");
    assert.equal(run.steps[0]?.state, "timeout");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(aborted, true, "timeout must abort the executor signal");
    db.close();
  });

  it("cancels a running workflow", async () => {
    const { engine, db } = makeEngine();
    engine.registerExecutor("hang", async () => {
      await new Promise((r) => setTimeout(r, 300));
      return "late";
    });
    const wf = engine.register({
      id: "cancel-wf",
      name: "c",
      version: 1,
      steps: [
        { id: "s1", uses: "hang", timeoutMs: 5000 },
        { id: "s2", uses: "hang", needs: ["s1"], timeoutMs: 5000 },
      ],
    });
    const p = engine.run(wf.id);
    setTimeout(() => {
      const runs = engine.listRuns(1);
      if (runs[0]) engine.cancel(runs[0].runId);
    }, 30);
    const run = await p;
    assert.equal(run.state, "cancelled");
    db.close();
  });

  it("resumes from persisted successful steps", async () => {
    const { engine, db } = makeEngine();
    let firstRuns = 0;
    engine.registerExecutor("first", async () => {
      firstRuns += 1;
      return "one";
    });
    engine.registerExecutor("second", async (_i, ctx) => {
      if ((ctx.outputs.first as string) !== "one") throw new Error("missing upstream output");
      return "two";
    });
    const wf = engine.register({
      id: "resume-wf",
      name: "r",
      version: 1,
      steps: [
        { id: "first", uses: "first" },
        { id: "second", uses: "second", needs: ["first"] },
      ],
    });
    const run1 = await engine.run(wf.id);
    assert.equal(run1.state, "succeeded");
    const resumed = await engine.run(wf.id, { resumeRunId: run1.runId });
    assert.equal(resumed.state, "succeeded");
    assert.equal(firstRuns, 1, "succeeded steps must not re-run on resume");
    db.close();
  });

  it("emits run state events and records traces", async () => {
    const { engine, db, bus, traces } = makeEngine();
    const seen: string[] = [];
    bus.on("run.state", (p) => seen.push((p as { state: string }).state));
    engine.registerExecutor("noop", async () => "n");
    const wf = engine.register({ id: "event-wf", name: "e", version: 1, steps: [{ id: "s", uses: "noop" }] });
    const run = await engine.run(wf.id);
    assert.deepEqual(seen, ["succeeded"]);
    const traceList = traces.listTraces();
    assert.ok(traceList.length >= 1);
    assert.equal(engine.listRuns()[0]?.runId, run.runId);
    db.close();
  });
});
