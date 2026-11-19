/**
 * 进程隔离的插件宿主（T-036）。
 *
 * 与 in-process 版本的区别：
 * - 插件代码跑在**独立 node 子进程**里，崩溃不会带走核心进程。
 * - 能力调用必须由 Host 审批：Worker 发 `capability` 请求，Host 侧按清单白名单判定后执行。
 * - IPC 消息全部校验（schema 版本 / 类型 / id / 大小），非法即拒绝。
 * - 生命周期：CREATED → STARTING → RUNNING → STOPPING → STOPPED / CRASHED / TIMEOUT / FAILED。
 *
 * 边界声明：这是 **PROCESS_ISOLATED**，不是 OS 沙箱。
 * 子进程仍然拥有当前用户的文件系统/网络权限；真正的 OS 级限制未实现（见 MATURITY 报告）。
 */
import { type ChildProcess, fork } from "node:child_process";
import * as path from "node:path";
import { asPurgeError, purgeError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type { PluginManifest } from "./host.ts";

export type WorkerState = "CREATED" | "STARTING" | "RUNNING" | "STOPPING" | "STOPPED" | "CRASHED" | "TIMEOUT" | "FAILED";

export const IPC_SCHEMA_VERSION = 1;
const MAX_INBOUND_BYTES = 1024 * 1024;

export interface WorkerOptions {
  manifest: PluginManifest;
  pluginDir: string;
  logger: Logger;
  /** 能力审批器：返回 { allow, handler }。Host 决定是否放行。 */
  capabilityResolver: (service: string, method: string) => { allow: boolean; invoke?: (...args: unknown[]) => unknown; reason?: string };
  /** 插件私有数据目录（由 Host 分配，worker 只能通过 ctx.data 访问）。 */
  dataDir?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** 覆盖 worker 脚本路径（测试用）。 */
  workerScript?: string;
  env?: Record<string, string>;
}

export interface WorkerCallResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
  state: WorkerState;
}

export class IsolatedPluginWorker {
  readonly manifest: PluginManifest;
  readonly dir: string;
  #child: ChildProcess | null = null;
  #state: WorkerState = "CREATED";
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #nextId = 1;
  readonly #o: WorkerOptions;
  #ready: Promise<void> | null = null;

  constructor(opts: WorkerOptions) {
    this.#o = opts;
    this.manifest = opts.manifest;
    this.dir = opts.pluginDir;
  }

  get state(): WorkerState {
    return this.#state;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  async start(): Promise<void> {
    if (this.#state === "RUNNING") return;
    if (this.#ready) return this.#ready;
    this.#state = "STARTING";
    const script = this.#o.workerScript ?? path.join(import.meta.dirname, "worker-runtime.ts");
    const child = fork(script, [], {
      cwd: path.dirname(this.#o.pluginDir),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        ...this.#o.env,
        PURGE_PLUGIN_DIR: this.#o.pluginDir,
        PURGE_PLUGIN_NAME: this.manifest.name,
        PURGE_PLUGIN_ENTRY: this.manifest.entry,
        PURGE_PLUGIN_CAPABILITIES: JSON.stringify(this.manifest.capabilities),
        PURGE_PLUGIN_DATA: this.#o.dataDir ?? "",
      },
    });
    this.#child = child;
    child.stderr?.on("data", (d: Buffer) => this.#o.logger.debug(`[plugin:${this.manifest.name}] ${d.toString().trim()}`));

    this.#ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#state = "TIMEOUT";
        child.kill("SIGKILL");
        reject(purgeError("timeout", `plugin ${this.manifest.name} did not become ready in ${this.#o.startupTimeoutMs ?? 5000}ms`));
      }, this.#o.startupTimeoutMs ?? 5000);

      // 常驻路由：result/error 必须能到达 #pending，否则调用永远等不到回包
      child.on("message", (raw: unknown) => {
        const msg = raw as Record<string, unknown>;
        if (!msg || typeof msg !== "object") return;
        if (msg.v !== IPC_SCHEMA_VERSION) {
          this.#o.logger.warn("worker sent message with wrong schema version", { plugin: this.manifest.name, v: msg.v });
          return;
        }
        const type = String(msg.type ?? "");
        const size = Buffer.byteLength(JSON.stringify(msg), "utf8");
        if (size > MAX_INBOUND_BYTES) {
          this.#o.logger.warn("worker sent oversized message; killing", { plugin: this.manifest.name, size });
          child.kill("SIGKILL");
          return;
        }
        if (type === "ready") {
          clearTimeout(timer);
          this.#state = "RUNNING";
          resolve();
          return;
        }
        if (type === "capability") {
          void this.#handleCapability(msg);
          return;
        }
        if (type === "log") {
          this.#o.logger.info(`[plugin:${this.manifest.name}] ${String(msg.msg ?? "")}`);
          return;
        }
        if (type === "result" || type === "error") {
          const id = String(msg.id ?? "");
          const waiter = this.#pending.get(id);
          if (!waiter) return;
          this.#pending.delete(id);
          clearTimeout(waiter.timer);
          if (type === "error") waiter.reject(new Error(String(msg.error ?? "worker error")));
          else waiter.resolve({ result: msg.result });
          return;
        }
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (this.#state !== "STOPPING" && this.#state !== "STOPPED") {
          this.#state = "CRASHED";
          this.#o.logger.warn("plugin worker exited unexpectedly", { plugin: this.manifest.name, code, signal });
        }
        for (const [, waiter] of this.#pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`plugin worker exited (code=${code ?? "null"})`));
        }
        this.#pending.clear();
        reject(purgeError("service_failed", `plugin ${this.manifest.name} exited before ready (code=${code ?? "null"})`));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        this.#state = "FAILED";
        reject(purgeError("service_failed", `plugin ${this.manifest.name} failed to start: ${err.message}`));
      });
    });
    return this.#ready;
  }

  async #handleCapability(msg: Record<string, unknown>): Promise<void> {
    const id = String(msg.id ?? "");
    const service = String(msg.service ?? "");
    const method = String(msg.method ?? "");
    const reply = (payload: Record<string, unknown>) => this.#send({ v: IPC_SCHEMA_VERSION, type: "capability_result", id, ...payload });
    // 宿主调解的通道（如 __data__）不走插件能力声明，但仍由 Host 侧做边界校验
    const hostMediated = service === "__data__";
    if (!hostMediated && !this.manifest.capabilities.includes(service)) {
      reply({ error: `capability "${service}" not declared` });
      return;
    }
    const resolved = this.#o.capabilityResolver(service, method);
    if (!resolved.allow || typeof resolved.invoke !== "function") {
      reply({ error: resolved.reason ?? `capability ${service}.${method} denied by host policy` });
      return;
    }
    try {
      const args = Array.isArray(msg.args) ? (msg.args as unknown[]) : [];
      const result = await resolved.invoke(...args);
      reply({ result });
    } catch (err) {
      reply({ error: asPurgeError(err).message });
    }
  }

  #send(message: Record<string, unknown>): void {
    const child = this.#child;
    if (!child?.connected) return;
    try {
      child.send(message);
    } catch (err) {
      this.#o.logger.warn("failed to send IPC message", { plugin: this.manifest.name, error: (err as Error).message });
    }
  }

  async request(type: "invoke" | "health" | "shutdown", payload: Record<string, unknown> = {}): Promise<WorkerCallResult> {
    if (this.#state !== "RUNNING" && this.#state !== "STOPPING") {
      if (this.#state === "CREATED") await this.start();
      else return { ok: false, error: `worker is ${this.#state}`, state: this.#state };
    }
    const id = `req-${this.#nextId++}`;
    const timeoutMs = type === "invoke" ? (this.#o.requestTimeoutMs ?? 5000) : (this.#o.shutdownTimeoutMs ?? 3000);
    const reply = new Promise<WorkerCallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // 超时必须真的杀掉子进程，否则会留下僵尸/挂起进程
        this.#state = "TIMEOUT";
        this.#child?.kill("SIGKILL");
        resolve({ ok: false, error: `plugin ${this.manifest.name} timed out after ${timeoutMs}ms`, state: "TIMEOUT" });
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          const msg = value as Record<string, unknown>;
          resolve({ ok: true, value: msg.result, state: this.#state });
        },
        reject: (err) => resolve({ ok: false, error: err.message, state: this.#state }),
        timer,
      });
    });
    this.#send({ v: IPC_SCHEMA_VERSION, type, id, ...payload });
    return reply;
  }

  async stop(): Promise<void> {
    if (!this.#child) {
      this.#state = "STOPPED";
      return;
    }
    this.#state = "STOPPING";
    const result = await this.request("shutdown");
    if (!result.ok) {
      this.#child.kill("SIGKILL");
    }
    await new Promise<void>((resolve) => {
      const child = this.#child;
      if (!child || child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.#state = "STOPPED";
    this.#child = null;
  }
}
