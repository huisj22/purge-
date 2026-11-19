/**
 * cron-lite：5 字段（分 时 日 月 周）解析与下次触发时间计算。
 * 支持 `*`、步进写法（如 每 5 分钟）、单值、逗号列表、a-b 区间；周日可用 0 或 7。
 * 不做秒级与秒字段，避免与「每 tick 扫描」的调度模型混淆。
 */
import { purgeError } from "../core/errors.ts";

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  expr: string;
}

const RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7], // 周日允许 0 或 7；解析后统一归一为 0
];

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw purgeError("invalid_argument", `cron needs 5 fields, got ${parts.length}: "${expr}"`);
  const sets = parts.map((field, idx) => parseField(field, RANGES[idx] as [number, number], idx === 4));
  return {
    minutes: sets[0] as Set<number>,
    hours: sets[1] as Set<number>,
    days: sets[2] as Set<number>,
    months: sets[3] as Set<number>,
    weekdays: sets[4] as Set<number>,
    expr,
  };
}

function parseField(field: string, range: [number, number], isDow: boolean): Set<number> {
  const [lo, hi] = range;
  const out = new Set<number>();
  for (const chunk of field.split(",")) {
    if (chunk === "") throw purgeError("invalid_argument", `empty cron segment in "${field}"`);
    const [base, stepRaw] = chunk.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) throw purgeError("invalid_argument", `bad cron step "${chunk}"`);
    let start: number;
    let end: number;
    if (base === "*") {
      start = lo;
      end = hi;
    } else if (base !== undefined && base.includes("-")) {
      const [a, b] = base.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw purgeError("invalid_argument", `bad cron range "${chunk}"`);
      start = a as number;
      end = b as number;
    } else {
      const v = Number(base);
      if (!Number.isInteger(v)) throw purgeError("invalid_argument", `bad cron value "${chunk}"`);
      start = v;
      end = stepRaw === undefined ? v : hi;
    }
    if (start < lo || end > hi || start > end) {
      throw purgeError("invalid_argument", `cron value out of range in "${chunk}" (allowed ${lo}-${hi})`);
    }
    for (let v = start; v <= end; v += step) out.add(isDow && v === 7 ? 0 : v);
  }
  if (isDow && out.has(7)) out.delete(7);
  return out;
}

/** 从 from（含）之后开始找下一次触发时刻；找不到返回 null（最多扫 366 天）。 */
export function nextRun(spec: CronSpec, from: number): number | null {
  const start = new Date(from);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  const cursor = new Date(start.getTime());
  for (let i = 0; i < limit; i += 1) {
    const m = cursor.getMinutes();
    const h = cursor.getHours();
    const dom = cursor.getDate();
    const mon = cursor.getMonth() + 1;
    const dow = cursor.getDay();
    if (spec.minutes.has(m) && spec.hours.has(h) && spec.months.has(mon) && matchesDay(spec, dom, dow)) {
      return cursor.getTime();
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/** 日与周都受限制时按 Vixie cron 语义取「或」；只有一方受限时取「与」。 */
function matchesDay(spec: CronSpec, dom: number, dow: number): boolean {
  const domRestricted = spec.days.size !== 31; // 1..31
  const dowRestricted = spec.weekdays.size !== 7;
  const domOk = spec.days.has(dom);
  const dowOk = spec.weekdays.has(dow);
  if (domRestricted && dowRestricted) return domOk || dowOk;
  if (domRestricted) return domOk;
  if (dowRestricted) return dowOk;
  return true;
}

export function describeSchedule(schedule: Schedule): string {
  return schedule.type === "interval" ? `every ${schedule.seconds}s` : `cron ${schedule.expr}`;
}

export type Schedule = { type: "interval"; seconds: number } | { type: "cron"; expr: string };

export function validateSchedule(schedule: Schedule): void {
  if (schedule.type === "interval") {
    if (!Number.isInteger(schedule.seconds) || schedule.seconds < 1) {
      throw purgeError("invalid_argument", "interval seconds must be an integer >= 1");
    }
    return;
  }
  parseCron(schedule.expr);
}

export function computeNext(schedule: Schedule, from: number): number {
  if (schedule.type === "interval") return from + schedule.seconds * 1000;
  const spec = parseCron(schedule.expr);
  const next = nextRun(spec, from);
  if (next === null) throw purgeError("invalid_argument", `cron expression never fires: ${schedule.expr}`);
  return next;
}
