/**
 * 跨进程维护锁（T-037）。
 *
 * 为什么不用内存锁：CLI/UI/API 可能是三个进程，Promise/Map 互斥对它们无效。
 * 实现：`fs.mkdir` 的原子性（EEXIST）作为互斥原语——不用"先判断存在再创建"的竞态写法。
 *
 * 锁目录结构：
 *   <dataDir>/locks/<resource>.lock/
 *     owner.json   { schema, lockId, resource, scope, operation, pid, processStartTime, owner, createdAt, heartbeatAt, version }
 *
 * 状态语义：
 *   ACQUIRED          获取成功
 *   BUSY              被存活的持有者占用
 *   STALE             持有者已死 → 可回收（回收本身要留痕）
 *   RECOVERY_REQUIRED 元数据损坏/不可读 → 阻止写入，要求人工处理
 *   RELEASED          已释放
 *   FAILED            获取/释放过程出错
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile, ensureDir } from "../core/atomic.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";

export type LockState = "ACQUIRED" | "BUSY" | "STALE" | "RECOVERY_REQUIRED" | "RELEASED" | "FAILED";

/** 锁层级：数字越小越外层。所有多锁操作必须按此顺序获取。 */
export const LOCK_LEVELS = {
  global: 10,
  host: 20,
  config: 30,
  snapshot: 30,
  update: 30,
  plugin: 30,
  pack: 40,
  file: 50,
} as const;

export type LockScope = keyof typeof LOCK_LEVELS;

export interface LockOwner {
  schema: "purgeplus.lock/1";
  lockId: string;
  resource: string;
  scope: LockScope;
  operation: string;
  pid: number;
  /** 进程启动时间（用于识别 PID 复用）；拿不到时为 null（此时按"存活即 BUSY"处理）。 */
  processStartTime: string | null;
  owner: string;
  createdAt: string;
  heartbeatAt: string;
  version: number;
}

export interface AcquireResult {
  state: LockState;
  lockId?: string;
  path: string;
  owner?: LockOwner;
  detail?: string;
}

export interface AcquireOptions {
  dataDir: string;
  resource: string;
  scope?: LockScope;
  operation: string;
  owner?: string;
  /** 等待毫秒数（默认 0 = 不等待）。 */
  waitMs?: number;
  /** 轮询间隔（默认 100ms）。 */
  pollMs?: number;
  /** 持有超过该毫秒数视为过期（默认 30 分钟）。仅用于 STALE 判定参考。 */
  staleAfterMs?: number;
}

const LOCK_VERSION = 1;
const HARD_STALE_MS = 24 * 60 * 60 * 1000; // 超过 24h 的锁一律视为需要人工确认

export function lockDirRoot(dataDir: string): string {
  return path.join(dataDir, "locks");
}

export function lockPath(dataDir: string, resource: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(resource)) {
    throw purgeError("invalid_argument", `invalid lock resource name: ${resource}`);
  }
  return path.join(lockDirRoot(dataDir), `${resource}.lock`);
}

export class FileLock {
  readonly dataDir: string;
  readonly resource: string;
  readonly dir: string;
  readonly #opts: AcquireOptions;
  #owner: LockOwner | null = null;

  constructor(opts: AcquireOptions) {
    this.#opts = opts;
    this.dataDir = path.resolve(opts.dataDir);
    this.resource = opts.resource;
    this.dir = lockPath(this.dataDir, opts.resource);
  }

  get owner(): LockOwner | null {
    return this.#owner;
  }

  async acquire(): Promise<AcquireResult> {
    const deadline = Date.now() + (this.#opts.waitMs ?? 0);
    let last: AcquireResult | null = null;
    for (;;) {
      const result = await this.#tryAcquireOnce();
      if (result.state === "ACQUIRED" || result.state === "RECOVERY_REQUIRED" || result.state === "FAILED") {
        return result;
      }
      last = result;
      if (Date.now() >= deadline) return result;
      await sleep(this.#opts.pollMs ?? 100);
    }
    return last as AcquireResult;
  }

  async #tryAcquireOnce(): Promise<AcquireResult> {
    await ensureDir(path.dirname(this.dir));
    const owner = this.#buildOwner();
    // 先写临时目录（元数据先就位），再用 rename 原子占位：
    // 这样竞争者永远不会看到"锁目录存在但元数据缺失"的窗口。
    const tmp = `${this.dir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fsp.mkdir(tmp);
      await atomicWriteFile(path.join(tmp, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`);
      await fsp.rename(tmp, this.dir);
      this.#owner = owner;
      return { state: "ACQUIRED", lockId: owner.lockId, path: this.dir, owner };
    } catch (err) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      const code = (err as NodeJS.ErrnoException).code;
      // EEXIST / ENOTEMPTY / EPERM(Windows: 目标已存在) 都表示"已被占用"
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") {
        return { state: "FAILED", path: this.dir, detail: asPurgeError(err).message };
      }
    }
    // 已存在：读取持有者并判定
    const existing = await this.#readOwner();
    if (!existing.ok) {
      return { state: "RECOVERY_REQUIRED", path: this.dir, detail: existing.detail };
    }
    const observed = existing.owner;
    if (this.#isAlive(observed)) {
      return { state: "BUSY", path: this.dir, owner: observed, detail: `held by pid ${observed.pid} (${observed.operation})` };
    }
    // 持有者已死 → 尝试回收（先改名成 .stale-<ts> 留痕，再重建）
    const reclaimed = await this.#reclaimStale(observed);
    if (!reclaimed.ok) {
      return { state: "RECOVERY_REQUIRED", path: this.dir, owner: observed, detail: reclaimed.detail };
    }
    // 回收后重试一次（同样先写临时目录再原子占位）
    const retryTmp = `${this.dir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const fresh = this.#buildOwner();
      await fsp.mkdir(retryTmp);
      await atomicWriteFile(path.join(retryTmp, "owner.json"), `${JSON.stringify(fresh, null, 2)}\n`);
      await fsp.rename(retryTmp, this.dir);
      this.#owner = fresh;
      return { state: "ACQUIRED", lockId: fresh.lockId, path: this.dir, owner: fresh, detail: `reclaimed stale lock from pid ${observed.pid}` };
    } catch (err) {
      await fsp.rm(retryTmp, { recursive: true, force: true }).catch(() => {});
      return { state: "BUSY", path: this.dir, detail: `lost race while reclaiming: ${asPurgeError(err).message}` };
    }
  }

  async release(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.#owner) return { ok: true, detail: "not held" };
    const current = await this.#readOwner();
    if (!current.ok) {
      return { ok: false, detail: `cannot verify owner before release: ${current.detail}` };
    }
    if (current.owner.lockId !== this.#owner.lockId) {
      return { ok: false, detail: `lock was taken over by ${current.owner.lockId}` };
    }
    try {
      await fsp.rm(this.dir, { recursive: true, force: true });
      this.#owner = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: asPurgeError(err).message };
    }
  }

  async heartbeat(): Promise<boolean> {
    if (!this.#owner) return false;
    const current = await this.#readOwner();
    if (!current.ok || current.owner.lockId !== this.#owner.lockId) return false;
    const next = { ...current.owner, heartbeatAt: new Date().toISOString() };
    await atomicWriteFile(path.join(this.dir, "owner.json"), `${JSON.stringify(next, null, 2)}\n`);
    this.#owner = next;
    return true;
  }

  /** 只读探测（不获取锁）。 */
  async inspect(): Promise<AcquireResult> {
    try {
      await fsp.stat(this.dir);
    } catch {
      return { state: "RELEASED", path: this.dir };
    }
    const current = await this.#readOwner();
    if (!current.ok) return { state: "RECOVERY_REQUIRED", path: this.dir, detail: current.detail };
    if (this.#isAlive(current.owner)) return { state: "BUSY", path: this.dir, owner: current.owner };
    return { state: "STALE", path: this.dir, owner: current.owner, detail: `owner pid ${current.owner.pid} is not alive` };
  }

  #buildOwner(): LockOwner {
    const now = new Date().toISOString();
    return {
      schema: "purgeplus.lock/1",
      lockId: `${process.pid}-${randomUUID().slice(0, 12)}`,
      resource: this.resource,
      scope: this.#opts.scope ?? "file",
      operation: this.#opts.operation,
      pid: process.pid,
      processStartTime: thisProcessStartTime(),
      owner: this.#opts.owner ?? `${os.userInfo().username}@${os.hostname()}`,
      createdAt: now,
      heartbeatAt: now,
      version: LOCK_VERSION,
    };
  }

  async #readOwner(): Promise<{ ok: true; owner: LockOwner } | { ok: false; detail: string }> {
    const file = path.join(this.dir, "owner.json");
    let text: string;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch (err) {
      return { ok: false, detail: `owner.json unreadable: ${asPurgeError(err).message}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, detail: "owner.json is not valid JSON" };
    }
    const owner = parsed as Partial<LockOwner>;
    if (owner?.schema !== "purgeplus.lock/1" || typeof owner.pid !== "number" || typeof owner.lockId !== "string") {
      return { ok: false, detail: "owner.json is missing required fields" };
    }
    return { ok: true, owner: owner as LockOwner };
  }

  /** 存活判定：PID 存在 + （有启动时间时）启动时间一致 + 不超硬过期。 */
  #isAlive(owner: LockOwner): boolean {
    const created = Date.parse(owner.createdAt);
    if (Number.isFinite(created) && Date.now() - created > HARD_STALE_MS) {
      // 超过 24h 仍存在的锁：不自动回收，交由人工确认（避免长任务被误判）
      return true;
    }
    try {
      process.kill(owner.pid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM") return true; // 进程存在但无权发信号
      return false; // ESRCH = 不存在
    }
    // PID 存活：若双方都拿到启动时间且不一致 → PID 已被复用
    if (owner.processStartTime && processStartTimeOf(owner.pid)) {
      const now = processStartTimeOf(owner.pid);
      if (now && owner.processStartTime !== now) return false;
    }
    // 同一台机器上，同一个 pid 且启动时间不可比对 → 按存活处理（安全方向：阻塞）
    return true;
  }

  async #reclaimStale(owner: LockOwner): Promise<{ ok: boolean; detail?: string }> {
    const archive = `${this.dir}.stale-${Date.now().toString(36)}`;
    try {
      await fsp.rename(this.dir, archive);
      await atomicWriteFile(
        `${archive}/reclaimed.json`,
        `${JSON.stringify({ reclaimedAt: new Date().toISOString(), by: process.pid, previousOwner: owner }, null, 2)}\n`,
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: `cannot reclaim stale lock: ${asPurgeError(err).message}` };
    }
  }
}

/** 按层级顺序获取多个锁；任一失败按逆序释放已获取的。 */
export async function acquireMany(
  locks: Array<{ resource: string; scope?: LockScope; operation: string }>,
  base: { dataDir: string; owner?: string; waitMs?: number },
): Promise<{ ok: boolean; held: FileLock[]; failure?: AcquireResult; detail?: string }> {
  const sorted = [...locks].sort((a, b) => levelOf(a.scope) - levelOf(b.scope));
  for (let i = 1; i < sorted.length; i += 1) {
    if (levelOf(sorted[i]!.scope) < levelOf(sorted[i - 1]!.scope)) {
      return { ok: false, held: [], detail: "lock hierarchy violation: requested out of order" };
    }
  }
  const held: FileLock[] = [];
  for (const spec of sorted) {
    const lock = new FileLock({
      dataDir: base.dataDir,
      resource: spec.resource,
      operation: spec.operation,
      ...(spec.scope ? { scope: spec.scope } : {}),
      ...(base.owner ? { owner: base.owner } : {}),
      ...(base.waitMs !== undefined ? { waitMs: base.waitMs } : {}),
    });
    const result = await lock.acquire();
    if (result.state !== "ACQUIRED") {
      for (const h of held.reverse()) await h.release();
      return { ok: false, held: [], failure: result };
    }
    held.push(lock);
  }
  return { ok: true, held };
}

function levelOf(scope: LockScope | undefined): number {
  return scope ? LOCK_LEVELS[scope] : LOCK_LEVELS.file;
}

const _startTimes = new Map<number, string>();
function thisProcessStartTime(): string | null {
  return processStartTimeOf(process.pid);
}

/**
 * 进程启动时间：同一进程内查自己用 uptime 反推；查别的进程需要平台命令（慢），
 * 因此这里只对本进程给出精确值，其他进程返回 null（此时按"存活即 BUSY"处理）。
 */
export function processStartTimeOf(pid: number): string | null {
  if (pid === process.pid) {
    if (!_startTimes.has(pid)) {
      _startTimes.set(pid, new Date(Date.now() - os.uptime() * 1000).toISOString());
    }
    return _startTimes.get(pid) ?? null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 便捷包装：持有锁执行 fn，结束释放；获取失败抛 policy_denied / conflict。 */
export async function withLock<T>(spec: {
  dataDir: string;
  resource: string;
  operation: string;
  scope?: LockScope;
  owner?: string;
  waitMs?: number;
}, fn: (lock: FileLock) => Promise<T>): Promise<T> {
  const lock = new FileLock(spec);
  const acquired = await lock.acquire();
  if (acquired.state !== "ACQUIRED") {
    throw purgeError(acquired.state === "RECOVERY_REQUIRED" ? "policy_denied" : "conflict", `lock ${spec.resource} not acquired: ${acquired.state}`, {
      state: acquired.state,
      detail: acquired.detail,
      path: acquired.path,
    });
  }
  let value: T | undefined;
  let failure: unknown = null;
  try {
    value = await fn(lock);
  } catch (err) {
    failure = err;
  }
  const released = await lock.release();
  if (failure) throw failure; // 原始错误优先
  if (!released.ok) {
    // 释放失败必须可见：残留锁会阻塞后续操作（但不能掩盖业务错误）
    throw purgeError("internal", `failed to release lock ${spec.resource}: ${released.detail}`);
  }
  return value as T;
}

/**
 * 写操作统一入口：先取 global（维护级）锁，再取具体资源锁。
 *
 * 层级顺序固定为 global → resource，任何写路径都必须走这里，
 * 这样"恢复进行中"会自然阻塞其它写操作（含配置、插件、更新）。
 */
const heldByThisProcess = new Map<string, number>();

export async function withWriteGuard<T>(
  dataDir: string,
  spec: { resource: string; scope: LockScope; operation: string; owner?: string; waitMs?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${path.resolve(dataDir)}:${spec.resource}`;
  // 已在本次调用栈内持有该资源 → 直接重入（restore → capture 就是这种情况）。
  // 必须在排队**之前**判断，否则会等自己释放，形成自死锁。
  if ((heldByThisProcess.get(key) ?? 0) > 0) {
    heldByThisProcess.set(key, (heldByThisProcess.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      heldByThisProcess.set(key, (heldByThisProcess.get(key) ?? 1) - 1);
    }
  }
  // 进程内同一资源必须排队而不是并发抢锁：否则第二个调用会拿到 BUSY
  const queued = await enqueueLocal(key);
  try {
    return await guardInner(key, dataDir, spec, fn);
  } finally {
    queued();
  }
}

const localQueues = new Map<string, Promise<void>>();

async function enqueueLocal(key: string): Promise<() => void> {
  const prev = localQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  localQueues.set(key, prev.then(() => current));
  await prev;
  return release;
}

async function guardInner<T>(
  key: string,
  dataDir: string,
  spec: { resource: string; scope: LockScope; operation: string; owner?: string; waitMs?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const depth = heldByThisProcess.get(key) ?? 0;
  if (depth > 0) {
    // 已在本进程持有同一资源：直接重入（否则 apply → capture 会自己把自己锁死）
    heldByThisProcess.set(key, depth + 1);
    try {
      return await fn();
    } finally {
      heldByThisProcess.set(key, depth);
    }
  }
  const globalKey = `${path.resolve(dataDir)}:global`;
  const globalDepth = heldByThisProcess.get(globalKey) ?? 0;
  const acquireGlobal = async <R>(run: () => Promise<R>): Promise<R> => {
    if (globalDepth > 0) return run();
    return withLock({ dataDir, resource: "global", scope: "global", operation: spec.operation, ...(spec.owner ? { owner: spec.owner } : {}), ...(spec.waitMs !== undefined ? { waitMs: spec.waitMs } : {}) }, async () => {
      heldByThisProcess.set(globalKey, 1);
      try {
        return await run();
      } finally {
        heldByThisProcess.set(globalKey, 0);
      }
    });
  };
  return acquireGlobal(async () =>
    withLock(
      {
        dataDir,
        resource: spec.resource,
        scope: spec.scope,
        operation: spec.operation,
        ...(spec.owner ? { owner: spec.owner } : {}),
        ...(spec.waitMs !== undefined ? { waitMs: spec.waitMs } : {}),
      },
      async () => {
        heldByThisProcess.set(key, 1);
        try {
          return await fn();
        } finally {
          heldByThisProcess.set(key, 0);
        }
      },
    ),
  );
}

/** 列出当前所有锁（供诊断/UI）。 */
export async function listLocks(dataDir: string): Promise<Array<{ resource: string; state: LockState; owner?: LockOwner; path: string; detail?: string }>> {
  const root = lockDirRoot(dataDir);
  const entries = await fsp.readdir(root).catch(() => [] as string[]);
  const out: Array<{ resource: string; state: LockState; owner?: LockOwner; path: string; detail?: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".lock")) continue;
    const resource = entry.slice(0, -".lock".length);
    const lock = new FileLock({ dataDir, resource, operation: "inspect" });
    const r = await lock.inspect();
    out.push({ resource, state: r.state, path: r.path, ...(r.owner ? { owner: r.owner } : {}), ...(r.detail ? { detail: r.detail } : {}) });
  }
  return out;
}