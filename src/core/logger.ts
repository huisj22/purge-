/**
 * 结构化日志 + 强制脱敏。
 * 任何写入日志的对象都经过 redact()，避免 token/密码进入磁盘。
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /(token|secret|password|passwd|apikey|api_key|authorization|cookie|credential|private_?key)/i;
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[depth-limit]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** 兜底：形如 `Authorization: Bearer xyz` / `token=abc` 的内联串也脱敏。 */
function redactString(s: string): string {
  let out = s.replace(/\b(Bearer|token|apikey|password)\b([=:\s]+)([A-Za-z0-9._~+/-]{8,})/gi, "$1$2[redacted]");
  out = out.replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted-github-token]");
  return out;
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  ctx?: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: unknown): void;
  info(msg: string, ctx?: unknown): void;
  warn(msg: string, ctx?: unknown): void;
  error(msg: string, ctx?: unknown): void;
  child(bindings: Record<string, unknown>): Logger;
  readonly records: LogRecord[];
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 测试用：捕获而不是打印。 */
  sink?: (rec: LogRecord) => void;
  bindings?: Record<string, unknown>;
  /** 内存保留上限，防止长跑进程无限增长。 */
  maxRecords?: number;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level: LogLevel = opts.level ?? "info";
  const threshold = LEVEL_ORDER[level];
  const records: LogRecord[] = [];
  const maxRecords = opts.maxRecords ?? 2000;
  const bindings = opts.bindings;

  const emit = (lvl: LogLevel, msg: string, ctx?: unknown): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const payload = bindings === undefined && ctx === undefined
      ? undefined
      : { ...(bindings ?? {}), ...(ctx && typeof ctx === "object" ? (ctx as object) : ctx === undefined ? {} : { value: ctx }) };
    const rec: LogRecord = { ts: new Date().toISOString(), level: lvl, msg };
    if (payload !== undefined) rec.ctx = redact(payload);
    records.push(rec);
    if (records.length > maxRecords) records.shift();
    if (opts.sink) opts.sink(rec);
  };

  const logger: Logger = {
    debug: (m, c) => emit("debug", m, c),
    info: (m, c) => emit("info", m, c),
    warn: (m, c) => emit("warn", m, c),
    error: (m, c) => emit("error", m, c),
    child: (b) => createLogger({ ...opts, level, bindings: { ...(bindings ?? {}), ...b } }),
    get records() {
      return records;
    },
  };
  return logger;
}
