/**
 * 组合根：把内核、存储、适配器、诊断、编排、调度、策略装配成一个可启动的应用。
 *
 * 约定：
 * - 所有副作用（打开数据库、读配置、起调度）都发生在 start() 里，构造函数不做 IO。
 * - stop() 逆序释放：调度 → 工作流 → 数据库。
 * - 数据目录可通过参数/环境变量覆盖，测试用临时目录。
 */
import * as path from "node:path";
import { homedir } from "node:os";
import { DshHostAdapter } from "./adapters/dsh.ts";
import type { HostAdapter } from "./adapters/types.ts";
import { type PurgeConfig, ConfigStore } from "./core/config.ts";
import { EventBus } from "./core/events.ts";
import { Kernel } from "./core/kernel.ts";
import { createLogger, type Logger } from "./core/logger.ts";
import { DiagnosticsService } from "./inspector/diagnostics.ts";
import { PackEngine } from "./packs/engine.ts";
import { PackStore } from "./packs/store.ts";
import { PluginHost } from "./plugins/host.ts";
import { UpdateService } from "./update/service.ts";
import { RuleStore } from "./ruleskills/rules.ts";
import { SkillLibrary } from "./ruleskills/skills.ts";
import { HostRegistry } from "./registry/registry.ts";
import { SnapshotStore } from "./recovery/snapshot.ts";
import { Transaction } from "./recovery/transaction.ts";
import { Scheduler, type JobSpec } from "./scheduler/scheduler.ts";
import { evaluatePolicy, guard, type PolicyConfig, type PolicyVerdict, type ActionRequest, type GuardOptions } from "./security/policy.ts";
import { AuditLog } from "./storage/audit.ts";
import { type Database, openDatabase } from "./storage/database.ts";
import { MetricStore, TraceStore } from "./storage/trace.ts";
import { WorkflowEngine } from "./workflow/engine.ts";

export const APP_VERSION = "0.1.0-alpha.1";

export interface AppOptions {
  dataDir?: string;
  /** 覆盖配置（写进 config.json 之前的运行期覆盖，测试用）。 */
  configOverrides?: Record<string, unknown>;
  /** 追加适配器（默认只有 DSH）。 */
  adapters?: HostAdapter[];
  /** 是否启动调度循环（测试可关闭）。 */
  startScheduler?: boolean;
  loggerLevel?: "debug" | "info" | "warn" | "error";
  /** 测试用：关闭进程探测。 */
  skipProcessProbe?: boolean;
}

export function resolveDataDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.PURGE_DATA_DIR) return path.resolve(process.env.PURGE_DATA_DIR);
  const home = homedir();
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "purge-plus");
  }
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "purge-plus");
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "purge-plus");
}

export interface AppServices {
  kernel: Kernel;
  config: ConfigStore;
  db: Database;
  audit: AuditLog;
  traces: TraceStore;
  metrics: MetricStore;
  snapshots: SnapshotStore;
  registry: HostRegistry;
  diagnostics: DiagnosticsService;
  workflow: WorkflowEngine;
  scheduler: Scheduler;
  plugins: PluginHost;
  updates: UpdateService;
  rules: RuleStore;
  skills: SkillLibrary;
  packs: PackStore;
  packEngine: PackEngine;
  logger: Logger;
  bus: EventBus;
}

export class PurgeApp {
  readonly dataDir: string;
  readonly kernel: Kernel;
  readonly bus: EventBus;
  logger: Logger;
  #services: AppServices | null = null;
  #started = false;
  readonly #opts: AppOptions;

  constructor(opts: AppOptions = {}) {
    this.#opts = opts;
    this.dataDir = resolveDataDir(opts.dataDir);
    this.bus = new EventBus({ onListenerError: (event, err) => this.logger.warn("event listener failed", { event, error: String(err) }) });
    this.logger = createLogger({ level: opts.loggerLevel ?? "info" });
    this.kernel = new Kernel({ logger: this.logger, bus: this.bus });
  }

  get services(): AppServices {
    if (!this.#services) throw new Error("app not started; call start() first");
    return this.#services;
  }

  async start(): Promise<AppServices> {
    if (this.#started && this.#services) return this.#services;
    const dataDir = this.dataDir;
    const config = new ConfigStore(dataDir);
    await config.load();
    if (this.#opts.configOverrides && Object.keys(this.#opts.configOverrides).length > 0) {
      await config.update(this.#opts.configOverrides);
    }
    const cfg = config.get();
    this.logger = createLogger({ level: cfg.logLevel });
    const db = openDatabase(path.join(dataDir, "purgeplus.db"));
    const audit = new AuditLog(db);
    const traces = new TraceStore(db);
    const metrics = new MetricStore(db);
    const snapshots = new SnapshotStore(dataDir, db);
    const registry = new HostRegistry({ logger: this.logger, bus: this.bus });
    const adapters: HostAdapter[] = this.#opts.adapters ?? [
      new DshHostAdapter({
        extraRoots: cfg.hosts.roots,
        includeDefaults: true,
        skipProcessProbe: this.#opts.skipProcessProbe === true,
      }),
    ];
    for (const adapter of adapters) registry.addAdapter(adapter);
    const diagnostics = new DiagnosticsService({ registry, db, audit, traces, metrics, logger: this.logger, bus: this.bus });
    const servicesRef: { value: AppServices | null } = { value: null };
    const plugins = new PluginHost({
      dataDir,
      logger: this.logger,
      resolveService: (capability) => resolveCapability(servicesRef.value, capability),
    });
    const updates = new UpdateService({
      dataDir,
      currentVersion: APP_VERSION,
      logger: this.logger,
      channel: cfg.update.channel,
      ...(cfg.update.indexUrl ? { indexSource: cfg.update.indexUrl } : {}),
    });
    const rules = new RuleStore(dataDir);
    const skills = new SkillLibrary(dataDir);
    const packs = new PackStore(dataDir);
    const packEngine = new PackEngine({
      snapshots,
      createTransaction: async (label, targets) => {
        const tx = new Transaction(label, {
          snapshots,
          actor: "pack-engine",
          onEvent: (e) => this.logger.debug("tx event", { txId: e.txId, type: e.type }),
        });
        await tx.begin(targets);
        return tx;
      },
    });
    const workflow = new WorkflowEngine({ db, traces, logger: this.logger, bus: this.bus });
    registerDefaultExecutors(workflow, { registry, diagnostics });
    registerDefaultWorkflows(workflow);
    const scheduler = new Scheduler({
      db,
      logger: this.logger,
      bus: this.bus,
      maxConcurrent: cfg.scheduler.maxConcurrent,
      tickMs: this.#opts.startScheduler === false ? 0 : cfg.scheduler.tickMs,
      runJob: async (job: JobSpec) => {
        if (job.kind !== "workflow") throw new Error(`unsupported job kind: ${job.kind}`);
        const workflowId = String(job.payload.workflowId ?? "");
        const run = await workflow.run(workflowId);
        if (run.state !== "succeeded") throw new Error(`workflow ${workflowId} ended ${run.state}`);
        return run;
      },
    });
    const services: AppServices = {
      kernel: this.kernel,
      config,
      db,
      audit,
      traces,
      metrics,
      snapshots,
      registry,
      diagnostics,
      workflow,
      scheduler,
      plugins,
      updates,
      rules,
      skills,
      packs,
      packEngine,
      logger: this.logger,
      bus: this.bus,
    };
    servicesRef.value = services;
    this.#services = services;
    if (this.#opts.startScheduler !== false) scheduler.start();
    this.#started = true;
    audit.append({ actor: "system", action: "app.start", target: dataDir, risk: 0, detail: { version: APP_VERSION } });
    this.logger.info("purge+ started", { dataDir, version: APP_VERSION });
    return services;
  }

  async stop(): Promise<void> {
    if (!this.#services) return;
    const s = this.#services;
    s.scheduler.stop();
    s.audit.append({ actor: "system", action: "app.stop", target: this.dataDir, risk: 0 });
    s.db.close();
    this.#services = null;
    this.#started = false;
    this.logger.info("purge+ stopped");
  }

  policyConfig(): PolicyConfig {
    const p = this.services.config.get().policy;
    return { confirmThreshold: p.confirmThreshold, denyThreshold: p.denyThreshold, allowActions: p.allowActions };
  }

  /** 变更类动作统一入口：策略判定 → 执行 → 审计。 */
  async guarded<T>(
    actor: string,
    req: ActionRequest,
    fn: () => Promise<T>,
    opts: GuardOptions = {},
  ): Promise<{ verdict: PolicyVerdict; result: T }> {
    const verdict = evaluatePolicy(req, this.policyConfig());
    const s = this.services;
    try {
      guard(req, this.policyConfig(), opts);
    } catch (err) {
      s.audit.append({
        actor,
        action: `${req.action}:denied`,
        target: req.target,
        risk: verdict.risk,
        detail: { factors: verdict.factors, message: (err as Error).message },
      });
      throw err;
    }
    const result = await fn();
    s.audit.append({
      actor,
      action: req.action,
      target: req.target,
      risk: verdict.risk,
      detail: { factors: verdict.factors.map((f) => f.code), decision: verdict.decision },
    });
    return { verdict, result };
  }
}

/** 插件能力名 → 服务实例。只暴露只读/受控能力，不暴露 kernel 与 db。 */
function resolveCapability(services: AppServices | null, capability: string): unknown {
  if (!services) throw new Error(`services not ready yet (capability "${capability}")`);
  const map: Record<string, unknown> = {
    diagnostics: services.diagnostics,
    registry: services.registry,
    rules: services.rules,
    skills: services.skills,
    packs: services.packs,
    workflow: services.workflow,
    scheduler: services.scheduler,
    audit: services.audit,
    snapshots: services.snapshots,
    traces: services.traces,
    metrics: services.metrics,
    config: services.config,
    updates: services.updates,
  };
  const found = map[capability];
  if (!found) throw new Error(`unknown capability: ${capability}`);
  return found;
}

function registerDefaultExecutors(
  engine: WorkflowEngine,
  deps: { registry: HostRegistry; diagnostics: DiagnosticsService },
): void {
  engine.registerExecutor("noop", async (input) => ({ ok: true, input }));
  engine.registerExecutor("diagnose", async (input) => {
    const hostId = input.hostId;
    if (typeof hostId === "string" && hostId) return deps.diagnostics.run(hostId);
    return deps.diagnostics.runAll();
  });
  engine.registerExecutor("discover", async () => {
    const hosts = await deps.registry.discover(true);
    return hosts.map((h) => ({ id: h.id, root: h.root, adapter: h.adapterId }));
  });
  engine.registerExecutor("sleep", async (input) => {
    const ms = Number(input.ms ?? 0);
    if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) throw new Error(`invalid sleep ms: ${input.ms}`);
    await new Promise((r) => setTimeout(r, ms));
    return { slept: ms };
  });
}

function registerDefaultWorkflows(engine: WorkflowEngine): void {
  if (!engine.list().some((w) => w.id === "healthcheck")) {
    engine.register({
      id: "healthcheck",
      name: "全宿主体检",
      version: 1,
      concurrency: 2,
      steps: [
        { id: "discover", uses: "discover", timeoutMs: 30_000 },
        { id: "diagnose", uses: "diagnose", needs: ["discover"], timeoutMs: 120_000 },
      ],
    });
  }
}
