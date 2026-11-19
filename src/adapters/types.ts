/**
 * 适配器契约。
 *
 * 核心原则：领域层只依赖这些接口，永远不直接读某个宿主的私有路径。
 * 每个宿主事实都必须带 evidence（来源路径/探针输出），无证据只能给 unknown。
 */
export type Confidence = "verified" | "inferred" | "unknown";

export interface Evidence {
  /** 证据类型：文件读取 / 归档读取 / 进程探测 / 环境变量 / 目录列举 */
  kind: "file" | "archive" | "process" | "env" | "dir" | "probe";
  /** 具体来源（路径、命令、变量名） */
  source: string;
  /** 人可读的说明 */
  note?: string;
  /** 内容哈希（文件/归档条目） */
  hash?: string;
}

export interface HostCandidate {
  id: string;
  adapterId: string;
  /** 安装根（通常是 resources 目录或其父目录）。 */
  root: string;
  resourcesDir?: string;
  home?: string;
  evidence: Evidence[];
}

export interface HostIdentity {
  product: string;
  version: string;
  main?: string;
  commit?: string;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface ArchiveFacts {
  path: string;
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  readable?: boolean;
  identity?: HostIdentity;
  error?: string;
}

export interface UnpackedFacts {
  path: string;
  exists: boolean;
  entries: string[];
  identity?: HostIdentity;
  error?: string;
}

export interface ProfileFacts {
  name: string;
  dir: string;
  packageJsonPath: string;
  dependencies: Record<string, string>;
  bundles: string[];
  error?: string;
}

export interface ProcessFacts {
  running: boolean | null;
  pids: number[];
  probedBy: string;
  note?: string;
}

export interface ModificationFootprint {
  /** 识别到的第三方修改包痕迹（例如历史上装过的 dsh-purge）。 */
  packs: Array<{
    tool: string;
    version?: string;
    appliedAt?: string;
    evidence: Evidence;
  }>;
  /** 宿主源码树里出现修改标记的文件数（抽样）。 */
  markerHits: Array<{ file: string; markers: string[] }>;
  /** 抽样扫描了多少个源码文件；用于判断结论强度。 */
  scannedFiles?: number;
  /** 无法判断时为 null，不允许默认「没改过」。 */
  looksModified: boolean | null;
}

export interface HostFacts {
  candidate: HostCandidate;
  identity: HostIdentity;
  archive: ArchiveFacts;
  unpacked: UnpackedFacts;
  runtime: { path: string; exists: boolean };
  profiles: ProfileFacts[];
  process: ProcessFacts;
  modification: ModificationFootprint;
  /** 综合判定：磁盘形态 */
  shape: "sealed" | "unpacked" | "both" | "neither";
  /** 综合判定：当前进程加载的形态（无法证明时 unknown） */
  loadedShape: "sealed" | "unpacked" | "unknown";
  inspectedAt: string;
}

export interface HostCapabilities {
  readConfig: boolean;
  writeConfig: boolean;
  applyPack: boolean;
  restart: boolean;
  notes: string[];
}

export interface HostAdapter {
  readonly id: string;
  readonly displayName: string;
  discover(): Promise<HostCandidate[]>;
  identify(candidate: HostCandidate): Promise<HostIdentity>;
  inspect(candidate: HostCandidate): Promise<HostFacts>;
  capabilities(): HostCapabilities;
}
