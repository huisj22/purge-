/**
 * DeepSeek Harness（DSH）宿主适配器。
 *
 * 与上一个世代工具的关键差别：
 * - 归档未解包时，也能通过 ASAR 头读出真实包名/版本/入口（有证据），而不是只看文件名。
 * - 磁盘形态、进程状态、加载形态三者分开报告，禁止用「磁盘上改了」推断「已加载」。
 * - 所有事实带 evidence；读不到就是 unknown。
 */
import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { sha256 } from "../core/atomic.ts";
import { asPurgeError } from "../core/errors.ts";
import { readAsarJson, readAsarIndex, listAsarTop } from "./asar.ts";
import type {
  ArchiveFacts,
  Evidence,
  HostAdapter,
  HostCandidate,
  HostCapabilities,
  HostFacts,
  HostIdentity,
  ModificationFootprint,
  ProfileFacts,
  ProcessFacts,
  UnpackedFacts,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const PRODUCT = "@deepseek-ai/dsh-desktop";
const MARKER_SAMPLE_LIMIT = 400;

export interface DshAdapterOptions {
  /** 额外候选根（通常是 resources 目录）。 */
  extraRoots?: string[];
  /** 覆盖用户主目录（仅影响候选路径推导；测试用）。 */
  homeDir?: string;
  /** 覆盖 DSH_HOME（数据目录；测试用）。 */
  dshHome?: string;
  /** 是否包含平台默认候选路径（测试可关闭）。 */
  includeDefaults?: boolean;
  /** 关闭进程探测（测试用）。 */
  skipProcessProbe?: boolean;
  /** 修改标记扫描的文件数上限（默认 400）。 */
  markerScanLimit?: number;
}

export class DshHostAdapter implements HostAdapter {
  readonly id = "dsh";
  readonly displayName = "DeepSeek Harness";
  readonly #opts: DshAdapterOptions;

  constructor(opts: DshAdapterOptions = {}) {
    this.#opts = opts;
  }

  capabilities(): HostCapabilities {
    return {
      readConfig: true,
      writeConfig: false,
      applyPack: true,
      restart: false,
      notes: [
        "只读识别宿主安装与状态；写配置需显式启用",
        "不在本适配器内重启宿主进程（重启由用户决定）",
      ],
    };
  }

  async discover(): Promise<HostCandidate[]> {
    const roots: Array<{ dir: string; evidence: Evidence }> = [];
    const home = this.#opts.homeDir ?? homedir();
    const push = (dir: string, source: string): void => {
      roots.push({ dir: path.resolve(dir), evidence: { kind: "env", source, note: "候选安装根" } });
    };

    if (process.env.PURGE_HOST_ROOT) push(process.env.PURGE_HOST_ROOT, "env:PURGE_HOST_ROOT");
    for (const extra of this.#opts.extraRoots ?? []) push(extra, "config:hosts.roots");

    if (this.#opts.includeDefaults !== false) {
      if (process.platform === "win32") {
        const local = process.env.LOCALAPPDATA;
        if (local) {
          push(path.join(local, "Programs", "DeepSeek Harness", "resources"), "default:win-localappdata");
          push(path.join(local, "DeepSeek Harness", "resources"), "default:win-localappdata-flat");
        }
        if (process.env.ProgramFiles) {
          push(path.join(process.env.ProgramFiles, "DeepSeek Harness", "resources"), "default:win-programfiles");
        }
      } else if (process.platform === "darwin") {
        push(path.join(home, "Applications", "DeepSeek Harness.app", "Contents", "Resources"), "default:mac-user-app");
        push("/Applications/DeepSeek Harness.app/Contents/Resources", "default:mac-system-app");
      } else {
        push(path.join(home, ".local", "share", "deepseek-harness", "resources"), "default:linux-user");
        push("/opt/DeepSeek Harness/resources", "default:linux-opt");
      }
    }

    const seen = new Set<string>();
    const out: HostCandidate[] = [];
    for (const { dir, evidence } of roots) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const shape = await this.#probeResources(dir);
      if (!shape.archiveExists && !shape.unpackedExists) continue;
      const evidenceList: Evidence[] = [evidence];
      if (shape.archiveExists) {
        const st = await fsp.stat(path.join(dir, "app.asar")).catch(() => null);
        evidenceList.push({
          kind: "file",
          source: path.join(dir, "app.asar"),
          note: `归档存在${st ? `，${st.size} 字节` : ""}`,
        });
      }
      if (shape.unpackedExists) {
        evidenceList.push({ kind: "dir", source: path.join(dir, "app"), note: "已解包目录存在" });
      }
      const homeDir = this.#resolveHome();
      out.push({
        id: `dsh@${sha256(dir).slice(0, 8)}`,
        adapterId: this.id,
        root: dir,
        resourcesDir: dir,
        home: homeDir,
        evidence: evidenceList,
      });
    }
    return out;
  }

  async #probeResources(dir: string): Promise<{ archiveExists: boolean; unpackedExists: boolean }> {
    const archive = await fsp.stat(path.join(dir, "app.asar")).then((s) => s.isFile()).catch(() => false);
    const unpacked = await fsp.stat(path.join(dir, "app")).then((s) => s.isDirectory()).catch(() => false);
    return { archiveExists: archive, unpackedExists: unpacked };
  }

  #resolveHome(): string {
    if (this.#opts.dshHome) return this.#opts.dshHome;
    if (process.env.DSH_HOME) return process.env.DSH_HOME;
    const home = this.#opts.homeDir ?? homedir();
    return path.join(home, ".dsh");
  }

  async identify(candidate: HostCandidate): Promise<HostIdentity> {
    const resources = candidate.resourcesDir ?? candidate.root;
    const evidence: Evidence[] = [];
    // 优先已解包目录（可直接读且带 mtime），否则读归档头
    const unpackedPkg = path.join(resources, "app", "package.json");
    try {
      const text = await fsp.readFile(unpackedPkg, "utf8");
      const pkg = JSON.parse(text) as { name?: string; version?: string; main?: string; dshBuildCommit?: string };
      evidence.push({ kind: "file", source: unpackedPkg, hash: sha256(text), note: "解包目录 package.json" });
      return {
        product: pkg.name ?? "unknown",
        version: pkg.version ?? "unknown",
        main: pkg.main,
        commit: pkg.dshBuildCommit,
        confidence: pkg.name === PRODUCT ? "verified" : "inferred",
        evidence,
      };
    } catch {
      /* fallthrough to archive */
    }
    const archive = path.join(resources, "app.asar");
    try {
      const pkg = await readAsarJson<{ name?: string; version?: string; main?: string; dshBuildCommit?: string }>(archive, "package.json");
      evidence.push({ kind: "archive", source: `${archive}!package.json`, note: "从归档头读取 package.json" });
      return {
        product: pkg.name ?? "unknown",
        version: pkg.version ?? "unknown",
        main: pkg.main,
        commit: pkg.dshBuildCommit,
        confidence: pkg.name === PRODUCT ? "verified" : "inferred",
        evidence,
      };
    } catch (err) {
      evidence.push({ kind: "probe", source: archive, note: `归档读取失败：${asPurgeError(err).message}` });
    }
    return { product: "unknown", version: "unknown", confidence: "unknown", evidence };
  }

  async inspect(candidate: HostCandidate): Promise<HostFacts> {
    const resources = candidate.resourcesDir ?? candidate.root;
    const identity = await this.identify(candidate);
    const archive = await this.#archiveFacts(path.join(resources, "app.asar"), identity);
    const unpacked = await this.#unpackedFacts(path.join(resources, "app"), resources);
    const runtimePath = path.join(resources, "runtime");
    const runtime = { path: runtimePath, exists: await fsp.stat(runtimePath).then((s) => s.isDirectory()).catch(() => false) };
    const homeDir = candidate.home ?? this.#resolveHome();
    const profiles = await this.#profiles(homeDir);
    const processFacts = this.#opts.skipProcessProbe === true
      ? { running: null, pids: [], probedBy: "skipped", note: "进程探测被禁用（测试模式）" }
      : await this.#processFacts();
    const modification = await this.#modification(homeDir, resources, archive, unpacked);
    const shape: HostFacts["shape"] =
      archive.exists && unpacked.exists ? "both" : archive.exists ? "sealed" : unpacked.exists ? "unpacked" : "neither";
    const loadedShape: HostFacts["loadedShape"] = processFacts.running === true ? (shape === "both" ? "unpacked" : shape === "sealed" ? "sealed" : shape === "unpacked" ? "unpacked" : "unknown") : "unknown";
    return {
      candidate,
      identity,
      archive,
      unpacked,
      runtime,
      profiles,
      process: processFacts,
      modification,
      shape,
      loadedShape,
      inspectedAt: new Date().toISOString(),
    };
  }

  async #archiveFacts(file: string, identity: HostIdentity): Promise<ArchiveFacts> {
    try {
      const st = await fsp.stat(file);
      let readable = false;
      let error: string | undefined;
      try {
        await readAsarIndex(file);
        readable = true;
      } catch (err) {
        error = asPurgeError(err).message;
      }
      return { path: file, exists: true, size: st.size, mtimeMs: st.mtimeMs, readable, identity, error };
    } catch {
      return { path: file, exists: false };
    }
  }

  async #unpackedFacts(dir: string, resources: string): Promise<UnpackedFacts> {
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) return { path: dir, exists: false, entries: [] };
      const entries = (await fsp.readdir(dir)).sort();
      let identity: HostIdentity | undefined;
      try {
        const text = await fsp.readFile(path.join(dir, "package.json"), "utf8");
        const pkg = JSON.parse(text) as { name?: string; version?: string; main?: string };
        identity = {
          product: pkg.name ?? "unknown",
          version: pkg.version ?? "unknown",
          main: pkg.main,
          confidence: "verified",
          evidence: [{ kind: "file", source: path.join(dir, "package.json"), hash: sha256(text) }],
        };
      } catch (err) {
        return { path: dir, exists: true, entries, error: asPurgeError(err).message };
      }
      void resources;
      return { path: dir, exists: true, entries, identity };
    } catch {
      return { path: dir, exists: false, entries: [] };
    }
  }

  async #profiles(homeDir: string): Promise<ProfileFacts[]> {
    const dir = path.join(homeDir, "profiles");
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    const out: ProfileFacts[] = [];
    for (const name of names.sort()) {
      const profileDir = path.join(dir, name);
      const st = await fsp.stat(profileDir).catch(() => null);
      if (!st?.isDirectory()) continue;
      const pkgPath = path.join(profileDir, "package.json");
      try {
        const text = await fsp.readFile(pkgPath, "utf8");
        const pkg = JSON.parse(text) as {
          dependencies?: Record<string, string>;
          dsh?: { profile?: { bundles?: string[] } };
        };
        out.push({
          name,
          dir: profileDir,
          packageJsonPath: pkgPath,
          dependencies: pkg.dependencies ?? {},
          bundles: pkg.dsh?.profile?.bundles ?? [],
        });
      } catch (err) {
        out.push({ name, dir: profileDir, packageJsonPath: pkgPath, dependencies: {}, bundles: [], error: asPurgeError(err).message });
      }
    }
    return out;
  }

  async #processFacts(): Promise<ProcessFacts> {
    const pattern = "DeepSeek Harness";
    if (process.platform === "win32") {
      try {
        const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq DeepSeek Harness.exe", "/FO", "CSV", "/NH"], {
          timeout: 5000,
          windowsHide: true,
        });
        // CSV 行形如："DeepSeek Harness.exe","24692","Console","1","123,456 K"
        const pids = stdout
          .split(/\r?\n/)
          .map((line) => line.match(/^"([^"]*)","(\d+)"/))
          .filter((m): m is RegExpMatchArray => m !== null)
          .map((m) => Number(m[2]))
          .filter((n) => Number.isInteger(n) && n > 0);
        return { running: pids.length > 0, pids, probedBy: "tasklist" };
      } catch (err) {
        return { running: null, pids: [], probedBy: "tasklist", note: asPurgeError(err).message };
      }
    }
    try {
      const { stdout } = await execFileAsync("pgrep", ["-f", pattern], { timeout: 5000 });
      const pids = stdout.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      return { running: pids.length > 0, pids, probedBy: "pgrep" };
    } catch (err) {
      const code = (err as { code?: number }).code;
      // pgrep 无匹配时退出码 1
      if (code === 1) return { running: false, pids: [], probedBy: "pgrep" };
      return { running: null, pids: [], probedBy: "pgrep", note: asPurgeError(err).message };
    }
  }

  async #modification(
    homeDir: string,
    resources: string,
    archive: ArchiveFacts,
    unpacked: UnpackedFacts,
  ): Promise<ModificationFootprint> {
    const packs: ModificationFootprint["packs"] = [];
    // 已知第三方修改包的痕迹（识别历史安装，不依赖其代码）
    const legacyApplied = path.join(homeDir, "dsh-purge", "applied.json");
    try {
      const text = await fsp.readFile(legacyApplied, "utf8");
      const parsed = JSON.parse(text) as { version?: string; at?: string };
      packs.push({
        tool: "dsh-purge",
        version: parsed.version,
        appliedAt: parsed.at,
        evidence: { kind: "file", source: legacyApplied, hash: sha256(text) },
      });
    } catch {
      /* 没有痕迹 */
    }

    const markerHits: ModificationFootprint["markerHits"] = [];
    let scannedFiles = 0;
    let scanTruncated = false;
    if (unpacked.exists) {
      const scan = await this.#scanMarkers(path.join(resources, "app"), this.#opts.markerScanLimit ?? MARKER_SAMPLE_LIMIT);
      markerHits.push(...scan.hits);
      scannedFiles = scan.scanned;
      scanTruncated = scan.truncated;
    }
    // 判定原则（P1-02 修复）：
    //  - 只有「存在修改标记」或「有修改包记录」才算被修改（确定证据）；
    //  - mtime 只作为提示字段输出，不参与判定：解包本身必然让 app/ 比 asar 新；
    //  - 扫描被截断且没有命中 → 无法证明未修改，只能 null（unknown）。
    let looksModified: boolean | null;
    if (markerHits.length > 0 || packs.length > 0) looksModified = true;
    else if (!unpacked.exists) looksModified = false; // 只有归档 = 未就地修改
    else looksModified = scanTruncated ? null : false;
    const appPkgStat = await fsp.stat(path.join(resources, "app", "package.json")).catch(() => null);
    const mtimeNewerThanArchive = appPkgStat && archive.mtimeMs !== undefined ? appPkgStat.mtimeMs > archive.mtimeMs : null;
    return { packs, markerHits, scannedFiles, scanTruncated, mtimeNewerThanArchive, looksModified };
  }

  async #scanMarkers(root: string, limit: number): Promise<{ hits: Array<{ file: string; markers: string[] }>; scanned: number; truncated: boolean }> {
    const hits: Array<{ file: string; markers: string[] }> = [];
    const queue: string[] = [root];
    let visited = 0;
    const markerPatterns: Array<{ name: string; re: RegExp }> = [
      { name: "[dsh-purge]", re: /\[dsh-purge\]/ },
      { name: "[purge-plus]", re: /\[purge-plus\]/ },
    ];
    // 先看宿主自己的包（lib/*.js），再看第三方包：修改包几乎总是打在前者。
    const priority: string[] = [];
    const deferred: string[] = [];
    while ((queue.length > 0 || priority.length > 0) && visited < limit) {
      const dir = priority.length > 0 ? (priority.shift() as string) : (queue.shift() as string);
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (visited >= limit) break;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") deferred.push(abs);
          else priority.push(abs);
          continue;
        }
        if (!entry.isFile() || !/\.(js|mjs|cjs)$/.test(entry.name)) continue;
        visited += 1;
        const st = await fsp.stat(abs).catch(() => null);
        if (!st || st.size > 4 * 1024 * 1024) continue;
        const text = await fsp.readFile(abs, "utf8").catch(() => "");
        if (!text.includes("[dsh-purge]") && !text.includes("[purge-plus]")) continue;
        const found = markerPatterns.filter((p) => p.re.test(text)).map((p) => p.name);
        if (found.length > 0) hits.push({ file: abs, markers: found });
      }
      if (priority.length === 0 && queue.length === 0 && deferred.length > 0) {
        // 第二轮：第三方包目录（@deepseek-ai/*）
        while (deferred.length > 0) {
          const nm = deferred.shift() as string;
          const scoped = path.join(nm, "@deepseek-ai");
          const scopedExists = await fsp.stat(scoped).then((s) => s.isDirectory()).catch(() => false);
          if (scopedExists) queue.push(scoped);
          else queue.push(nm);
        }
      }
    }
    // 只要触到上限，就无法证明"全扫过"——一律标记不完整（保守但诚实）
    const truncated = visited >= limit;
    return { hits, scanned: visited, truncated };
  }
}

export { PRODUCT as DSH_PRODUCT, listAsarTop };
