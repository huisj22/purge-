/**
 * 工作流引擎。
 *
 * 能力：DAG 校验、同层并行（带并发上限）、步骤重试/超时/继续执行、取消、断点恢复。
 * 不变量：
 *  - 未注册的 step 类型在 validate() 阶段就拒绝（不等到运行时才炸）。
 *  - 环依赖必须报错并给出环路。
 *  - 每步状态落库；resume 只跳过 succeeded 步骤，interrupted 步骤会重跑。
 *  - 取消是真取消：AbortSignal 传给执行器。执行器可选支持，但不支持也不会阻塞取消。
 */
import { randomUUID } from "node:crypto";
import type { EventBus } from "../core/events.ts";
import { EVENTS } from "../core/events.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type { Database } from "../storage/database.ts";
import type { TraceStore } from "../storage/trace.ts";

export type StepState = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled" | "timeout" | "interrupted";
export type RunState = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "partial" | "interrupted";

export interface StepDef {
  id: string;
  uses: string;
  with?: Record<string, unknown>;
  needs?: string[];
  retry?: { attempts: number; delayMs?: number };
  timeoutMs?: number;
  continueOnError?: boolean;
}

export interface WorkflowDef {
  id: string;
  name: string;
  version: number;
  steps: StepDef[];
  concurrency?: number;
}

export interface StepRecord {
  stepId: string;
  state: StepState;
  attempts: number;
  startedMs?: number;
  endedMs?: number;
  output?: unknown;
  error?: string;
}

export interface RunRecord {
  runId: string;
  workflowId: string;
  state: RunState;
  startedMs: number;
  endedMs?: number;
  steps: StepRecord[];
  error?: string;
}

export interface StepContext {
  runId: string;
  workflowId: string;
  stepId: string;
  signal: AbortSignal;
  /** 其它步骤的输出（只读）。 */
  outputs: Readonly<Record<string, unknown>>;
  logger: Logger;
}

export type StepExecutor = (input: Record<string, unknown>, ctx: StepContext) => Promise<unknown>;

export interface EngineOptions {
  db: Database;
  traces: TraceStore;
  logger: Logger;
  bus: EventBus;
}

export class WorkflowEngine {
  readonly #executors = new Map<string, StepExecutor>();
  readonly #o: EngineOptions;
  readonly #workflows = new Map<string, WorkflowDef>();
  readonly #cancelled = new Set<string>();
  /** runId → 该 run 下所有进行中步骤的 AbortController（取消时统一 abort）。 */
  readonly #controllers = new Map<string, Set<AbortController>>();
  /** 正在进行中的 runId（防止同一 run 被并发 resume）。 */
  readonly #activeRuns = new Set<string>();

  constructor(opts: EngineOptions) {
    this.#o = opts;
  }

  registerExecutor(uses: string, fn: StepExecutor): void {
    if (this.#executors.has(uses)) throw purgeError("invalid_argument", `executor already registered: ${uses}`);
    this.#executors.set(uses, fn);
  }

  executorNames(): string[] {
    return [...this.#executors.keys()].sort();
  }

  register(def: WorkflowDef): WorkflowDef {
    const validated = validateWorkflow(def, new Set(this.#executors.keys()));
    this.#workflows.set(validated.id, validated);
    return validated;
  }

  list(): WorkflowDef[] {
    return [...this.#workflows.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): WorkflowDef {
    const found = this.#workflows.get(id);
    if (!found) throw purgeError("not_found", `workflow not found: ${id}`, { known: this.list().map((w) => w.id) });
    return found;
  }

  cancel(runId: string): void {
    this.#cancelled.add(runId);
    // P2-04 修复：取消必须中断执行器，而不是等它自己跑完。
    for (const controller of this.#controllers.get(runId) ?? []) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
    this.#o.logger.info("workflow cancel requested", { runId });
  }

  async run(workflowId: string, opts: { resumeRunId?: string } = {}): Promise<RunRecord> {
    const def = this.get(workflowId);
    const runId = opts.resumeRunId ?? `run-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    if (this.#activeRuns.has(runId)) {
      throw purgeError("conflict", `run is already active: ${runId}`, { hint: "同一 run 不能并发执行/恢复" });
    }
    this.#activeRuns.add(runId);
    try {
    const resume = opts.resumeRunId ? this.getRun(opts.resumeRunId) : null;
    if (opts.resumeRunId && !resume) throw purgeError("not_found", `run not found: ${opts.resumeRunId}`);
    const startedMs = resume?.startedMs ?? Date.now();
    const span = this.#o.traces.startSpan(`workflow.${def.id}`, { service: "workflow", attrs: { runId, resume: Boolean(resume) } });
    this.#upsertRun(runId, def.id, "running", startedMs, undefined, undefined);
    const records = new Map<string, StepRecord>();
    if (resume) for (const s of resume.steps) records.set(s.stepId, s);
    for (const step of def.steps) {
      if (!records.has(step.id)) records.set(step.id, { stepId: step.id, state: "pending", attempts: 0 });
      if (!resume) this.#persistStep(runId, records.get(step.id) as StepRecord);
    }

    const outputs: Record<string, unknown> = {};
    if (resume) {
      for (const [id, rec] of records) if (rec.state === "succeeded") outputs[id] = rec.output;
    }

    const deps = new Map(def.steps.map((s) => [s.id, s.needs ?? []]));
    let failure: string | undefined;
    let cancelled = false;

    for (;;) {
      if (this.#cancelled.has(runId)) {
        cancelled = true;
        break;
      }
      const ready: StepDef[] = [];
      let pendingOrRunning = 0;
      for (const step of def.steps) {
        const rec = records.get(step.id) as StepRecord;
        if (rec.state === "succeeded" || rec.state === "skipped") continue;
        if (rec.state === "failed" || rec.state === "timeout" || rec.state === "cancelled") continue;
        const unmet = (deps.get(step.id) ?? []).filter((d) => (records.get(d) as StepRecord).state !== "succeeded");
        if (unmet.length === 0 && rec.state !== "running") ready.push(step);
        else pendingOrRunning += 1;
      }
      if (ready.length === 0) {
        // 没有可运行的步骤：要么全部完成，要么被上游失败阻塞
        const blocked = def.steps.filter((s) => {
          const rec = records.get(s.id) as StepRecord;
          if (["succeeded", "skipped", "failed", "timeout", "cancelled"].includes(rec.state)) return false;
          return (deps.get(s.id) ?? []).some((d) => {
            const st = (records.get(d) as StepRecord).state;
            return st === "failed" || st === "timeout" || st === "cancelled";
          });
        });
        for (const step of blocked) {
          const rec = records.get(step.id) as StepRecord;
          rec.state = "skipped";
          rec.error = "upstream dependency did not succeed";
          this.#persistStep(runId, rec);
        }
        if (blocked.length === 0 && pendingOrRunning === 0) break;
        if (blocked.length === 0) break;
        break;
      }
      const limit = Math.max(1, def.concurrency ?? 4);
      for (let i = 0; i < ready.length; i += limit) {
        const batch = ready.slice(i, i + limit);
        await Promise.all(
          batch.map(async (step) => {
            const rec = records.get(step.id) as StepRecord;
            const result = await this.#executeStep(runId, def, step, rec, outputs);
            this.#persistStep(runId, rec);
            if (result.state === "succeeded") outputs[step.id] = result.output;
            if ((result.state === "failed" || result.state === "timeout") && !step.continueOnError) {
              failure = failure ?? `${step.id}: ${rec.error ?? result.state}`;
            }
            if (result.state === "cancelled") cancelled = true;
          }),
        );
        if (this.#cancelled.has(runId)) {
          cancelled = true;
          break;
        }
      }
      if (cancelled) break;
    }

    const states = def.steps.map((s) => (records.get(s.id) as StepRecord).state);
    const anyFailed = states.some((s) => s === "failed" || s === "timeout");
    const allDone = states.every((s) => ["succeeded", "skipped", "failed", "timeout", "cancelled"].includes(s));
    const runState: RunState = cancelled
      ? "cancelled"
      : anyFailed && failure
        ? "failed"
        : anyFailed
          ? "partial"
          : allDone
            ? "succeeded"
            : "partial";
    const endedMs = Date.now();
    this.#upsertRun(runId, def.id, runState, startedMs, endedMs, failure);
    span.end(runState === "succeeded" ? "ok" : runState === "cancelled" ? "cancelled" : "error", { runState });
    this.#o.bus.emit(EVENTS.runStateChanged, { runId, workflowId: def.id, state: runState });
    this.#o.logger.info("workflow finished", { runId, workflowId: def.id, state: runState });
    return this.getRun(runId) as RunRecord;
    } finally {
      // 无论成功、失败还是抛错，都必须释放 run 级状态，否则该 run 永远无法再次 resume
      this.#cancelled.delete(runId);
      this.#controllers.delete(runId);
      this.#activeRuns.delete(runId);
    }
  }

  /**
   * 启动时修复遗留状态（P3-08）：把上次进程崩溃时残留的 running 步骤标记为 interrupted，
   * 对应 run 标记为 interrupted，避免 getRun 永远显示"正在运行"。
   */
  recoverInterrupted(): { runs: number; steps: number } {
    const runningRuns = this.#o.db.raw
      .prepare("SELECT run_id FROM run WHERE kind='workflow' AND state='running'")
      .all() as unknown as Array<{ run_id: string }>;
    let steps = 0;
    for (const row of runningRuns) {
      if (this.#activeRuns.has(row.run_id)) continue;
      const res = this.#o.db.raw
        .prepare("UPDATE run_step SET state='interrupted' WHERE run_id=? AND state='running'")
        .run(row.run_id);
      steps += Number(res.changes ?? 0);
      this.#o.db.raw.prepare("UPDATE run SET state='interrupted', ended_ms=? WHERE run_id=?").run(Date.now(), row.run_id);
    }
    if (runningRuns.length > 0) {
      this.#o.logger.warn("recovered interrupted runs", { runs: runningRuns.length, steps });
    }
    return { runs: runningRuns.length, steps };
  }

  async #executeStep(
    runId: string,
    def: WorkflowDef,
    step: StepDef,
    rec: StepRecord,
    outputs: Record<string, unknown>,
  ): Promise<{ state: StepState; output?: unknown }> {
    const executor = this.#executors.get(step.uses);
    if (!executor) throw purgeError("not_found", `executor not registered: ${step.uses}`);
    const attempts = Math.max(1, step.retry?.attempts ?? 1);
    const span = this.#o.traces.startSpan(`step.${step.id}`, { service: "workflow", attrs: { runId, uses: step.uses } });
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (this.#cancelled.has(runId)) {
        rec.state = "cancelled";
        rec.endedMs = Date.now();
        span.end("cancelled");
        return { state: "cancelled" };
      }
      rec.state = "running";
      rec.attempts = attempt;
      rec.startedMs = rec.startedMs ?? Date.now();
      const controller = new AbortController();
      // 注册到 run 级控制器集合，cancel() 才能中断它（P2-04）
      const set = this.#controllers.get(runId) ?? new Set<AbortController>();
      set.add(controller);
      this.#controllers.set(runId, set);
      const ctx: StepContext = {
        runId,
        workflowId: def.id,
        stepId: step.id,
        signal: controller.signal,
        outputs: { ...outputs },
        logger: this.#o.logger.child({ runId, step: step.id }),
      };
      try {
        const timeoutMs = step.timeoutMs ?? 30_000;
        // 取消竞速：即使执行器忽略 signal，我们也不再等它（后台 Promise 会被丢弃，副作用无法回收，
        // 这点在报告中明确说明；但至少 run 不会挂住）。
        const abortRace = new Promise<never>((_, reject) => {
          if (controller.signal.aborted) {
            reject(purgeError("timeout", "cancelled"));
            return;
          }
          controller.signal.addEventListener("abort", () => reject(purgeError("timeout", "cancelled")), { once: true });
        });
        const output = await Promise.race([
          withTimeout(executor(step.with ?? {}, ctx), timeoutMs, controller, () => this.#cancelled.has(runId)),
          abortRace,
        ]);
        if (this.#cancelled.has(runId)) {
          // 执行器可能忽略了 abort 仍然返回；此时不能把它记成成功
          rec.state = "cancelled";
          rec.endedMs = Date.now();
          span.end("cancelled", { attempts: attempt, ignoredAbort: true });
          return { state: "cancelled" };
        }
        rec.state = "succeeded";
        rec.output = output;
        rec.error = undefined;
        rec.endedMs = Date.now();
        span.end("ok", { attempts: attempt });
        return { state: "succeeded", output };
      } catch (err) {
        const e = asPurgeError(err);
        rec.error = e.message;
        rec.endedMs = Date.now();
        if (this.#cancelled.has(runId)) {
          rec.state = "cancelled";
          span.end("cancelled", { attempts: attempt });
          return { state: "cancelled" };
        }
        if (e.code === "timeout") {
          rec.state = "timeout";
          span.end("error", { reason: "timeout" });
          return { state: "timeout" };
        }
        if (e.code === "policy_denied" || e.code === "confirmation_required") {
          // 策略拒绝不重试：重试没有意义
          rec.state = "failed";
          span.end("error", { reason: e.code });
          return { state: "failed" };
        }
        if (attempt === attempts) {
          rec.state = "failed";
          span.end("error", { reason: "exhausted", attempts: attempt });
          return { state: "failed" };
        }
        const delay = step.retry?.delayMs ?? 50 * attempt;
        await sleep(delay);
      }
    }
    rec.state = "failed";
    span.end("error");
    return { state: "failed" };
  }

  getRun(runId: string): RunRecord | null {
    const row = this.#o.db.raw.prepare("SELECT * FROM run WHERE run_id=?").get(runId) as
      | { run_id: string; kind: string; ref: string; state: string; started_ms: number; ended_ms: number | null; error: string | null }
      | undefined;
    if (!row) return null;
    const steps = this.#o.db.raw.prepare("SELECT * FROM run_step WHERE run_id=? ORDER BY rowid").all(runId) as unknown as Array<{
      step_id: string;
      state: string;
      started_ms: number | null;
      ended_ms: number | null;
      attempts: number;
      output: string | null;
      error: string | null;
    }>;
    return {
      runId: row.run_id,
      workflowId: row.ref,
      state: row.state as RunState,
      startedMs: Number(row.started_ms),
      endedMs: row.ended_ms === null ? undefined : Number(row.ended_ms),
      error: row.error ?? undefined,
      steps: steps.map((s) => {
        const rec: StepRecord = { stepId: s.step_id, state: s.state as StepState, attempts: Number(s.attempts) };
        if (s.started_ms !== null) rec.startedMs = Number(s.started_ms);
        if (s.ended_ms !== null) rec.endedMs = Number(s.ended_ms);
        if (s.output !== null) rec.output = safeParse(s.output);
        if (s.error !== null) rec.error = s.error;
        return rec;
      }),
    };
  }

  listRuns(limit = 50): RunRecord[] {
    const rows = this.#o.db.raw
      .prepare("SELECT run_id FROM run WHERE kind='workflow' ORDER BY started_ms DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 500))) as unknown as Array<{ run_id: string }>;
    return rows.map((r) => this.getRun(r.run_id)).filter((r): r is RunRecord => r !== null);
  }

  #upsertRun(runId: string, workflowId: string, state: RunState, startedMs: number, endedMs?: number, error?: string): void {
    this.#o.db.raw
      .prepare(
        `INSERT INTO run(run_id,kind,ref,state,started_ms,ended_ms,result,error) VALUES(?,?,?,?,?,?,NULL,?)
         ON CONFLICT(run_id) DO UPDATE SET state=excluded.state, ended_ms=excluded.ended_ms, error=excluded.error`,
      )
      .run(runId, "workflow", workflowId, state, startedMs, endedMs ?? null, error ?? null);
  }

  #persistStep(runId: string, rec: StepRecord): void {
    this.#o.db.raw
      .prepare(
        `INSERT INTO run_step(run_id,step_id,state,started_ms,ended_ms,attempts,output,error) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id,step_id) DO UPDATE SET state=excluded.state,started_ms=excluded.started_ms,
           ended_ms=excluded.ended_ms,attempts=excluded.attempts,output=excluded.output,error=excluded.error`,
      )
      .run(
        runId,
        rec.stepId,
        rec.state,
        rec.startedMs ?? null,
        rec.endedMs ?? null,
        rec.attempts,
        rec.output === undefined ? null : JSON.stringify(rec.output),
        rec.error ?? null,
      );
  }
}

export function validateWorkflow(def: WorkflowDef, knownExecutors: Set<string>): WorkflowDef {
  if (!def.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(def.id)) throw purgeError("invalid_argument", `invalid workflow id: ${def.id}`);
  if (!Array.isArray(def.steps) || def.steps.length === 0) throw purgeError("invalid_argument", "workflow has no steps");
  const ids = new Set<string>();
  for (const step of def.steps) {
    if (!step.id) throw purgeError("invalid_argument", "step without id");
    if (ids.has(step.id)) throw purgeError("invalid_argument", `duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (!knownExecutors.has(step.uses)) {
      throw purgeError("invalid_argument", `step ${step.id} uses unregistered executor: ${step.uses}`, {
        known: [...knownExecutors].sort(),
      });
    }
  }
  for (const step of def.steps) {
    for (const dep of step.needs ?? []) {
      if (!ids.has(dep)) throw purgeError("invalid_argument", `step ${step.id} needs unknown step: ${dep}`);
      if (dep === step.id) throw purgeError("invalid_argument", `step ${step.id} depends on itself`);
    }
  }
  const cycle = findCycle(def.steps);
  if (cycle) throw purgeError("invalid_argument", `dependency cycle: ${cycle.join(" -> ")}`);
  return { ...def, concurrency: Math.max(1, def.concurrency ?? 4) };
}

function findCycle(steps: StepDef[]): string[] | null {
  const deps = new Map(steps.map((s) => [s.id, s.needs ?? []]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const st = state.get(id) ?? 0;
    if (st === 1) {
      const idx = stack.indexOf(id);
      return [...stack.slice(idx), id];
    }
    if (st === 2) return null;
    state.set(id, 1);
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const s of steps) {
    const found = visit(s.id);
    if (found) return found;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  isCancelled: () => boolean,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const checkTimer: NodeJS.Timeout | undefined = undefined;
  void checkTimer;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(purgeError("timeout", `step timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    if (isCancelled()) {
      controller.abort();
      throw purgeError("timeout", "cancelled before start");
    }
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { unparsable: text };
  }
}
