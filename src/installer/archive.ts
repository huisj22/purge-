/**
 * 最小 tar(.gz) 读写器（无外部依赖）。
 *
 * 用途：打包与安装都需要"可校验的归档"，而 Node 标准库没有 tar。
 * 支持：ustar 头、普通文件、目录；不支持符号链接/硬链接/稀疏文件（遇到即拒绝，避免静默丢数据）。
 * 安全：解包时拒绝绝对路径、`..`、超长路径、超限体积。
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { purgeError } from "../core/errors.ts";

export interface ArchiveEntry {
  path: string;
  data: Buffer;
  mode?: number;
}

const BLOCK = 512;

export interface ArchiveLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEntryBytes?: number;
}

export function createTarGz(entries: ArchiveEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry));
    chunks.push(entry.data);
    const pad = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  // 结束块：两个全零块
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks));
}

function tarHeader(entry: ArchiveEntry): Buffer {
  const nameBuf = Buffer.from(entry.path, "utf8");
  if (nameBuf.length > 100) throw purgeError("invalid_argument", `archive path too long (>100 bytes): ${entry.path}`);
  if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
    throw purgeError("policy_denied", `archive path must be relative without ..: ${entry.path}`);
  }
  const header = Buffer.alloc(BLOCK);
  nameBuf.copy(header, 0);
  writeOctal(header, 100, 8, entry.mode ?? 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156); // checksum 先填空格
  header.write("0", 156, 1, "ascii");
  header.write("ustar", 257, 5, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  buf.write(text, offset, length - 1, "ascii");
  buf.write("\0", offset + length - 1, 1, "ascii");
}

export interface ParsedArchive {
  entries: Array<{ path: string; data: Buffer; mode: number }>;
  totalBytes: number;
}

export function readTarGz(buf: Buffer, limits: ArchiveLimits = {}): ParsedArchive {
  const maxEntries = limits.maxEntries ?? 20_000;
  const maxTotal = limits.maxTotalBytes ?? 512 * 1024 * 1024;
  const maxEntry = limits.maxEntryBytes ?? 64 * 1024 * 1024;
  let raw: Buffer;
  try {
    raw = gunzipSync(buf);
  } catch (err) {
    throw purgeError("schema_invalid", `not a gzip stream: ${(err as Error).message}`);
  }
  const entries: ParsedArchive["entries"] = [];
  let offset = 0;
  let totalBytes = 0;
  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // 结束块
    const name = readString(header, 0, 100);
    if (!name) break;
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw purgeError("policy_denied", `archive entry escapes root: ${name}`);
    }
    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8) || 0o644;
    const type = readString(header, 156, 1) || "0";
    offset += BLOCK;
    if (type === "5") continue; // 目录条目：跳过（父目录按需创建）
    if (type !== "0" && type !== "") {
      throw purgeError("unsupported", `unsupported tar entry type "${type}" for ${name}`);
    }
    if (size > maxEntry) throw purgeError("invalid_argument", `archive entry too large: ${name} (${size})`);
    if (offset + size > raw.length) throw purgeError("integrity_failed", `truncated archive at entry ${name}`);
    entries.push({ path: name, data: raw.subarray(offset, offset + size), mode });
    totalBytes += size;
    if (entries.length > maxEntries) throw purgeError("invalid_argument", `archive has too many entries (>${maxEntries})`);
    if (totalBytes > maxTotal) throw purgeError("invalid_argument", `archive too large (>${maxTotal} bytes)`);
    offset += size;
    offset += (BLOCK - (size % BLOCK)) % BLOCK;
  }
  return { entries, totalBytes };
}

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const text = readString(buf, offset, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}
