/**
 * Kernel：服务注册 + 生命周期 + 事件总线宿主。
 *
 * 不变量（有测试）：
 * 1. register 后 start 前 get 可用（惰性构造）：服务构造失败要抛出，不留半实例。
 * 2. start() 幂等，多次调用返回同一 Promise。
 * 3. 任一服务 start 抛错 → 逆序 stop 已启动服务 → 抛出可读的聚合错误。
 * 4. stop() 逆序执行，单个 stop 失败不阻断其它服务。
 */
import { EventBus } from "./events.ts";
import { PurgeError, asPurgeError, purgeError } from "./errors.ts";
import { createLogger, type Logger } from "./logger.ts";

export interface Service {
  readonly id: string;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface KernelOptions {
  logger?: Logger;
  bus?: EventBus;
}

interface Entry<T = unknown> {
  id: string;
  factory: (k: Kernel) => T;
  instance?: T;
  started: boolean;
}

export class Kernel {
  #entries = new Map<string, Entry>();
  #order: string[] = [];
  #startPromise: Promise<void> | null = null;
  #started = false;
  readonly bus: EventBus;
  readonly logger: Logger;

  constructor(opts: KernelOptions = {}) {
    this.logger = opts.logger ?? createLogger();
    this.bus = opts.bus ?? new EventBus({ onListenerError: (e, err) => this.logger.warn("listener failed", { event: e, err }) });
  }

  register<T>(id: string, factory: (k: Kernel) => T): void {
    if (this.#entries.has(id)) throw purgeError("invalid_argument", `service already registered: ${id}`);
    this.#entries.set(id, { id, factory, started: false });
    this.#order.push(id);
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  get<T>(id: string): T {
    const entry = this.#entries.get(id);
    if (!entry) throw purgeError("service_not_found", `service not registered: ${id}`);
    if (entry.instance === undefined) {
      entry.instance = entry.factory(this) as unknown;
    }
    return entry.instance as T;
  }

  /** 已构造的服务 id 列表（用于诊断，不触发构造）。 */
  instantiated(): string[] {
    return this.#order.filter((id) => this.#entries.get(id)?.instance !== undefined);
  }

  ids(): string[] {
    return [...this.#order];
  }

  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = (async () => {
      const startedIds: string[] = [];
      for (const id of this.#order) {
        const entry = this.#entries.get(id);
        if (!entry) continue;
        try {
          const instance = this.get<Service>(id);
          if (typeof instance?.start === "function") await instance.start();
          entry.started = true;
          startedIds.push(id);
        } catch (err) {
          const e = asPurgeError(err);
          this.logger.error("service start failed", { id, code: e.code, message: e.message });
          this.bus.emit("service.failed", { id, error: e.toJSON() });
          for (const done of startedIds.reverse()) {
            await this.#safeStop(done);
          }
          throw new PurgeError({
            code: "service_failed",
            message: `service "${id}" failed to start: ${e.message}`,
            detail: { id, started: startedIds, cause: e.toJSON() },
          });
        }
      }
      this.#started = true;
      this.bus.emit("kernel.started", { services: startedIds });
      this.logger.info("kernel started", { services: startedIds.length });
    })();
    return this.#startPromise;
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      this.#startPromise = null;
      return;
    }
    for (const id of [...this.#order].reverse()) {
      await this.#safeStop(id);
    }
    this.#started = false;
    this.#startPromise = null;
    this.bus.emit("kernel.stopped", {});
    this.logger.info("kernel stopped");
  }

  get started(): boolean {
    return this.#started;
  }

  async #safeStop(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry || !entry.started) return;
    try {
      const instance = entry.instance as Service | undefined;
      if (typeof instance?.stop === "function") await instance.stop();
    } catch (err) {
      const e = asPurgeError(err);
      this.logger.warn("service stop failed", { id, code: e.code, message: e.message });
    } finally {
      entry.started = false;
    }
  }
}
