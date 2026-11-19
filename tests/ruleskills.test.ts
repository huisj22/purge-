import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { parseFrontmatter, listField, stringField, boolField } from "../src/ruleskills/frontmatter.ts";
import { RuleStore, validateRule } from "../src/ruleskills/rules.ts";
import { SkillLibrary } from "../src/ruleskills/skills.ts";

describe("frontmatter parser", () => {
  it("parses scalars, inline lists, block lists and block scalars", () => {
    const fm = parseFrontmatter(
      ["---", "name: my-skill", 'description: "带引号"', "tags: [a, b]", "requires:", "  - node>=22", "  - git", "note: |", "  第一行", "  第二行", "---", "正文内容"].join("\n"),
    );
    assert.deepEqual(fm.problems, []);
    assert.equal(stringField(fm.data, "name"), "my-skill");
    assert.equal(stringField(fm.data, "description"), "带引号");
    assert.deepEqual(listField(fm.data, "tags"), ["a", "b"]);
    assert.deepEqual(listField(fm.data, "requires"), ["node>=22", "git"]);
    assert.equal(stringField(fm.data, "note"), "第一行\n第二行");
    assert.equal(fm.body.trim(), "正文内容");
  });

  it("reports missing and unterminated frontmatter instead of pretending", () => {
    assert.deepEqual(parseFrontmatter("no fm here").problems, ["no frontmatter block"]);
    assert.deepEqual(parseFrontmatter("---\na: 1\n").problems, ["unterminated frontmatter"]);
  });

  it("flags nested mappings rather than silently dropping them", () => {
    const fm = parseFrontmatter(["---", "outer:", "  inner: 1", "---", ""].join("\n"));
    assert.ok(fm.problems.some((p) => p.includes("nested mapping")));
  });

  it("parses booleans", () => {
    const fm = parseFrontmatter(["---", "disable-model-invocation: true", "---", ""].join("\n"));
    assert.equal(boolField(fm.data, "disable-model-invocation"), true);
  });
});

describe("rule store", () => {
  let dir = "";
  let sub = 0;
  const nextSub = (): string => {
    sub += 1;
    return `r${sub}`;
  };
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "purgeplus-rules-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates, updates, versions and removes rules", async () => {
    const store = new RuleStore(path.join(dir, nextSub()));
    const created = await store.create({ id: "style", title: "代码风格", body: "用 4 空格缩进" });
    assert.equal(created.version, 1);
    assert.equal(created.enabled, true);
    const updated = await store.update("style", { body: "用 2 空格缩进" });
    assert.equal(updated.version, 2);
    assert.equal((await store.get("style")).body, "用 2 空格缩进");
    await store.remove("style");
    assert.deepEqual(await store.list(), []);
  });

  it("rejects invalid ids, empty bodies and duplicates", async () => {
    const store = new RuleStore(path.join(dir, nextSub()));
    await assert.rejects(() => store.create({ id: "Bad Id", title: "t", body: "b" }), /id 必须匹配/);
    await assert.rejects(() => store.create({ id: "ok", title: "t", body: "   " }), /body 不能为空/);
    await store.create({ id: "dup", title: "t", body: "b" });
    await assert.rejects(() => store.create({ id: "dup", title: "t", body: "b" }), /already exists/);
    assert.throws(() => validateRule({ id: "x", title: "t", body: "a".repeat(70_000) }), /超过/);
  });

  it("composes global rules first and matches workspace rules by prefix", async () => {
    const store = new RuleStore(path.join(dir, nextSub()));
    await store.create({ id: "g1", title: "全局", body: "全局规则" });
    await store.create({ id: "w1", title: "项目", body: "项目规则", scope: { kind: "workspace", path: path.join(dir, "proj") } });
    await store.create({ id: "off", title: "停用", body: "不应出现", enabled: false });
    const hit = await store.compose({ workspace: path.join(dir, "proj", "sub") });
    assert.deepEqual(hit.included, ["g1", "w1"]);
    assert.match(hit.text, /全局规则/);
    assert.match(hit.text, /项目规则/);
    assert.ok(!hit.text.includes("不应出现"));
    const miss = await store.compose({ workspace: path.join(dir, "other") });
    assert.deepEqual(miss.included, ["g1"]);
    assert.ok(miss.skipped.some((s) => s.id === "w1"));
  });

  it("round-trips markdown export/import", async () => {
    const store = new RuleStore(path.join(dir, nextSub()));
    const rule = await store.create({ id: "rt", title: "往返", body: "正文", tags: ["a"] });
    const md = store.exportMarkdown(rule);
    await store.remove("rt");
    const imported = await store.importMarkdown(md);
    assert.equal(imported.id, "rt");
    assert.equal(imported.title, "往返");
    assert.deepEqual(imported.tags, ["a"]);
    assert.equal(imported.body, "正文");
    await assert.rejects(() => store.importMarkdown(md), /already exists/);
    const again = await store.importMarkdown(md, { overwrite: true });
    assert.equal(again.version, 2);
  });

  it("surfaces corrupt rule files instead of hiding them", async () => {
    const store = new RuleStore(path.join(dir, nextSub()));
    await mkdir(store.dir, { recursive: true });
    await writeFile(path.join(store.dir, "broken.json"), "{ not json", "utf8");
    const list = await store.list();
    const broken = list.find((r) => r.id === "broken");
    assert.ok(broken);
    assert.equal(broken?.version, 0);
    const composed = await store.compose({});
    assert.ok(!composed.text.includes("broken"));
    assert.ok(composed.skipped.some((s) => s.id === "broken"));
  });
});

describe("skill library", () => {
  let base = "";
  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "purgeplus-skills-"));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function makeSkill(root: string, name: string, opts: { description?: string; extraFiles?: Record<string, string> } = {}) {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      ["---", `name: ${name}`, `description: ${opts.description ?? "示例技能"}`, "tags: [demo]", "---", "", "技能正文"].join("\n"),
      "utf8",
    );
    for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
      const target = path.join(dir, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    return dir;
  }

  it("scans roots and parses metadata", async () => {
    const root = path.join(base, "src");
    await makeSkill(root, "alpha", { description: "第一个技能" });
    const lib = new SkillLibrary(path.join(base, "data1"));
    const found = await lib.scan([root]);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.name, "alpha");
    assert.equal(found[0]?.description, "第一个技能");
    assert.deepEqual(found[0]?.tags, ["demo"]);
    assert.equal(found[0]?.modelInvocable, true);
  });

  it("imports, then backs up before overwrite", async () => {
    const root = path.join(base, "src2");
    const dataDir = path.join(base, "data2");
    const src = await makeSkill(root, "beta", { extraFiles: { "ref.md": "参考" } });
    const lib = new SkillLibrary(dataDir);
    const imported = await lib.import(src);
    assert.equal(imported.name, "beta");
    assert.equal(await readFile(path.join(dataDir, "skills", "beta", "ref.md"), "utf8"), "参考");

    await writeFile(path.join(src, "ref.md"), "改过的参考", "utf8");
    await assert.rejects(() => lib.import(src), /already installed/);
    const reimported = await lib.import(src, { overwrite: true });
    assert.equal(reimported.name, "beta");
    assert.equal(await readFile(path.join(dataDir, "skills", "beta", "ref.md"), "utf8"), "改过的参考");
    const backups = await import("node:fs/promises").then((fs) => fs.readdir(path.join(dataDir, "skills-backup")));
    assert.equal(backups.length, 1, "旧版本必须留一份备份");
  });

  it("rejects bad names, missing descriptions and oversized files", async () => {
    const root = path.join(base, "src3");
    const badName = path.join(root, "Bad_Name");
    await mkdir(badName, { recursive: true });
    await writeFile(path.join(badName, "SKILL.md"), ["---", "name: Bad_Name", "description: x", "---", ""].join("\n"));
    const lib = new SkillLibrary(path.join(base, "data3"));
    await assert.rejects(() => lib.inspect(badName), /kebab-case/);

    const noDesc = path.join(root, "nodesc");
    await mkdir(noDesc, { recursive: true });
    await writeFile(path.join(noDesc, "SKILL.md"), ["---", "name: nodesc", "---", ""].join("\n"));
    await assert.rejects(() => lib.inspect(noDesc), /description/);

    const big = await makeSkill(root, "big");
    await writeFile(path.join(big, "blob.bin"), Buffer.alloc(600 * 1024));
    await assert.rejects(() => lib.inspect(big), /file too large/);
  });

  it("flags executable content as a warning instead of silently importing", async () => {
    const root = path.join(base, "src4");
    const dir = await makeSkill(root, "runner", { extraFiles: { "run.sh": "echo hi" } });
    const lib = new SkillLibrary(path.join(base, "data4"));
    const skill = await lib.inspect(dir);
    assert.ok(skill.warnings.some((w) => w.code === "executable_content"));
    const imported = await lib.import(dir);
    assert.ok(imported.warnings.some((w) => w.code === "executable_content"));
  });

  it("removes installed skills and refuses unknown names", async () => {
    const root = path.join(base, "src5");
    const dataDir = path.join(base, "data5");
    const src = await makeSkill(root, "gamma");
    const lib = new SkillLibrary(dataDir);
    await lib.import(src);
    await lib.remove("gamma");
    assert.deepEqual(await lib.list(), []);
    await assert.rejects(() => lib.remove("ghost"), /not installed/);
    await assert.rejects(() => lib.remove("../escape"), /invalid skill name/);
  });
});
