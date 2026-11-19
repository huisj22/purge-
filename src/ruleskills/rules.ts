/**
 * 规则中心：多槽位（全局 / 工作区）规则库 + 组装。
 *
 * 相对原项目的改动（矩阵 F1/F2）：
 * - 原版是「单活规则直接写宿主 AGENTS.md」，双指令并存风险高；
 *   这里改为**规则库 + 组装**：不写宿主文件，先组装出确定性文本，由宿主适配器决定是否采纳。
 * - 工作区规则只存绝对路径，组装时再按当前 workspace 匹配（跨目录隔离，继承原版思路）。
 * - 每次变更落盘前校验，失败不写。
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, ensureDir } from "../core/atomic.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";
import { listField, parseFrontmatter, stringField } from "./frontmatter.ts";

export type RuleScope = { kind: "global" } | { kind: "workspace"; path: string };

export interface Rule {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
  scope: RuleScope;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuleInput {
  id: string;
  title: string;
  body: string;
  enabled?: boolean;
  scope?: RuleScope;
  tags?: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_BODY = 64 * 1024;

export class RuleStore {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "rules");
  }

  async list(): Promise<Rule[]> {
    await ensureDir(this.dir);
    const files = (await fsp.readdir(this.dir)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    const rules: Rule[] = [];
    for (const file of files.sort()) {
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(this.dir, file), "utf8")) as Rule;
        rules.push(raw);
      } catch {
        // 损坏规则不隐藏：以只读占位形式暴露，避免"看起来没有"
        rules.push({
          id: file.replace(/\.json$/, ""),
          title: "(corrupt)",
          body: "",
          enabled: false,
          scope: { kind: "global" },
          tags: ["corrupt"],
          version: 0,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        });
      }
    }
    return rules.sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<Rule> {
    const rule = (await this.list()).find((r) => r.id === id);
    if (!rule) throw purgeError("not_found", `rule not found: ${id}`);
    return rule;
  }

  async create(input: RuleInput): Promise<Rule> {
    validateRule(input);
    const existing = (await this.list()).find((r) => r.id === input.id);
    if (existing) throw purgeError("conflict", `rule already exists: ${input.id}`);
    const now = new Date().toISOString();
    const rule: Rule = {
      id: input.id,
      title: input.title,
      body: input.body,
      enabled: input.enabled ?? true,
      scope: input.scope ?? { kind: "global" },
      tags: input.tags ?? [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.#persist(rule);
    return rule;
  }

  async update(id: string, patch: Partial<Omit<RuleInput, "id">>): Promise<Rule> {
    const current = await this.get(id);
    const next: Rule = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    validateRule({ id: next.id, title: next.title, body: next.body });
    await this.#persist(next);
    return next;
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await fsp.rm(path.join(this.dir, `${id}.json`), { force: true });
  }

  /** 导出为 Markdown（frontmatter + 正文），可被 import 回读。 */
  exportMarkdown(rule: Rule): string {
    const scope = rule.scope.kind === "global" ? "global" : `workspace:${rule.scope.path}`;
    return [
      "---",
      `id: ${rule.id}`,
      `title: ${rule.title}`,
      `scope: ${scope}`,
      `enabled: ${rule.enabled}`,
      `tags: [${rule.tags.join(", ")}]`,
      `version: ${rule.version}`,
      "---",
      "",
      rule.body,
      "",
    ].join("\n");
  }

  async importMarkdown(md: string, opts: { overwrite?: boolean } = {}): Promise<Rule> {
    const parsed = parseFrontmatter(md);
    if (parsed.problems.length > 0) {
      throw purgeError("schema_invalid", `invalid rule frontmatter: ${parsed.problems.join("; ")}`, { problems: parsed.problems });
    }
    const id = stringField(parsed.data, "id");
    const title = stringField(parsed.data, "title");
    const scopeRaw = stringField(parsed.data, "scope") ?? "global";
    if (!id) throw purgeError("schema_invalid", "rule frontmatter must contain id");
    if (!title) throw purgeError("schema_invalid", "rule frontmatter must contain title");
    const scope: RuleScope = scopeRaw.startsWith("workspace:")
      ? { kind: "workspace", path: path.resolve(scopeRaw.slice("workspace:".length)) }
      : { kind: "global" };
    const existing = (await this.list()).find((r) => r.id === id);
    if (existing && opts.overwrite !== true) {
      throw purgeError("conflict", `rule already exists: ${id}`, { hint: "use overwrite=true" });
    }
    const input: RuleInput = { id, title, body: parsed.body.trim(), enabled: existing?.enabled ?? true, scope, tags: listField(parsed.data, "tags") };
    if (existing) {
      const updated = await this.update(id, input);
      return updated;
    }
    return this.create(input);
  }

  /**
   * 组装生效规则：全局在前、工作区按路径前缀匹配在后。
   * 只返回 enabled 的规则；损坏规则（version=0）不会被组装进去。
   */
  async compose(opts: { workspace?: string } = {}): Promise<{ text: string; included: string[]; skipped: Array<{ id: string; reason: string }> }> {
    const workspace = opts.workspace ? path.resolve(opts.workspace) : undefined;
    const rules = (await this.list()).sort((a, b) => {
      // 全局规则永远排在工作区规则之前（文档承诺）
      const ak = a.scope.kind === "global" ? 0 : 1;
      const bk = b.scope.kind === "global" ? 0 : 1;
      return ak === bk ? a.id.localeCompare(b.id) : ak - bk;
    });
    const included: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const parts: string[] = [];
    for (const rule of rules) {
      if (rule.version === 0) {
        skipped.push({ id: rule.id, reason: "规则文件损坏，未参与组装" });
        continue;
      }
      if (!rule.enabled) {
        skipped.push({ id: rule.id, reason: "已停用" });
        continue;
      }
      if (rule.scope.kind === "workspace") {
        if (!workspace) {
          skipped.push({ id: rule.id, reason: "工作区规则，但未指定工作区" });
          continue;
        }
        const scopePath = path.resolve(rule.scope.path);
        const hit = workspace === scopePath || workspace.startsWith(scopePath + path.sep);
        if (!hit) {
          skipped.push({ id: rule.id, reason: `工作区不匹配（${scopePath}）` });
          continue;
        }
      }
      included.push(rule.id);
      parts.push(`### ${rule.title} (${rule.id})\n\n${rule.body.trim()}`);
    }
    return { text: parts.join("\n\n"), included, skipped };
  }

  async #persist(rule: Rule): Promise<void> {
    await ensureDir(this.dir);
    const file = path.join(this.dir, `${rule.id}.json`);
    try {
      await atomicWriteFile(file, `${JSON.stringify(rule, null, 2)}\n`);
    } catch (err) {
      throw asPurgeError(err);
    }
  }
}

export function validateRule(input: { id: string; title: string; body: string }): void {
  const problems: string[] = [];
  if (!ID_RE.test(input.id)) problems.push("id 必须匹配 [a-z0-9._-] 且长度 1-64");
  if (!input.title || input.title.trim().length === 0) problems.push("title 不能为空");
  if (input.title.length > 200) problems.push("title 过长（>200）");
  if (typeof input.body !== "string" || input.body.trim().length === 0) problems.push("body 不能为空");
  if (Buffer.byteLength(input.body, "utf8") > MAX_BODY) problems.push(`body 超过 ${MAX_BODY} 字节`);
  if (problems.length > 0) throw purgeError("schema_invalid", `rule validation failed: ${problems.join("; ")}`, { problems });
}
