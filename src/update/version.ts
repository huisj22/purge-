/**
 * 语义化版本比较（够用版）：支持 x.y.z[-pre][+build]。
 * 规则遵循 semver：带 prerelease 的版本小于对应正式版；prerelease 逐段比较，数字段小于字母段。
 */
import { purgeError } from "../core/errors.ts";

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseVersion(input: string): ParsedVersion {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!m) throw purgeError("invalid_argument", `invalid semver: ${input}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
