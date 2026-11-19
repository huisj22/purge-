/**
 * Phase 4 探针 F2：调度任务失败一次后是否永久停摆（无重试/无退避）。
 * 探针 G：Workflow 取消能否真正中断正在运行的步骤。
 * 均在内存库/内存执行器中进行，无文件副作用。
 */
import { EventBus } from "../../../src/core/events.ts";
import { createLogger } from "../../../src/core/logger.ts";
import { Scheduler } from "../../../src/scheduler/scheduler.ts";
import { openMemoryDatabase } from "../../../src/storage/database.ts";
import { TraceStore } from "../../../src/storage/trace.ts";
import { WorkflowEngine } from "../../../src/workflow/engine.ts";

// ---------- F2 ----------
{
  const db = openMemoryDatabase();
  let calls = 0;
  const s = new Scheduler({
    db,
    logger: createLogger({ sink: () => {} }),
    bus: new EventBus(),
    maxConcurrent: 2,
    runJob: async () => {
      calls += 1;
      throw new Error("transient network error");
    },
  });
  let clock = 1_700_000_000_000;
  const s2 = new Scheduler({
    db,
    logger: createLogger({ sink: () => {} }),
    bus: new EventBus(),
    maxConcurrent: 2,
    now: () => clock,
    runJob: async () => {
      calls += 1;
      throw new Error("transient network error");
    },
  });
  void s;
  s2.add({ id: "flaky-job", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 60 }, nextRunMs: clock });
  await s2.tick();
  await new Promise((r) => setTimeout(r, 20));
  const afterFail = s2.get("flaky-job");
  // 时间推进 10 个周期，看它会不会再跑
  for (let i = 0; i < 10; i += 1) {
    clock += 60_000;
    await s2.tick();
  }
  await new Promise((r) => setTimeout(r, 20));
  const final = s2.get("flaky-job");
  console.log(
    JSON.stringify(
      {
        probe: "F2-scheduler-failure-retry",
        calls,
        stateAfterFailure: afterFail.state,
        attemptsAfterTenPeriods: final.attempts,
        expectation: "一次性瞬时失败不应让任务永久停摆；应保留调度并记录失败次数（或显式退避）",
      },
      null,
      2,
    ),
  );
  console.log(`F2_RESULT=${final.attempts === 1 ? "PERMANENT_STOP_CONFIRMED" : "still-scheduled"}`);
  db.close();
}

// ---------- G ----------
{
  const db = openMemoryDatabase();
  const traces = new TraceStore(db);
  const engine = new WorkflowEngine({ db, traces, logger: createLogger({ sink: () => {} }), bus: new EventBus() });
  let finished = false;
  engine.registerExecutor("slow", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    finished = true;
    return "done";
  });
  engine.register({
    id: "cancel-probe",
    name: "cancel",
    version: 1,
    steps: [{ id: "s1", uses: "slow", timeoutMs: 10_000 }],
  });
  const t0 = Date.now();
  const p = engine.run("cancel-probe");
  setTimeout(() => {
    const run = engine.listRuns(1)[0];
    if (run) engine.cancel(run.runId);
  }, 100);
  const run = await p;
  const elapsed = Date.now() - t0;
  console.log(
    JSON.stringify(
      {
        probe: "G-workflow-cancel",
        runState: run.state,
        stepState: run.steps[0]?.state,
        executorActuallyFinished: finished,
        msUntilRunReturned: elapsed,
        expectation: "取消应尽快返回并阻止步骤完成后的副作用被计入成功",
      },
      null,
      2,
    ),
  );
  console.log(`G_RESULT=${elapsed > 1000 ? "CANCEL_DOES_NOT_INTERRUPT" : "cancelled-promptly"}`);
  db.close();
}
