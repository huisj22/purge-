/**
 * 调度器：持久化 job + 到期扫描 + 并发限流。
 *
 * 不变量（有测试）：
 * 1. 同一 job 不会重叠执行（running 集合互斥）。
 * 2. 到期时间持久化在 job 表；重启后按 next_run_ms 继续。
 * 3. pause 后不再触发；resume 重新计算下一次触发时间。
 * 4. 失败会记录 attempts 与 lastError，不隐藏。
 */
import type { EventBus } from "../core/events.ts";
import { EVENTS } from "../core/events.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type { Database } from "../storage/database.ts";
import { computeNext, describeSchedule, validateSchedule, type Schedule } from "./cron.ts";

export type JobState = "enabled" | "paused" | "failed";

export interface JobSpec {
  id: string;
  /** 任务种类，由上层解释（例如 workflow）。 */
  kind: string;
  /** 任务参数（例如 { workflowId }）。 */
  payload: Record<string, unknown>;
  schedule: Schedule;
  state: JobState;
  nextRunMs?: number;
  lastRunMs?: number;
  attempts: number;
  lastError?: string;
}

export interface SchedulerOptions {
  db: Database;
  logger: Logger;
  bus: EventBus;
  /** 执行一个 job；抛错即记为失败。 */
  runJob: (job: JobSpec) => Promise<unknown>;
  maxConcurrent?: number;
  /** 自动扫描间隔；0 表示不自动（测试手调 tick）。 */
  tickMs?: number;
  now?: () => number;
}

export class Scheduler {
  readonly #o: SchedulerOptions;
  readonly #running = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(opts: SchedulerOptions) {
    this.#o = opts;
  }

  get running(): Set<string> {
    return new Set(this.#running);
  }

  add(spec: Omit<JobSpec, "attempts" | "state"> & { state?: JobState; nextRunMs?: number }): JobSpec {
    validateSchedule(spec.schedule);
    const exists = this.#o.db.raw.prepare("SELECT id FROM job WHERE id=?").get(spec.id);
    if (exists) throw purgeError("conflict", `job already exists: ${spec.id}`);
    const now = this.#now();
    const job: JobSpec = {
      id: spec.id,
      kind: spec.kind,
      payload: spec.payload,
      schedule: spec.schedule,
      state: spec.state ?? "enabled",
      attempts: 0,
      nextRunMs: spec.nextRunMs ?? computeNext(spec.schedule, now),
    };
    this.#persist(job);
    this.#o.logger.info("job added", { id: job.id, schedule: describeSchedule(job.schedule), next: job.nextRunMs });
    return job;
  }

  update(id: string, patch: Partial<Pick<JobSpec, "schedule" | "payload" | "state">>): JobSpec {
    const job = this.get(id);
    if (patch.schedule) {
      validateSchedule(patch.schedule);
      job.schedule = patch.schedule;
      job.nextRunMs = computeNext(patch.schedule, this.#now());
    }
    if (patch.payload) job.payload = patch.payload;
    if (patch.state) {
      job.state = patch.state;
      if (patch.state === "enabled") job.nextRunMs = computeNext(job.schedule, this.#now());
    }
    this.#persist(job);
    return job;
  }

  remove(id: string): void {
    const job = this.get(id);
    if (this.#running.has(job.id)) throw purgeError("conflict", `job is running: ${id}`);
    this.#o.db.raw.prepare("DELETE FROM job WHERE id=?").run(id);
  }

  pause(id: string): JobSpec {
    return this.update(id, { state: "paused" });
  }

  resume(id: string): JobSpec {
    return this.update(id, { state: "enabled" });
  }

  get(id: string): JobSpec {
    const row = this.#o.db.raw.prepare("SELECT * FROM job WHERE id=?").get(id) as JobRow | undefined;
    if (!row) throw purgeError("not_found", `job not found: ${id}`);
    return rowToJob(row);
  }

  list(): JobSpec[] {
    const rows = this.#o.db.raw.prepare("SELECT * FROM job ORDER BY id").all() as unknown as JobRow[];
    return rows.map(rowToJob);
  }

  /** 立即执行一次（不影响 schedule 的下次触发时间）。 */
  async runNow(id: string): Promise<{ ok: boolean; error?: string }> {
    const job = this.get(id);
    return this.#execute(job, this.#now(), { advanceSchedule: false });
  }

  start(): void {
    const tickMs = this.#o.tickMs ?? 1000;
    if (tickMs <= 0) return;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 扫描到期 job；返回本次派发的 id 列表。 */
  async tick(): Promise<string[]> {
    if (this.#stopped) return [];
    const now = this.#now();
    const due = this.list().filter((j) => j.state === "enabled" && (j.nextRunMs ?? 0) <= now && !this.#running.has(j.id));
    const limit = Math.max(1, this.#o.maxConcurrent ?? 2);
    const dispatchable = due.slice(0, Math.max(0, limit - this.#running.size));
    const started: string[] = [];
    for (const job of dispatchable) {
      this.#running.add(job.id);
      started.push(job.id);
      this.#o.bus.emit(EVENTS.jobDue, { id: job.id, kind: job.kind });
      void this.#execute(job, now).finally(() => {
        this.#running.delete(job.id);
      });
    }
    return started;
  }

  async #execute(job: JobSpec, now: number, opts: { advanceSchedule?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    const advance = opts.advanceSchedule !== false;
    const next = advance ? computeNext(job.schedule, now) : job.nextRunMs;
    try {
      await this.#o.runJob(job);
      job.attempts += 1;
      job.lastRunMs = now;
      job.nextRunMs = next;
      job.lastError = undefined;
      if (job.state === "failed") job.state = "enabled";
      this.#persist(job);
      this.#o.logger.info("job finished", { id: job.id, attempts: job.attempts });
      return { ok: true };
    } catch (err) {
      const e = asPurgeError(err);
      job.attempts += 1;
      job.lastRunMs = now;
      job.nextRunMs = next;
      job.lastError = e.message;
      // P2-03 修复：一次失败不能让任务永久停摆。
      // 保持 enabled 并按计划继续；失败次数与错误留在 attempts/lastError 里供观察。
      job.state = "enabled";
      this.#persist(job);
      this.#o.logger.warn("job failed", { id: job.id, error: e.message, attempts: job.attempts });
      return { ok: false, error: e.message };
    }
  }

  #persist(job: JobSpec): void {
    this.#o.db.raw
      .prepare(
        `INSERT INTO job(id,kind,spec,state,next_run_ms,last_run_ms,attempts,last_error) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,spec=excluded.spec,state=excluded.state,
           next_run_ms=excluded.next_run_ms,last_run_ms=excluded.last_run_ms,attempts=excluded.attempts,last_error=excluded.last_error`,
      )
      .run(
        job.id,
        job.kind,
        JSON.stringify({ payload: job.payload, schedule: job.schedule }),
        job.state,
        job.nextRunMs ?? null,
        job.lastRunMs ?? null,
        job.attempts,
        job.lastError ?? null,
      );
  }

  #now(): number {
    return this.#o.now ? this.#o.now() : Date.now();
  }
}

interface JobRow {
  id: string;
  kind: string;
  spec: string;
  state: string;
  next_run_ms: number | null;
  last_run_ms: number | null;
  attempts: number;
  last_error: string | null;
}

function rowToJob(row: JobRow): JobSpec {
  const spec = JSON.parse(row.spec) as { payload: Record<string, unknown>; schedule: Schedule };
  const job: JobSpec = {
    id: row.id,
    kind: row.kind,
    payload: spec.payload ?? {},
    schedule: spec.schedule,
    state: row.state as JobState,
    attempts: Number(row.attempts),
  };
  if (row.next_run_ms !== null) job.nextRunMs = Number(row.next_run_ms);
  if (row.last_run_ms !== null) job.lastRunMs = Number(row.last_run_ms);
  if (row.last_error !== null) job.lastError = row.last_error;
  return job;
}
