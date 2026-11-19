/**
 * P2-13 写入口锁审计测试：
 *  - 规则 / 技能 / 自身配置：子进程持 global 时写入被阻止；释放后成功
 *  - 审计追加：多进程并发追加后哈希链完整
 *  - 审计部分失败：一次非法 append 不得留下半条记录
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigStore } from "../src/core/config.ts";
import { RuleStore } from "../src/ruleskills/rules.ts";
import { SkillLibrary } from "../src/ruleskills/skills.ts";
import { AuditLog } from "../src/storage/audit.ts";
import { openDatabase } from "../src/storage/database.ts";

const LOCK_MODULE = new URL("../src/core/lock.ts", import.meta.url).href;
let base = "";
before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "p5-p213-"));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function holdLock(dataDir: string, resource: string, holdMs: number): Promise<{ killed: () => void; waitHeld: () => Promise<void> }> {
  const script = path.join(base, `hold-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mjs`);
  await writeFile(
    script,
    `import { FileLock } from ${JSON.stringify(LOCK_MODULE)};
const lock = new FileLock({ dataDir: process.argv[2], resource: process.argv[3], operation: "child-hold" });
const r = await lock.acquire();
console.log("STATE " + r.state);
if (r.state === "ACQUIRED") console.log("HELD");
await new Promise((res) => setTimeout(res, Number(process.argv[4] ?? 1000)));
if (r.state === "ACQUIRED") await lock.release();
console.log("RELEASED");
`,
    "utf8",
  );
  const child = spawn(process.execPath, [script, dataDir, resource, String(holdMs)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  return {
    killed: () => child.kill("SIGKILL"),
    waitHeld: async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (out.includes("HELD")) return;
        await sleep(20);
      }
      throw new Error(`child did not hold lock: ${out}`);
    },
  };
}

describe("P2-13 write-path locks", () => {
  it("blocks rule writes while another process holds the global lock", { timeout: 30000 }, async () => {
    const dataDir = path.join(base, "rules", "data");
    await mkdir(dataDir, { recursive: true });
    const holder = await holdLock(dataDir, "global", 2500);
    await holder.waitHeld();
    const rules = new RuleStore(dataDir);
    await assert.rejects(() => rules.create({ id: "r1", title: "t", body: "b" }), (e: unknown) => {
      assert.equal((e as { code?: string }).code, "conflict");
      return true;
    });
    await sleep(2600);
    const created = await rules.create({ id: "r1", title: "t", body: "b" });
    assert.equal(created.id, "r1", "锁释放后写入必须成功");
  });

  it("blocks skill import/remove while another process holds the global lock", { timeout: 30000 }, async () => {
    const dataDir = path.join(base, "skills", "data");
    const src = path.join(base, "skills", "src", "demo-skill");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "SKILL.md"), ["---", "name: demo-skill", "description: x", "---", ""].join("\n"));
    await mkdir(dataDir, { recursive: true });
    const holder = await holdLock(dataDir, "global", 2500);
    await holder.waitHeld();
    const lib = new SkillLibrary(dataDir);
    await assert.rejects(() => lib.import(src), (e: unknown) => {
      assert.equal((e as { code?: string }).code, "conflict");
      return true;
    });
    await sleep(2600);
    const imported = await lib.import(src);
    assert.equal(imported.name, "demo-skill");
    // remove 同样受保护
    const holder2 = await holdLock(dataDir, "global", 1200);
    await holder2.waitHeld();
    await assert.rejects(() => lib.remove("demo-skill"), (e: unknown) => {
      assert.equal((e as { code?: string }).code, "conflict");
      return true;
    });
    await sleep(1300);
    await lib.remove("demo-skill");
  });

  it("blocks self-config updates while another process holds the global lock", { timeout: 30000 }, async () => {
    const dataDir = path.join(base, "cfg", "data");
    await mkdir(dataDir, { recursive: true });
    const store = new ConfigStore(dataDir);
    await store.load();
    const holder = await holdLock(dataDir, "global", 2500);
    await holder.waitHeld();
    await assert.rejects(() => store.update({ port: 7999 }), (e: unknown) => {
      assert.equal((e as { code?: string }).code, "conflict");
      return true;
    });
    assert.equal(store.get().port, 7801, "被阻止时内存态也不得改变");
    await sleep(2600);
    const next = await store.update({ port: 7999 });
    assert.equal(next.port, 7999);
  });

  it("keeps the audit chain valid under multi-process appends", { timeout: 40000 }, async () => {
    const dataDir = path.join(base, "audit", "data");
    await mkdir(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, "purgeplus.db");
    // 先初始化库结构
    const init = openDatabase(dbFile);
    init.close();
    const script = path.join(base, "audit-writer.mjs");
    await writeFile(
      script,
      `import { openDatabase } from ${JSON.stringify(new URL("../src/storage/database.ts", import.meta.url).href)};
import { AuditLog } from ${JSON.stringify(new URL("../src/storage/audit.ts", import.meta.url).href)};
const db = openDatabase(process.argv[2]);
const audit = new AuditLog(db);
for (let i = 0; i < Number(process.argv[4] ?? 10); i += 1) {
  audit.append({ actor: process.argv[3], action: "concurrent.append", target: "test", risk: 0 });
}
db.close();
`,
      "utf8",
    );
    const writers = Array.from({ length: 3 }, (_, i) =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [script, dbFile, `w${i}`, "20"], { stdio: ["ignore", "pipe", "pipe"] });
        let err = "";
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        child.on("close", (code) => resolve(code ?? -1));
        if (err) process.stderr.write(err);
      }),
    );
    const codes = await Promise.all(writers);
    const db = openDatabase(dbFile);
    const audit = new AuditLog(db);
    const verify = audit.verify();
    const count = audit.count();
    db.close();
    assert.deepEqual(codes, [0, 0, 0], "所有写进程必须正常退出");
    assert.equal(count, 60, `期望 60 条审计，实际 ${count}`);
    assert.equal(verify.ok, true, `链必须完整：${verify.reason ?? ""}`);
  });

  it("a failed append leaves no partial record", { timeout: 20000 }, async () => {
    const dir = path.join(base, "partial", "data");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "purgeplus.db");
    const db = openDatabase(file);
    const audit = new AuditLog(db);
    audit.append({ actor: "a", action: "ok", risk: 0 });
    db.close();
    // 关闭后写入必然失败：事务内失败必须回滚，不能留下半条
    assert.throws(() => audit.append({ actor: "b", action: "after-close", risk: 0 }));
    const reopened = openDatabase(file);
    const audit2 = new AuditLog(reopened);
    assert.equal(audit2.count(), 1, "失败不得留下半条记录");
    audit2.append({ actor: "c", action: "after", risk: 0 });
    assert.equal(audit2.verify().ok, true);
    assert.equal(audit2.count(), 2);
    reopened.close();
  });

  it("circular detail is redacted rather than crashing the append", { timeout: 20000 }, async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const entry = audit.append({ actor: "a", action: "cyclic", detail: cyclic });
    assert.ok(entry.seq > 0);
    assert.equal(audit.verify().ok, true);
    db.close();
  });
});
