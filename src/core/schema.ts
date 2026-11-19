/**
 * 极简声明式 schema 校验（零依赖）。
 * 目标：配置与插件清单这类「已知形状的 JSON」能被确定性校验，
 * 错误必须带字段路径，未知字段保留但不生效（由调用方决定是否告警）。
 */
export type FieldSpec =
  | { kind: "string"; optional?: boolean; default?: string; enum?: readonly string[]; pattern?: RegExp; maxLength?: number }
  | { kind: "number"; optional?: boolean; default?: number; min?: number; max?: number; integer?: boolean }
  | { kind: "boolean"; optional?: boolean; default?: boolean }
  | { kind: "string[]"; optional?: boolean; default?: string[] }
  | { kind: "object"; optional?: boolean; fields: Schema; default?: Record<string, unknown> }
  | { kind: "record"; optional?: boolean; valueKind: "string" | "number" | "boolean"; default?: Record<string, unknown> };

export type Schema = Record<string, FieldSpec>;

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value: T;
  issues: ValidationIssue[];
  unknownKeys: string[];
}

function scalarOk(spec: FieldSpec, raw: unknown, path: string, issues: ValidationIssue[]): unknown {
  switch (spec.kind) {
    case "string": {
      if (typeof raw !== "string") {
        issues.push({ path, message: `expected string, got ${typeof raw}` });
        return undefined;
      }
      if (spec.enum && !spec.enum.includes(raw)) {
        issues.push({ path, message: `must be one of ${spec.enum.join("|")}, got "${raw}"` });
        return undefined;
      }
      if (spec.pattern && !spec.pattern.test(raw)) {
        issues.push({ path, message: `does not match ${String(spec.pattern)}` });
        return undefined;
      }
      if (spec.maxLength !== undefined && raw.length > spec.maxLength) {
        issues.push({ path, message: `length ${raw.length} exceeds ${spec.maxLength}` });
        return undefined;
      }
      return raw;
    }
    case "number": {
      if (typeof raw !== "number" || Number.isNaN(raw)) {
        issues.push({ path, message: `expected number, got ${typeof raw}` });
        return undefined;
      }
      if (spec.integer && !Number.isInteger(raw)) {
        issues.push({ path, message: "expected integer" });
        return undefined;
      }
      if (spec.min !== undefined && raw < spec.min) {
        issues.push({ path, message: `must be >= ${spec.min}` });
        return undefined;
      }
      if (spec.max !== undefined && raw > spec.max) {
        issues.push({ path, message: `must be <= ${spec.max}` });
        return undefined;
      }
      return raw;
    }
    case "boolean": {
      if (typeof raw !== "boolean") {
        issues.push({ path, message: `expected boolean, got ${typeof raw}` });
        return undefined;
      }
      return raw;
    }
    case "string[]": {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
        issues.push({ path, message: "expected string[]" });
        return undefined;
      }
      return [...raw];
    }
    case "record": {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        issues.push({ path, message: "expected object" });
        return undefined;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v !== spec.valueKind) {
          issues.push({ path: `${path}.${k}`, message: `expected ${spec.valueKind}, got ${typeof v}` });
          continue;
        }
        out[k] = v;
      }
      return out;
    }
    case "object": {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        issues.push({ path, message: "expected object" });
        return undefined;
      }
      const nested = validateSchema(spec.fields, raw as Record<string, unknown>, path);
      issues.push(...nested.issues);
      return nested.value;
    }
    default:
      return undefined;
  }
}

export function validateSchema<T extends object>(
  schema: Schema,
  input: Record<string, unknown>,
  prefix = "",
): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  const value: Record<string, unknown> = {};
  const known = new Set(Object.keys(schema));
  for (const [key, spec] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const has = Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
    if (!has) {
      if (spec.kind === "object") {
        // 嵌套对象即使缺省也要递归一遍：否则子字段的 default 永远不会生效。
        const nested = validateSchema(spec.fields, {}, path);
        issues.push(...nested.issues);
        value[key] = nested.value;
      } else if ("default" in spec && spec.default !== undefined) {
        value[key] = structuredClone(spec.default);
      } else if (!spec.optional) {
        issues.push({ path, message: "missing required field" });
      }
      continue;
    }
    const parsed = scalarOk(spec, input[key], path, issues);
    if (parsed !== undefined) value[key] = parsed;
  }
  const unknownKeys = Object.keys(input).filter((k) => !known.has(k));
  return { ok: issues.length === 0, value: value as T, issues, unknownKeys };
}
