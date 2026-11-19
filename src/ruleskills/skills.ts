/**
 * 技能中心：发现 / 校验 / 导入 / 覆盖前备份。
 *
 * 继承原项目的硬约束（矩阵 F3/F4）：
 * - 只认目录根的 SKILL.md，frontmatter 只做归一化，不改正文。
 * - 导入有围栏：拒绝 `..`、绝对路径、符号链接、超大文件、文件数上限。
 * - 覆盖前必须备份，且备份是内容寻址的（同一内容不重复备份）。
 * 新增：导入时做静态安全提示（可执行脚本、可疑权限），不静默放行。
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { ensureDir, removeTreeNoFollow, sha256File } from "../core/atomic.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";
import { boolField, listField, parseFrontmatter, stringField } from "./frontmatter.ts";

export interface SkillWarning {
  code: "executable_content" | "oversized_file" | "unknown_requirement" | "frontmatter_problem" | "symlink_skipped";
  message: string;
  path?: string;
}

export interface Skill {
  name: string;
  dir: string;
  description: string;
  version?: string;
  tags: string[];
  requires: string[];
  /** 是否声明为「模型不可调用」。 */
  modelInvocable: boolean;
  files: number;
  bytes: number;
  warnings: SkillWarning[];
  hash?: string;
}

export interface SkillLibraryOptions {
  /** 单文件上限，默认 512 KB。 */
  maxFileBytes?: number;
  /** 单个技能总字节上限，默认 8 MB。 */
  maxTotalBytes?: number;
  /** 文件数上限，默认 200。 */
  maxFiles?: number;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXECUTABLE = /\.(sh|bash|zsh|ps1|bat|cmd|exe|dll|so|dylib|py|rb|pl)$/i;

export class SkillLibrary {
  readonly dir: string;
  readonly backupDir: string;
  readonly #o: Required<SkillLibraryOptions>;

  constructor(dataDir: string, opts: SkillLibraryOptions = {}) {
    this.dir = path.join(dataDir, "skills");
    this.backupDir = path.join(dataDir, "skills-backup");
    this.#o = {
      maxFileBytes: opts.maxFileBytes ?? 512 * 1024,
      maxTotalBytes: opts.maxTotalBytes ?? 8 * 1024 * 1024,
      maxFiles: opts.maxFiles ?? 200,
    };
  }

  /** 只读发现：给定若干根目录，找出其中带 SKILL.md 的子目录。 */
  async scan(roots: string[]): Promise<Skill[]> {
    const out: Skill[] = [];
    for (const root of roots) {
      let entries: string[];
      try {
        entries = await fsp.readdir(root);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        const dir = path.join(root, entry);
        const st = await fsp.stat(dir).catch(() => null);
        if (!st?.isDirectory()) continue;
        if (await fsp.stat(path.join(dir, "SKILL.md")).then((s) => s.isFile()).catch(() => false)) {
          try {
            out.push(await this.inspect(dir));
          } catch (err) {
            out.push({
              name: entry,
              dir,
              description: "",
              tags: [],
              requires: [],
              modelInvocable: true,
              files: 0,
              bytes: 0,
              warnings: [{ code: "frontmatter_problem", message: asPurgeError(err).message }],
            });
          }
        }
      }
    }
    return out;
  }

  async list(): Promise<Skill[]> {
    return this.scan([this.dir]);
  }

  /** 只读检查一个技能目录：不写盘、不改文件。 */
  async inspect(dir: string): Promise<Skill> {
    const skillFile = path.join(dir, "SKILL.md");
    const text = await fsp.readFile(skillFile, "utf8").catch(() => {
      throw purgeError("not_found", `SKILL.md not found in ${dir}`);
    });
    const parsed = parseFrontmatter(text);
    const name = stringField(parsed.data, "name") ?? path.basename(dir);
    const description = stringField(parsed.data, "description") ?? "";
    const warnings: SkillWarning[] = [];
    if (!NAME_RE.test(name) || name.length > 64) {
      throw purgeError("schema_invalid", `skill name must be kebab-case (<=64): "${name}"`, { dir });
    }
    if (description.trim().length === 0) {
      throw purgeError("schema_invalid", `skill "${name}" must declare a description`, { dir });
    }
    if (parsed.problems.length > 0) {
      warnings.push({ code: "frontmatter_problem", message: parsed.problems.join("; ") });
    }
    const tree = await this.#walk(dir, warnings);
    const bytes = tree.reduce((n, f) => n + f.size, 0);
    const hash = createHash("sha256");
    for (const f of tree) hash.update(`${f.rel}:${f.hash}\n`);
    const requires = listField(parsed.data, "requires");
    for (const req of requires) {
      if (!/^[a-z0-9][a-z0-9._>=<-]*$/i.test(req)) {
        warnings.push({ code: "unknown_requirement", message: `需求声明格式可疑：${req}` });
      }
    }
    return {
      name,
      dir,
      description,
      version: stringField(parsed.data, "version"),
      tags: listField(parsed.data, "tags"),
      requires,
      modelInvocable: !boolField(parsed.data, "disable-model-invocation"),
      files: tree.length,
      bytes,
      warnings,
      hash: hash.digest("hex"),
    };
  }

  /** 导入：路径围栏 + 体积上限 + 覆盖前内容寻址备份。 */
  async import(sourceDir: string, opts: { overwrite?: boolean } = {}): Promise<Skill> {
    const src = path.resolve(sourceDir);
    const skill = await this.inspect(src);
    const dest = path.join(this.dir, skill.name);
    const destExists = await fsp.stat(dest).then((s) => s.isDirectory()).catch(() => false);
    if (destExists && opts.overwrite !== true) {
      throw purgeError("conflict", `skill already installed: ${skill.name}`, { hint: "use overwrite=true" });
    }
    let backup: string | undefined;
    if (destExists) {
      const existing = await this.inspect(dest).catch(() => null);
      if (existing?.hash === skill.hash) {
        return { ...skill, dir: dest, warnings: [...skill.warnings, { code: "frontmatter_problem", message: "内容相同，未重复导入" }] };
      }
      backup = path.join(this.backupDir, `${skill.name}-${(existing?.hash ?? "unknown").slice(0, 8)}`);
      await ensureDir(this.backupDir);
      await removeTreeNoFollow(backup);
      await copyTree(dest, backup);
    }
    await ensureDir(this.dir);
    const staging = path.join(this.dir, `.${skill.name}.import-${process.pid}`);
    await removeTreeNoFollow(staging);
    await copyTree(src, staging);
    const verified = await this.inspect(staging);
    if (verified.hash !== skill.hash) {
      await removeTreeNoFollow(staging);
      throw purgeError("integrity_failed", "copied skill differs from source", { source: skill.hash, copied: verified.hash });
    }
    if (destExists) await removeTreeNoFollow(dest);
    await fsp.rename(staging, dest);
    return { ...verified, dir: dest, warnings: [...verified.warnings, ...(backup ? [{ code: "frontmatter_problem" as const, message: `旧版本已备份到 ${backup}` }] : [])] };
  }

  async remove(name: string): Promise<{ removed: string }> {
    if (!NAME_RE.test(name)) throw purgeError("invalid_argument", `invalid skill name: ${name}`);
    const dir = path.join(this.dir, name);
    const exists = await fsp.stat(dir).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) throw purgeError("not_found", `skill not installed: ${name}`);
    await removeTreeNoFollow(dir);
    return { removed: dir };
  }

  async #walk(root: string, warnings: SkillWarning[]): Promise<Array<{ rel: string; size: number; hash: string }>> {
    const out: Array<{ rel: string; size: number; hash: string }> = [];
    let totalBytes = 0;
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (relPath.includes("..")) throw purgeError("policy_denied", `path traversal in skill: ${relPath}`);
        if (entry.isSymbolicLink()) {
          warnings.push({ code: "symlink_skipped", message: `跳过符号链接（不跟随）`, path: relPath });
          continue;
        }
        if (entry.isDirectory()) {
          await walk(abs, relPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const st = await fsp.stat(abs);
        if (st.size > this.#o.maxFileBytes) {
          throw purgeError("invalid_argument", `file too large in skill: ${relPath} (${st.size} > ${this.#o.maxFileBytes})`, { path: relPath });
        }
        if (EXECUTABLE.test(relPath)) {
          warnings.push({ code: "executable_content", message: `含可执行脚本，运行前请审阅`, path: relPath });
        }
        out.push({ rel: relPath, size: st.size, hash: await sha256File(abs) });
        totalBytes += st.size;
        if (out.length > this.#o.maxFiles) {
          throw purgeError("invalid_argument", `too many files in skill (>${this.#o.maxFiles})`);
        }
        if (totalBytes > this.#o.maxTotalBytes) {
          throw purgeError("invalid_argument", `skill exceeds total size limit (${this.#o.maxTotalBytes})`);
        }
      }
    };
    await walk(root, "");
    return out;
  }
}

async function copyTree(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) continue; // 不把链接带进库
    if (entry.isDirectory()) {
      await copyTree(from, to);
      continue;
    }
    if (!entry.isFile()) continue;
    await fsp.copyFile(from, to);
  }
}
