#!/usr/bin/env node
/**
 * 插件 Worker（T-036）。
 *
 * 由 Host 以独立子进程启动（`node worker-runtime.ts`），通过 IPC 通信：
 *   Host → Worker：{ v, type: "invoke" | "health" | "shutdown" | "capability_result", id, ... }
 *   Worker → Host：{ v, type: "ready" | "result" | "error" | "capability" | "log", id?, ... }
 *
 * 约束：
 * - Worker 只拿到插件目录与授权能力列表；**拿不到宿主对象引用**。
 * - 所有能力调用必须经 Host 审批（capability 消息），Worker 不能自行放行。
 * - Worker 侧也校验入站消息（类型/长度/id），非法消息直接拒绝并上报。
 */
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = 1;
const MAX_MESSAGE_BYTES = 1024 * 1024;

interface PluginModule {
  activate?: (ctx: unknown) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
  health?: () => unknown | Promise<unknown>;
  invoke?: (method: string, args: unknown) => unknown | Promise<unknown>;
}

interface InboundMessage {
  v?: number;
  type?: string;
  id?: string | null;
  method?: string;
  args?: unknown;
  service?: string;
  result?: unknown;
  error?: string;
}

const pluginDir = process.env.PURGE_PLUGIN_DIR ?? "";
const pluginName = process.env.PURGE_PLUGIN_NAME ?? "";
const entry = process.env.PURGE_PLUGIN_ENTRY ?? "";
const declared = new Set<string>(JSON.parse(process.env.PURGE_PLUGIN_CAPABILITIES ?? "[]") as string[]);

let mod: PluginModule | null = null;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextRequest = 1;

function send(message: Record<string, unknown>): void {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    process.send?.({ v: SCHEMA_VERSION, type: "error", id: message.id ?? null, error: "outbound message too large" });
    return;
  }
  process.send?.(message);
}

function callHost(op: string, args: unknown[]): Promise<unknown> {
  const id = `cap-${nextRequest++}`;
  const reply = new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`host call ${op} timed out`));
    }, 10_000);
  });
  send({ v: SCHEMA_VERSION, type: "capability", id, service: "__data__", method: op, args });
  return reply;
}

function makeContext(): Record<string, unknown> {
  return {
    name: pluginName,
    version: "worker",
    dataDir: process.env.PURGE_PLUGIN_DATA ?? "",
    log: (level: string, msg: unknown, ctx?: unknown) =>
      send({ v: SCHEMA_VERSION, type: "log", level, msg: String(msg).slice(0, 2000), ...(ctx === undefined ? {} : { ctx }) }),
    use: (service: string) => {
      if (!declared.has(service)) throw new Error(`capability "${service}" was not declared in the manifest`);
      // 每个方法调用都经 Host 审批；Worker 侧无法自行放行
      return new Proxy(
        {},
        {
          get: (_target, method) =>
            async (...args: unknown[]): Promise<unknown> => {
              const id = `cap-${nextRequest++}`;
              const reply = new Promise<unknown>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                setTimeout(() => {
                  if (pending.delete(id)) reject(new Error(`capability call ${service}.${String(method)} timed out in worker`));
                }, 10_000);
              });
              send({ v: SCHEMA_VERSION, type: "capability", id, service, method: String(method), args });
              return reply;
            },
        },
      );
    },
    // 数据访问必须经宿主（T055-03）：worker 自己不做路径判断，宿主拒绝即失败。
    data: {
      read: async (rel: string) => {
        const raw = await callHost("data.read", [rel]);
        // IPC 会把 Buffer 序列化成 {type:"Buffer",data:[...]}，这里还原
        if (Buffer.isBuffer(raw)) return raw;
        const obj = raw as { type?: string; data?: number[] } | null;
        if (obj && obj.type === "Buffer" && Array.isArray(obj.data)) return Buffer.from(obj.data);
        return Buffer.from(typeof raw === "string" ? raw : JSON.stringify(raw ?? ""), "utf8");
      },
      write: (rel: string, data: unknown) => callHost("data.write", [rel, data]),
      list: (rel?: string) => callHost("data.list", [rel ?? "."]),
      remove: (rel: string) => callHost("data.remove", [rel]),
    },
    store: {
      get: (key: string) => callHost("data.get", [key]),
      set: (key: string, value: unknown) => callHost("data.set", [key, value]),
    },
  };
}

function handleCapabilityReply(message: InboundMessage): void {
  const id = String(message.id ?? "");
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id);
  if (message.error) waiter.reject(new Error(String(message.error)));
  else waiter.resolve(message.result);
}

function validateInbound(message: unknown): string | null {
  if (!message || typeof message !== "object") return "not an object";
  const m = message as InboundMessage;
  if (m.v !== SCHEMA_VERSION) return `schema version mismatch (${String(m.v)})`;
  if (!["invoke", "health", "shutdown", "capability_result"].includes(String(m.type))) return `unknown message type "${String(m.type)}"`;
  const size = Buffer.byteLength(JSON.stringify(message), "utf8");
  if (size > MAX_MESSAGE_BYTES) return `message too large (${size})`;
  return null;
}

async function main(): Promise<void> {
  const url = pathToFileURL(`${pluginDir}/${entry}`).href;
  mod = (await import(url)) as PluginModule;
  if (typeof mod.activate === "function") await mod.activate(makeContext());
  send({ v: SCHEMA_VERSION, type: "ready", name: pluginName });

  process.on("message", (raw: unknown) => {
    void (async () => {
      const problem = validateInbound(raw);
      if (problem) {
        const id = (raw as InboundMessage | null)?.id ?? null;
        send({ v: SCHEMA_VERSION, type: "error", id, error: `invalid message: ${problem}` });
        return;
      }
      const message = raw as InboundMessage;
      if (message.type === "capability_result") {
        handleCapabilityReply(message);
        return;
      }
      const id = message.id ?? null;
      try {
        if (message.type === "health") {
          const health = typeof mod?.health === "function" ? await mod.health() : { ok: true, detail: "no health()" };
          send({ v: SCHEMA_VERSION, type: "result", id, result: health });
          return;
        }
        if (message.type === "invoke") {
          if (typeof mod?.invoke !== "function") throw new Error("plugin does not export invoke()");
          const result = await mod.invoke(String(message.method), message.args);
          send({ v: SCHEMA_VERSION, type: "result", id, result });
          return;
        }
        if (message.type === "shutdown") {
          try {
            if (typeof mod?.deactivate === "function") await mod.deactivate();
          } catch {
            /* 退出前清理失败不影响退出 */
          }
          send({ v: SCHEMA_VERSION, type: "result", id, result: { stopped: true } });
          setTimeout(() => process.exit(0), 10);
        }
      } catch (err) {
        send({ v: SCHEMA_VERSION, type: "error", id, error: String((err as Error)?.message ?? err) });
      }
    })();
  });
}

main().catch((err: unknown) => {
  send({ v: SCHEMA_VERSION, type: "error", id: null, error: `activate failed: ${(err as Error)?.message ?? String(err)}` });
  setTimeout(() => process.exit(1), 10);
});
