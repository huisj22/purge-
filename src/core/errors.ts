/**
 * Purge+ 统一错误模型。
 * 设计约束：错误必须可被机器判定（code）+ 可被人读懂（message）+ 可留证据（detail）。
 */
export type ErrorCode =
  | "invalid_argument"
  | "not_found"
  | "conflict"
  | "unreadable"
  | "unwritable"
  | "policy_denied"
  | "confirmation_required"
  | "service_not_found"
  | "service_failed"
  | "schema_invalid"
  | "integrity_failed"
  | "timeout"
  | "unsupported"
  | "internal";

export interface PurgeErrorOptions {
  code: ErrorCode;
  message: string;
  detail?: unknown;
  cause?: unknown;
}

export class PurgeError extends Error {
  readonly code: ErrorCode;
  readonly detail?: unknown;

  constructor(opts: PurgeErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "PurgeError";
    this.code = opts.code;
    this.detail = opts.detail;
  }

  toJSON(): { code: ErrorCode; message: string; detail?: unknown } {
    const out: { code: ErrorCode; message: string; detail?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (this.detail !== undefined) out.detail = this.detail;
    return out;
  }
}

export function purgeError(code: ErrorCode, message: string, detail?: unknown): PurgeError {
  return new PurgeError({ code, message, detail });
}

/** 把任意抛出物归一为 PurgeError；未知异常不吞掉原始信息。 */
export function asPurgeError(err: unknown): PurgeError {
  if (err instanceof PurgeError) return err;
  if (err instanceof Error) {
    return new PurgeError({ code: "internal", message: err.message, cause: err });
  }
  return new PurgeError({ code: "internal", message: String(err) });
}
