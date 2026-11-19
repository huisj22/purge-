/**
 * Phase 4 探针 F：Scheduler 在"任务执行时间 > 调度间隔"时是否会补跑成风暴。
 * 仅在内存库中运行，不写项目文件。
 */
import { EventBus } from "../../../src/core/events.ts";
import { createLogger } from "../../../src/core/logger.ts";
import { Scheduler } from "../../../src/scheduler/scheduler.ts";
import { openMemoryDatabase } from "../../../src/storage/database.ts";

const db = openMemoryDatabase();
const started: number[] = [];
const s = new Scheduler({
  db,
  logger: createLogger({ sink: () => {} }),
  bus: new EventBus(),
  maxConcurrent: 4,
  runJob: async () => {
    started.push(Date.now());
    await new Promise((r) => setTimeout(r, 250));
  },
});

// 间隔 100ms，但每次执行 250ms → 执行期间 deadline 被越过
s.add({ id: "catchup", kind: "demo", payload: {}, schedule: { type: "interval", seconds: 0.1 as unknown as number }, nextRunMs: Date.now() });

const t0 = Date.now();
while (Date.now() - t0 < 1600) {
  await s.tick();
  await new Promise((r) => setTimeout(r, 20));
}
const elapsed = Date.now() - t0;
const job = s.get("catchup");
console.log(
  JSON.stringify(
    {
      executionsInWindow: started.length,
      windowMs: elapsed,
      attempts: job.attempts,
      nextRunMsIsPast: (job.nextRunMs ?? 0) < Date.now(),
      expectation: "执行超过间隔时应跳过积压的触发（不补跑），而不是连续追帧",
    },
    null,
    2,
  ),
);
console.log(`\nPROBE_RESULT=${started.length > 8 ? "CATCHUP_STORM_CONFIRMED" : "no-storm"}${started.length > 8 ? ` (${started.length} 次 / 1.6s)` : ""}`);
db.close();
