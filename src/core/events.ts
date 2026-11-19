/**
 * 进程内事件总线。
 * 约束：同步派发；单个监听器异常隔离并上报；监听器顺序稳定；退订幂等。
 */
import { asPurgeError } from "./errors.ts";

export type Handler<T = unknown> = (payload: T) => void;
export type Unsubscribe = () => void;

export interface EventBusOptions {
  onListenerError?: (event: string, err: unknown) => void;
}

export class EventBus {
  #handlers = new Map<string, Array<{ fn: Handler; once: boolean }>>();
  #onError: (event: string, err: unknown) => void;

  constructor(opts: EventBusOptions = {}) {
    this.#onError = opts.onListenerError ?? (() => {});
  }

  on<T = unknown>(event: string, fn: Handler<T>): Unsubscribe {
    const list = this.#handlers.get(event) ?? [];
    const entry = { fn: fn as Handler, once: false };
    list.push(entry);
    this.#handlers.set(event, list);
    return () => {
      const cur = this.#handlers.get(event);
      if (!cur) return;
      const idx = cur.indexOf(entry);
      if (idx >= 0) cur.splice(idx, 1);
      if (cur.length === 0) this.#handlers.delete(event);
    };
  }

  once<T = unknown>(event: string, fn: Handler<T>): Unsubscribe {
    const list = this.#handlers.get(event) ?? [];
    const entry = { fn: fn as Handler, once: true };
    list.push(entry);
    this.#handlers.set(event, list);
    return () => {
      const cur = this.#handlers.get(event);
      if (!cur) return;
      const idx = cur.indexOf(entry);
      if (idx >= 0) cur.splice(idx, 1);
    };
  }

  emit<T = unknown>(event: string, payload?: T): number {
    const list = this.#handlers.get(event);
    if (!list || list.length === 0) return 0;
    let delivered = 0;
    for (const entry of [...list]) {
      if (entry.once) {
        const idx = list.indexOf(entry);
        if (idx >= 0) list.splice(idx, 1);
      }
      try {
        entry.fn(payload as T);
        delivered += 1;
      } catch (err) {
        this.#onError(event, asPurgeError(err));
      }
    }
    if (list.length === 0) this.#handlers.delete(event);
    return delivered;
  }

  listenerCount(event: string): number {
    return this.#handlers.get(event)?.length ?? 0;
  }

  removeAll(event?: string): void {
    if (event === undefined) this.#handlers.clear();
    else this.#handlers.delete(event);
  }
}

export const EVENTS = {
  kernelStarted: "kernel.started",
  kernelStopped: "kernel.stopped",
  serviceFailed: "service.failed",
  hostDiscovered: "host.discovered",
  diagnosticCompleted: "diagnostic.completed",
  auditAppended: "audit.appended",
  jobDue: "job.due",
  runStateChanged: "run.state",
  traceFinished: "trace.finished",
  snapshotCreated: "snapshot.created",
  snapshotRestored: "snapshot.restored",
  policyDenied: "policy.denied",
} as const;
