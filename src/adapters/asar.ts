/**
 * 最小 Electron ASAR 读取器（只读）。
 *
 * 用途：宿主未解包时也能证明「里面是什么版本、入口是什么」，而不是只看到一个大文件。
 * 格式（chromium Pickle 封装，实测 Electron 30+）：
 *   uint32=4 | uint32 headerSize | uint32 headerPayload | uint32 jsonLength | json | 文件数据
 *   数据区起点 = 8 + headerSize；JSON 起点 = 16
 * 只实现读取；不写入、不重建归档。
 */
import * as fsp from "node:fs/promises";
import { purgeError } from "../core/errors.ts";

export interface AsarHeader {
  files: Record<string, AsarNode>;
}

export interface AsarNode {
  files?: Record<string, AsarNode>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  link?: string;
  executable?: boolean;
}

export interface AsarIndex {
  header: AsarHeader;
  headerSize: number;
  dataOffset: number;
}

const PREFIX = 16;
const JSON_OFFSET = 16;

export async function readAsarIndex(file: string): Promise<AsarIndex> {
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(PREFIX);
    const { bytesRead } = await fh.read(buf, 0, PREFIX, 0);
    if (bytesRead < PREFIX) throw purgeError("schema_invalid", `asar too small: ${file}`);
    const a = buf.readUInt32LE(0);
    const headerSize = buf.readUInt32LE(4);
    const headerPayload = buf.readUInt32LE(8);
    const jsonLength = buf.readUInt32LE(12);
    if (a !== 4) {
      throw purgeError("schema_invalid", `not an asar archive (pickle prefix ${a}): ${file}`);
    }
    if (headerSize < 8 || headerSize > 64 * 1024 * 1024) {
      throw purgeError("schema_invalid", `implausible asar header size ${headerSize}: ${file}`);
    }
    if (jsonLength === 0 || jsonLength > headerSize || headerPayload > headerSize) {
      throw purgeError("schema_invalid", `implausible asar header sizes ${headerSize}/${headerPayload}/${jsonLength}: ${file}`);
    }
    const jsonBuf = Buffer.alloc(jsonLength);
    await fh.read(jsonBuf, 0, jsonLength, JSON_OFFSET);
    const text = jsonBuf.toString("utf8").replace(/\0+$/g, "");
    const header = JSON.parse(text) as AsarHeader;
    const dataOffset = 8 + headerSize;
    const probe = Buffer.alloc(0);
    void probe;
    return { header, headerSize, dataOffset };
  } catch (err) {
    if (err instanceof Error && "code" in err) throw err;
    throw purgeError("unreadable", `failed to read asar index: ${file}: ${(err as Error).message}`);
  } finally {
    await fh.close();
  }
}

/** 解析 `dir/file.json` 形式路径，返回节点；不存在返回 undefined。 */
export function lookupAsarNode(index: AsarIndex, entryPath: string): AsarNode | undefined {
  const parts = entryPath.split(/[\\/]+/).filter((p) => p.length > 0 && p !== ".");
  let node: AsarNode | undefined = { files: index.header.files };
  for (const part of parts) {
    const next: AsarNode | undefined = node?.files?.[part];
    if (!next) return undefined;
    node = next;
  }
  return node;
}

export async function readAsarFile(file: string, entryPath: string, index?: AsarIndex): Promise<Buffer> {
  const idx = index ?? (await readAsarIndex(file));
  const node = lookupAsarNode(idx, entryPath);
  if (!node) throw purgeError("not_found", `asar entry not found: ${entryPath}`, { file, entryPath });
  if (node.unpacked) throw purgeError("unsupported", `entry is stored unpacked: ${entryPath}`);
  if (node.link) return readAsarFile(file, node.link, idx);
  if (node.size === undefined) throw purgeError("invalid_argument", `asar entry is a directory: ${entryPath}`);
  const offset = idx.dataOffset + Number(node.offset ?? "0");
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(node.size);
    const { bytesRead } = await fh.read(buf, 0, node.size, offset);
    if (bytesRead !== node.size) {
      throw purgeError("integrity_failed", `short read for ${entryPath}: ${bytesRead}/${node.size}`);
    }
    return buf;
  } finally {
    await fh.close();
  }
}

export async function readAsarJson<T = unknown>(file: string, entryPath: string): Promise<T> {
  const buf = await readAsarFile(file, entryPath);
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch (err) {
    throw purgeError("schema_invalid", `invalid json inside asar ${entryPath}: ${(err as Error).message}`);
  }
}

/** 列出顶层条目名（用于展示归档结构，不遍历整棵树）。 */
export function listAsarTop(index: AsarIndex): string[] {
  return Object.keys(index.header.files).sort();
}
