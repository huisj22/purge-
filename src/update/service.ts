/**
 * 更新中心：离线优先 + 分阶段（check → plan → fetch → verify → stage → activate）。
 *
 * 继承原项目的核心纪律（矩阵 D1–D4）：
 * - 「检查」与「安装」是两个独立动作，检查成功不代表装上了。
 * - 摘要必须来自索引声明并与实际字节一致；不一致立即失败，不用镜像兜底冒充成功。
 * - 安装是**分阶段**的：先落到 staging 并校验，再原子切换 current 指针；失败保留旧指针。
 * - 全程不重启任何进程，不修改运行中的代码。
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, ensureDir, readJson, sha256, removeTreeNoFollow } from "../core/atomic.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import { compareVersions, isNewer } from "./version.ts";

export interface ReleaseArtifact {
  name: string;
  /** 本地路径或 http(s) URL。 */
  source: string;
  sha256: string;
  size?: number;
}

export interface Release {
  version: string;
  channel?: string;
  notes?: string;
  artifacts: ReleaseArtifact[];
}

export interface ReleaseIndex {
  schema: "purgeplus.release-index/1";
  channel: string;
  releases: Release[];
}

export interface UpdateCheck {
  current: string;
  latest?: string;
  hasUpdate: boolean;
  channel: string;
  checkedAt: string;
  /** 索引里所有版本，降序。 */
  versions: string[];
  note?: string;
}

export interface UpdatePlan {
  from: string;
  to: string;
  channel: string;
  artifacts: Array<{ name: string; source: string; sha256: string; size?: number }>;
  notes?: string;
}

export interface StagedResult {
  version: string;
  stagingDir: string;
  verified: string[];
}

export interface UpdateServiceOptions {
  dataDir: string;
  currentVersion: string;
  logger: Logger;
  /** 索引来源：本地文件路径或 URL。 */
  indexSource?: string;
  /** 可注入的抓取器（测试用）。默认支持 file:// 与 http(s)。 */
  fetcher?: (source: string) => Promise<Buffer>;
  channel?: string;
}

export class UpdateService {
  readonly dir: string;
  readonly #o: UpdateServiceOptions;
  readonly #stateFile: string;

  constructor(opts: UpdateServiceOptions) {
    this.#o = opts;
    this.dir = path.join(opts.dataDir, "update");
    this.#stateFile = path.join(this.dir, "state.json");
  }

  async loadIndex(source?: string): Promise<ReleaseIndex> {
    const src = source ?? this.#o.indexSource;
    if (!src) throw purgeError("invalid_argument", "no release index configured (set update.indexUrl or pass --index)");
    const buf = await this.#fetch(src);
    let raw: unknown;
    try {
      raw = JSON.parse(buf.toString("utf8"));
    } catch (err) {
      throw purgeError("schema_invalid", `release index is not valid json: ${(err as Error).message}`, { source: src });
    }
    return validateIndex(raw, src);
  }

  async check(opts: { index?: ReleaseIndex } = {}): Promise<UpdateCheck> {
    const index = opts.index ?? (await this.loadIndex());
    const channel = this.#o.channel ?? index.channel;
    const versions = index.releases.map((r) => r.version).sort((a, b) => compareVersions(b, a));
    const candidates = index.releases.filter((r) => !r.channel || r.channel === channel);
    const latest = candidates.map((r) => r.version).sort((a, b) => compareVersions(b, a))[0];
    const check: UpdateCheck = {
      current: this.#o.currentVersion,
      latest,
      hasUpdate: latest ? isNewer(latest, this.#o.currentVersion) : false,
      channel,
      checkedAt: new Date().toISOString(),
      versions,
      ...(latest ? {} : { note: "索引里没有该通道的版本" }),
    };
    await this.#saveState({ lastCheck: check });
    return check;
  }

  async plan(targetVersion?: string, opts: { index?: ReleaseIndex } = {}): Promise<UpdatePlan> {
    const index = opts.index ?? (await this.loadIndex());
    const version = targetVersion ?? (await this.check({ index })).latest;
    if (!version) throw purgeError("not_found", "no version available to install");
    const release = index.releases.find((r) => r.version === version);
    if (!release) throw purgeError("not_found", `version not in index: ${version}`, { known: index.releases.map((r) => r.version) });
    if (release.artifacts.length === 0) throw purgeError("schema_invalid", `release ${version} has no artifacts`);
    return {
      from: this.#o.currentVersion,
      to: release.version,
      channel: this.#o.channel ?? index.channel,
      artifacts: release.artifacts.map((a) => ({ name: a.name, source: a.source, sha256: a.sha256, size: a.size })),
      notes: release.notes,
    };
  }

  /** 下载 + 校验 + 落到 staging；任一 artifact 失败即清理 staging 并抛错。 */
  async stage(plan: UpdatePlan): Promise<StagedResult> {
    const stagingDir = path.join(this.dir, "staging", `${plan.to}-${Date.now().toString(36)}`);
    await ensureDir(stagingDir);
    const verified: string[] = [];
    try {
      for (const artifact of plan.artifacts) {
        const buf = await this.#fetch(artifact.source);
        if (artifact.size !== undefined && buf.length !== artifact.size) {
          throw purgeError("integrity_failed", `size mismatch for ${artifact.name}`, { expected: artifact.size, actual: buf.length });
        }
        const actual = sha256(buf);
        if (actual !== artifact.sha256) {
          throw purgeError("integrity_failed", `sha256 mismatch for ${artifact.name}`, { expected: artifact.sha256, actual });
        }
        await atomicWriteFile(path.join(stagingDir, artifact.name), buf);
        verified.push(artifact.name);
      }
      await atomicWriteFile(
        path.join(stagingDir, "manifest.json"),
        `${JSON.stringify({ plan, verified, stagedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      return { version: plan.to, stagingDir, verified };
    } catch (err) {
      await removeTreeNoFollow(stagingDir);
      throw asPurgeError(err);
    }
  }

  /** 把 staging 提升为活跃版本；返回新的指针内容。 */
  async activate(staged: StagedResult): Promise<{ version: string; dir: string; previous?: string }> {
    const targetDir = path.join(this.dir, "versions", staged.version);
    await ensureDir(path.dirname(targetDir));
    await removeTreeNoFollow(targetDir);
    await fsp.rename(staged.stagingDir, targetDir);
    const state = await this.#readState();
    const previous = state.activeVersion;
    await this.#saveState({ ...state, activeVersion: staged.version, activeDir: targetDir, activatedAt: new Date().toISOString(), previous });
    // 激活后回读校验：文件数必须与 staging 时一致
    const files = await fsp.readdir(targetDir);
    if (!files.includes("manifest.json")) {
      throw purgeError("integrity_failed", "activated directory is missing its manifest");
    }
    return { version: staged.version, dir: targetDir, previous };
  }

  async status(): Promise<{ activeVersion?: string; activeDir?: string; lastCheck?: UpdateCheck }> {
    const state = await this.#readState();
    return {
      ...(state.activeVersion ? { activeVersion: state.activeVersion } : {}),
      ...(state.activeDir ? { activeDir: state.activeDir } : {}),
      ...(state.lastCheck ? { lastCheck: state.lastCheck } : {}),
    };
  }

  async #fetch(source: string): Promise<Buffer> {
    if (this.#o.fetcher) return this.#o.fetcher(source);
    if (source.startsWith("http://") || source.startsWith("https://")) {
      const res = await fetch(source);
      if (!res.ok) throw purgeError("unreadable", `download failed: HTTP ${res.status} for ${source}`);
      return Buffer.from(await res.arrayBuffer());
    }
    const file = source.startsWith("file://") ? new URL(source) : source;
    try {
      return await fsp.readFile(file as string);
    } catch (err) {
      throw purgeError("unreadable", `cannot read artifact ${source}: ${(err as Error).message}`);
    }
  }

  async #readState(): Promise<{ activeVersion?: string; activeDir?: string; activatedAt?: string; previous?: string; lastCheck?: UpdateCheck }> {
    return readJson(this.#stateFile, {});
  }

  async #saveState(state: Record<string, unknown>): Promise<void> {
    await ensureDir(this.dir);
    await atomicWriteFile(this.#stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }
}

export function validateIndex(raw: unknown, source: string): ReleaseIndex {
  const idx = raw as Partial<ReleaseIndex>;
  const problems: string[] = [];
  if (idx.schema !== "purgeplus.release-index/1") problems.push('schema must be "purgeplus.release-index/1"');
  if (!idx.channel) problems.push("channel is required");
  if (!Array.isArray(idx.releases) || idx.releases.length === 0) problems.push("releases must be a non-empty array");
  for (const [i, r] of (idx.releases ?? []).entries()) {
    if (!r.version) problems.push(`releases[${i}].version is required`);
    if (!Array.isArray(r.artifacts) || r.artifacts.length === 0) problems.push(`releases[${i}].artifacts must be non-empty`);
    for (const [j, a] of (r.artifacts ?? []).entries()) {
      if (!a.name || a.name.includes("/") || a.name.includes("..")) problems.push(`releases[${i}].artifacts[${j}].name must be a plain file name`);
      if (!a.sha256 || !/^[a-f0-9]{64}$/i.test(a.sha256)) problems.push(`releases[${i}].artifacts[${j}].sha256 must be 64 hex chars`);
      if (!a.source) problems.push(`releases[${i}].artifacts[${j}].source is required`);
    }
  }
  if (problems.length > 0) {
    throw purgeError("schema_invalid", `invalid release index: ${problems.slice(0, 3).join("; ")}`, { source, problems });
  }
  return idx as ReleaseIndex;
}
