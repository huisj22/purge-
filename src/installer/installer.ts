/**
 * 安装器状态机（T-035）。
 *
 * PRECHECK → VALIDATE → PREPARE → BACKUP → STAGE → VERIFY → INSTALL → POSTCHECK → COMMIT
 * 任一步失败 → ROLLBACK；回滚结果本身也要验证（ROLLBACK_COMPLETED / ROLLBACK_FAILED）。
 *
 * 设计要点：
 * - 状态落盘到**父目录**（`.purgeplus-install-state.json`），即使安装目录被移动/删除也能看到失败阶段。
 * - 旧版本先 rename 成备份（原子），失败时 rename 回来；绝不 `rm -rf` 旧版本再装新的。
 * - 幂等：源与目标的"文件集哈希"一致时直接 NOOP，不重复备份、不重复写状态。
 * - 后置验证：实际拉起安装后的 CLI 做一次 doctor，而不是只看文件是否存在。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, ensureDir, sha256File } from "../core/atomic.ts";
import { purgeError } from "../core/errors.ts";
import { createTarGz, readTarGz } from "./archive.ts";
import { FileLock } from "../core/lock.ts";
import { formatPreflight, preflight, type CheckItem, type PreflightResult } from "./preflight.ts";

export type InstallPhase =
  | "NOT_STARTED"
  | "PREFLIGHT"
  | "VALIDATING"
  | "PREPARING"
  | "BACKUP_COMPLETED"
  | "STAGED"
  | "INSTALLING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "ROLLBACK_REQUIRED"
  | "ROLLBACK_COMPLETED"
  | "ROLLBACK_FAILED";

export interface InstallState {
  schema: "purgeplus.install-state/1";
  phase: InstallPhase;
  version?: string;
  installDir: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
  backupDir?: string;
  stagingDir?: string;
  log: Array<{ at: string; phase: InstallPhase; message: string }>;
}

export interface InstallOptions {
  installDir: string;
  /** 源码目录（二选一）。 */
  sourceDir?: string;
  /** 包文件（.tar.gz）（二选一）。 */
  packageFile?: string;
  /** 数据目录，用于检测运行中的实例；默认不检查。 */
  dataDir?: string;
  /** 是否保留旧版本备份（默认保留，最多 3 份）。 */
  keepBackups?: number;
  /** 相位钩子（UI 进度 / 故障注入用）。 */
  onPhase?: (phase: InstallPhase, state: InstallState) => void | Promise<void>;
  /** 测试用：覆盖 postcheck 命令。 */
  postCheckRunner?: (installDir: string) => Promise<{ ok: boolean; detail: string }>;
}

export interface InstallResult {
  phase: InstallPhase;
  installDir: string;
  version: string;
  idempotent: boolean;
  preflight: PreflightResult;
  postCheck?: { ok: boolean; detail: string };
  backupDir?: string;
  stateFile: string;
}

const EXCLUDED_DIRS = new Set(["node_modules", ".git", "_research", "references", "reports", ".purge-data", ".purge"]);
const STATE_BASENAME = ".purgeplus-install-state.json";

export class Installer {
  readonly installDir: string;
  readonly stateFile: string;
  readonly #opts: InstallOptions;
  #state: InstallState;

  constructor(opts: InstallOptions) {
    this.#opts = opts;
    this.installDir = path.resolve(opts.installDir);
    this.stateFile = path.join(path.dirname(this.installDir), STATE_BASENAME);
    this.#state = {
      schema: "purgeplus.install-state/1",
      phase: "NOT_STARTED",
      installDir: this.installDir,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      log: [],
    };
  }

  get state(): InstallState {
    return this.#state;
  }

  async install(): Promise<InstallResult> {
    // 0) 跨进程安装锁：同一父目录只允许一个安装器
    const lock = new FileLock({ dataDir: path.dirname(this.installDir), resource: "install", operation: "install" });
    const acquired = await lock.acquire();
    if (acquired.state === "RECOVERY_REQUIRED") {
      throw purgeError("policy_denied", `install lock is in an unknown state: ${acquired.detail}`, { path: acquired.path });
    }
    if (acquired.state !== "ACQUIRED") {
      throw purgeError("conflict", `another install is in progress (${acquired.state})`, { path: acquired.path, detail: acquired.detail });
    }
    let result: InstallResult | null = null;
    let failure: unknown = null;
    try {
      result = await this.#installLocked();
    } catch (err) {
      failure = err;
    }
    const released = await lock.release();
    if (failure) throw failure; // 保留原始错误（不能被释放失败掩盖）
    if (!released.ok) {
      throw purgeError("internal", `failed to release install lock: ${released.detail}`);
    }
    return result as InstallResult;
  }

  async #installLocked(): Promise<InstallResult> {
    // 1) PREFLIGHT
    const pf = await preflight({ installDir: this.installDir, ...(this.#opts.dataDir ? { dataDir: this.#opts.dataDir } : {}) });
    await this.#set("PREFLIGHT", `preflight: ${pf.checks.filter((c) => c.status === "FAIL").length} fail`);
    if (pf.blocked) {
      await this.#fail("PREFLIGHT", `安装前置检查失败`, formatPreflight(pf));
      throw purgeError("policy_denied", "install blocked by preflight check", { preflight: pf });
    }

    // 2) VALIDATE：确认来源可用
    await this.#set("VALIDATING", "validating source");
    const source = await this.#resolveSource();

    // 3) PREPARING：创建 staging
    await this.#set("PREPARING", `staging from ${source.kind}`);
    const parent = path.dirname(this.installDir);
    await ensureDir(parent);
    const staging = path.join(parent, `.purgeplus-staging-${Date.now().toString(36)}`);
    let backupDir: string | undefined;
    try {
      if (source.kind === "package") {
        await this.#extractPackage(source.packageFile as string, staging);
      } else {
        await this.#copyTree(source.sourceDir as string, staging);
      }

      // 4) VERIFY staging 完整性
      await this.#set("STAGED", "staged; verifying");
      const stagedManifest = await hashTree(staging);
      if (source.kind === "source") {
        const sourceManifest = await hashTree(source.sourceDir as string);
        if (JSON.stringify(stagedManifest) !== JSON.stringify(sourceManifest)) {
          throw purgeError("integrity_failed", "staged tree differs from source");
        }
      }

      // 幂等：目标已存在且文件集一致 → NOOP
      const targetManifest = await hashTree(this.installDir).catch(() => []);
      const same = targetManifest.length > 0 && JSON.stringify(targetManifest) === JSON.stringify(stagedManifest);
      const version = await readVersion(staging);
      if (same) {
        await fsp.rm(staging, { recursive: true, force: true });
        await this.#set("COMPLETED", `idempotent: ${version} already installed`);
        return { phase: "COMPLETED", installDir: this.installDir, version, idempotent: true, preflight: pf, stateFile: this.stateFile };
      }

      // 5) BACKUP：旧版本原子改名（不删除）
      const hadExisting = await fsp
        .stat(this.installDir)
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (hadExisting) {
        backupDir = path.join(parent, `.purgeplus-backup-${Date.now().toString(36)}`);
        await fsp.rename(this.installDir, backupDir);
        this.#state.backupDir = backupDir;
        await this.#set("BACKUP_COMPLETED", `backup at ${backupDir}`);
      }

      // 6) INSTALL：staging → installDir（原子 rename）
      await this.#set("INSTALLING", "moving staging into place");
      await fsp.rename(staging, this.installDir);

      // 7) POSTCHECK：实际拉起 CLI
      await this.#set("VERIFYING", "running post-install health check");
      const postCheck = await this.#postCheck();
      if (!postCheck.ok) {
        throw purgeError("integrity_failed", `post-install check failed: ${postCheck.detail}`);
      }

      // 8) COMMIT
      await this.#set("COMPLETED", `installed ${version}`);
      await this.#writeInstalledState(version);
      await this.#pruneBackups();
      return {
        phase: "COMPLETED",
        installDir: this.installDir,
        version,
        idempotent: false,
        preflight: pf,
        postCheck,
        ...(backupDir ? { backupDir } : {}),
        stateFile: this.stateFile,
      };
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      return this.#rollback(pf, err, backupDir);
    }
  }

  /** 卸载：默认保留用户数据（数据目录不在 installDir 内）。 */
  async uninstall(opts: { purgeData?: boolean; dataDir?: string } = {}): Promise<{ removed: string[]; keptData?: string }> {
    const exists = await fsp.stat(this.installDir).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) throw purgeError("not_found", `not installed: ${this.installDir}`);
    await this.#set("INSTALLING", "uninstalling");
    await fsp.rm(this.installDir, { recursive: true, force: true });
    const removed = [this.installDir];
    let keptData: string | undefined;
    if (opts.dataDir && opts.purgeData !== true) keptData = opts.dataDir;
    if (opts.dataDir && opts.purgeData === true) {
      await fsp.rm(opts.dataDir, { recursive: true, force: true });
      removed.push(opts.dataDir);
    }
    await this.#set("NOT_STARTED", "uninstalled");
    await fsp.rm(this.stateFile, { force: true });
    return { removed, ...(keptData ? { keptData } : {}) };
  }

  async #resolveSource(): Promise<{ kind: "source" | "package"; sourceDir?: string; packageFile?: string }> {
    if (this.#opts.packageFile) {
      const file = path.resolve(this.#opts.packageFile);
      const st = await fsp.stat(file).catch(() => null);
      if (!st?.isFile()) throw purgeError("not_found", `package not found: ${file}`);
      // 包必须在进入安装流程之前完成校验：损坏的包不进入状态机，直接拒绝
      const verified = await verifyPackage(file);
      if (!verified.ok) {
        throw purgeError("integrity_failed", `package verification failed: ${verified.problems.slice(0, 3).join("; ")}`, {
          packageFile: file,
          problems: verified.problems,
        });
      }
      return { kind: "package", packageFile: file };
    }
    if (this.#opts.sourceDir) {
      const dir = path.resolve(this.#opts.sourceDir);
      const ok = await fsp
        .stat(path.join(dir, "package.json"))
        .then((s) => s.isFile())
        .catch(() => false);
      if (!ok) throw purgeError("not_found", `source is not a Purge+ tree: ${dir}`);
      return { kind: "source", sourceDir: dir };
    }
    throw purgeError("invalid_argument", "install requires sourceDir or packageFile");
  }

  async #copyTree(src: string, dest: string): Promise<void> {
    await ensureDir(dest);
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".purgeplus-")) continue;
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isSymbolicLink()) continue; // 不把链接带进安装目录
      if (entry.isDirectory()) {
        await this.#copyTree(from, to);
        continue;
      }
      if (entry.isFile()) {
        await ensureDir(path.dirname(to));
        await fsp.copyFile(from, to);
      }
    }
  }

  async #extractPackage(file: string, dest: string): Promise<void> {
    const buf = await fsp.readFile(file);
    const parsed = readTarGz(buf);
    const manifestEntry = parsed.entries.find((e) => e.path === "MANIFEST.json");
    if (!manifestEntry) throw purgeError("schema_invalid", "package is missing MANIFEST.json");
    const manifest = JSON.parse(manifestEntry.data.toString("utf8")) as { files: Array<{ path: string; sha256: string }>; version: string };
    for (const entry of parsed.entries) {
      if (entry.path === "MANIFEST.json" || entry.path === "SHA256SUMS") continue;
      const expected = manifest.files.find((f) => f.path === entry.path);
      if (!expected) throw purgeError("integrity_failed", `package contains unexpected file: ${entry.path}`);
      const actual = createHash("sha256").update(entry.data).digest("hex");
      if (actual !== expected.sha256) throw purgeError("integrity_failed", `package entry hash mismatch: ${entry.path}`);
      const out = path.join(dest, entry.path);
      await ensureDir(path.dirname(out));
      await fsp.writeFile(out, entry.data, { mode: entry.mode });
    }
    if (manifest.files.length !== parsed.entries.filter((e) => e.path !== "MANIFEST.json" && e.path !== "SHA256SUMS").length) {
      throw purgeError("integrity_failed", "package manifest does not match archive contents");
    }
  }

  async #postCheck(): Promise<{ ok: boolean; detail: string }> {
    if (this.#opts.postCheckRunner) return this.#opts.postCheckRunner(this.installDir);
    const cli = path.join(this.installDir, "src", "cli", "main.ts");
    const dataDir = path.join(path.dirname(this.installDir), `.purgeplus-postcheck-${Date.now().toString(36)}`);
    try {
      const result = await runNode([cli, "doctor", "--data-dir", dataDir], 60_000);
      const ok = result.code === 0 && /审计链/.test(result.stdout);
      return { ok, detail: ok ? "doctor exit 0 且包含审计链输出" : `exit=${result.code} stdout=${result.stdout.slice(0, 200)} stderr=${result.stderr.slice(0, 200)}` };
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #rollback(pf: PreflightResult, err: unknown, backupDir?: string): Promise<InstallResult> {
    const message = (err as Error).message;
    await this.#set("ROLLBACK_REQUIRED", `failure: ${message}`);
    try {
      await fsp.rm(this.installDir, { recursive: true, force: true });
      if (backupDir) {
        const exists = await fsp.stat(backupDir).then((s) => s.isDirectory()).catch(() => false);
        if (!exists) throw new Error(`backup is missing: ${backupDir}`);
        await fsp.rename(backupDir, this.installDir);
      }
      await this.#set("ROLLBACK_COMPLETED", "rolled back");
      const version = backupDir ? await readVersion(this.installDir).catch(() => "unknown") : "unknown";
      return {
        phase: "ROLLBACK_COMPLETED",
        installDir: this.installDir,
        version,
        idempotent: false,
        preflight: pf,
        ...(backupDir ? { backupDir } : {}),
        stateFile: this.stateFile,
      };
    } catch (rollbackErr) {
      this.#state.error = `original: ${message}; rollback: ${(rollbackErr as Error).message}`;
      await this.#set("ROLLBACK_FAILED", `rollback failed: ${(rollbackErr as Error).message}`);
      throw purgeError("internal", `install failed (${message}) and rollback failed (${(rollbackErr as Error).message})`, {
        installDir: this.installDir,
        backupDir,
        stateFile: this.stateFile,
        originalError: message,
      });
    }
  }

  async #fail(phase: InstallPhase, message: string, detail?: string): Promise<void> {
    this.#state.phase = "FAILED";
    this.#state.error = detail ? `${message}: ${detail}` : message;
    this.#state.updatedAt = new Date().toISOString();
    this.#state.log.push({ at: this.#state.updatedAt, phase, message: message.slice(0, 500) });
    await this.#persist();
  }

  async #set(phase: InstallPhase, message: string): Promise<void> {
    this.#state.phase = phase;
    this.#state.updatedAt = new Date().toISOString();
    this.#state.log.push({ at: this.#state.updatedAt, phase, message: message.slice(0, 500) });
    if (this.#state.log.length > 200) this.#state.log = this.#state.log.slice(-200);
    await this.#persist();
    if (this.#opts.onPhase) await this.#opts.onPhase(phase, this.#state);
  }

  async #persist(): Promise<void> {
    await ensureDir(path.dirname(this.stateFile));
    await atomicWriteFile(this.stateFile, `${JSON.stringify(this.#state, null, 2)}\n`);
  }

  async #writeInstalledState(version: string): Promise<void> {
    const inner = path.join(this.installDir, ".purgeplus", "install-state.json");
    await ensureDir(path.dirname(inner));
    await atomicWriteFile(inner, `${JSON.stringify({ ...this.#state, version }, null, 2)}\n`);
  }

  async #pruneBackups(): Promise<void> {
    const keep = this.#opts.keepBackups ?? 3;
    const parent = path.dirname(this.installDir);
    const entries = (await fsp.readdir(parent).catch(() => [] as string[])).filter((e) => e.startsWith(".purgeplus-backup-")).sort();
    const excess = entries.slice(0, Math.max(0, entries.length - keep));
    for (const dir of excess) {
      await fsp.rm(path.join(parent, dir), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** 计算文件集哈希（相对路径 + sha256，忽略被排除目录与状态文件）。 */
export async function hashTree(root: string): Promise<Array<{ path: string; sha256: string; size: number }>> {
  const out: Array<{ path: string; sha256: string; size: number }> = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name === STATE_BASENAME || entry.name === ".purgeplus") continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        const st = await fsp.stat(abs);
        out.push({ path: relPath, sha256: await sha256File(abs), size: st.size });
      }
    }
  };
  await walk(root, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function readVersion(dir: string): Promise<string> {
  const raw = await fsp.readFile(path.join(dir, "package.json"), "utf8").catch(() => "");
  if (!raw) throw purgeError("schema_invalid", `no package.json in ${dir}`);
  const pkg = JSON.parse(raw) as { name?: string; version?: string };
  if (pkg.name !== "purge-plus") throw purgeError("schema_invalid", `unexpected package name: ${pkg.name}`);
  return pkg.version ?? "0.0.0";
}

function runNode(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` });
    });
  });
}

/** 打包：生成 .tar.gz + MANIFEST.json（含每个文件的 sha256 + 版本）。 */
export async function createPackage(opts: { sourceDir: string; outFile: string }): Promise<{ outFile: string; version: string; files: number; bytes: number; sha256: string }> {
  const sourceDir = path.resolve(opts.sourceDir);
  const version = await readVersion(sourceDir);
  const files = await hashTree(sourceDir);
  const entries = [];
  for (const f of files) {
    const data = await fsp.readFile(path.join(sourceDir, f.path));
    entries.push({ path: f.path, data, mode: 0o644 });
  }
  const manifest = { schema: "purgeplus.package/1", name: "purge-plus", version, createdAt: new Date().toISOString(), files };
  entries.push({ path: "MANIFEST.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o644 });
  const sums = files.map((f) => `${f.sha256}  ${f.path}`).join("\n") + "\n";
  entries.push({ path: "SHA256SUMS", data: Buffer.from(sums), mode: 0o644 });
  const buf = createTarGz(entries);
  const outFile = path.resolve(opts.outFile);
  await ensureDir(path.dirname(outFile));
  await atomicWriteFile(outFile, buf);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { outFile, version, files: files.length, bytes: buf.length, sha256 };
}

/** 校验包：解析 + 逐文件哈希 + 与 MANIFEST 对齐。 */
export async function verifyPackage(file: string): Promise<{ ok: boolean; version: string; files: number; problems: string[] }> {
  const buf = await fsp.readFile(file);
  const parsed = readTarGz(buf);
  const manifestEntry = parsed.entries.find((e) => e.path === "MANIFEST.json");
  if (!manifestEntry) return { ok: false, version: "unknown", files: 0, problems: ["missing MANIFEST.json"] };
  const manifest = JSON.parse(manifestEntry.data.toString("utf8")) as { version: string; files: Array<{ path: string; sha256: string }> };
  const problems: string[] = [];
  const byPath = new Map(parsed.entries.map((e) => [e.path, e]));
  for (const f of manifest.files) {
    const entry = byPath.get(f.path);
    if (!entry) {
      problems.push(`missing: ${f.path}`);
      continue;
    }
    const actual = createHash("sha256").update(entry.data).digest("hex");
    if (actual !== f.sha256) problems.push(`hash mismatch: ${f.path}`);
  }
  return { ok: problems.length === 0, version: manifest.version, files: manifest.files.length, problems };
}

export { formatPreflight, type CheckItem };
