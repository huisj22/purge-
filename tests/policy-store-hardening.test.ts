/**
 * T055-02 Policy Store 加固测试：
 * 并发 CAS、原子写、写后复读、hash/schema 校验、审计失败回滚、跨进程竞争。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { PurgeError } from "../src/core/errors.ts";
import { parseAndVerify, policyHash, PolicyStore, type PolicyStoreOptions } from "../src/security/policy-store.ts";

let base = "";
before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "p55-policy-"));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const file = (dir: string) => path.join(dir, "security", "policy.json");

async function freshStore(sub: string, opts: PolicyStoreOptions = {}) {
  const dir = path.join(base, sub);
  await mkdir(dir, { recursive: true });
  const store = new PolicyStore(dir, opts);
  const state = await store.load();
  return { dir, store, state };
}

describe("T055-02 policy store hardening", () => {
  it("rejects a stale expectedVersion instead of overwriting a newer policy", { timeout: 20000 }, async () => {
    const { store, state } = await freshStore("cas");
    const owner = state.localSubject;
    await store.grant(owner, "owner", { subject: "u1", role: "executor", maxLevel: 2 });
    const v2 = (await store.state()).doc.version;
    await store.grant(owner, "owner", { subject: "u2", role: "executor", maxLevel: 2 });
    await assert.rejects(
      () => store.grant(owner, "owner", { subject: "u3", role: "executor", maxLevel: 2 }, { expectedVersion: v2 }),
      (err: unknown) => {
        assert.ok(err instanceof PurgeError);
        assert.equal(err.code, "conflict");
        return true;
      },
    );
    const doc = (await store.state()).doc;
    assert.equal(doc.grants.length, 2, "被拒绝的写入不得生效");
  });

  it("refuses to resurrect a revoked grant through a stale writer", { timeout: 20000 }, async () => {
    const { store, state } = await freshStore("resurrect");
    const owner = state.localSubject;
    const grant = await store.grant(owner, "owner", { subject: "u1", role: "executor", maxLevel: 3 });
    const versionWithGrant = (await store.state()).doc.version;
    await store.revoke(owner, "owner", grant.id);
    // 旧版本写入者尝试提交"仍包含该授权"的状态
    await assert.rejects(
      () => store.grant(owner, "owner", { subject: "u2", role: "executor", maxLevel: 3 }, { expectedVersion: versionWithGrant }),
      /version conflict/,
    );
    const doc = (await store.state()).doc;
    assert.equal(doc.grants.length, 0, "已撤销的权限不能被旧写入者复活");
  });

  it("serialises two processes that modify the same policy (exactly one wins per version)", { timeout: 40000 }, async () => {
    const dir = path.join(base, "proc", "data");
    await mkdir(dir, { recursive: true });
    const seed = new PolicyStore(dir);
    const { localSubject } = await seed.load();

    const script = path.join(base, "policy-writer.mjs");
    await writeFile(
      script,
      `import { PolicyStore } from ${JSON.stringify(new URL("../src/security/policy-store.ts", import.meta.url).href)};
const [dir, subject, tag, rounds] = process.argv.slice(2);
const store = new PolicyStore(dir, { lockWaitMs: 8000 });
const { localSubject } = await store.load();
for (let i = 0; i < Number(rounds); i += 1) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const cur = await store.state();
      await store.grant(localSubject, "owner", { subject: tag + "-" + i, role: "executor", maxLevel: 1 }, { expectedVersion: cur.doc.version });
      break;
    } catch (err) {
      const code = err && err.code;
      if ((code !== "conflict") || attempt >= 100) throw err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
console.log("DONE");
`,
      "utf8",
    );
    const children = ["a", "b", "c"].map((tag) => spawn(process.execPath, [script, dir, localSubject, tag, "5"], { stdio: ["ignore", "pipe", "pipe"] }));
    const outs = children.map(() => "");
    children.forEach((c, i) => {
      c.stdout?.on("data", (d: Buffer) => (outs[i] += d.toString()));
      c.stderr?.on("data", (d: Buffer) => (outs[i] += d.toString()));
    });
    await Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r(null) : c.once("close", r)))));
    assert.deepEqual(outs.map((o) => o.includes("DONE")), [true, true, true], `写进程必须全部成功：${outs.join(" | ")}`);

    const store = new PolicyStore(dir);
    const doc = (await store.load()).doc;
    assert.equal(doc.grants.length, 15, `3 进程 × 5 次授予应全部落地（实际 ${doc.grants.length}）`);
    assert.equal(policyHash(doc), doc.hash);
  });

  it("keeps the previous file intact when the rename step fails", { timeout: 20000 }, async () => {
    const dir = path.join(base, "rename-fail");
    await mkdir(dir, { recursive: true });
    const store = new PolicyStore(dir, {
      hooks: {
        beforeRename: async () => {
          throw new Error("simulated rename failure");
        },
      },
    });
    const { localSubject } = await store.load();
    const before = await readFile(file(dir), "utf8");
    await assert.rejects(() => store.grant(localSubject, "owner", { subject: "u1", role: "executor", maxLevel: 1 }), /failed to persist policy/);
    assert.equal(await readFile(file(dir), "utf8"), before, "替换失败时旧策略必须保持可读且未变");
  });

  it("leaves no partial policy when the process dies mid-write (temp files are ignored)", { timeout: 20000 }, async () => {
    const { dir, store, state } = await freshStore("tempfile");
    await store.grant(state.localSubject, "owner", { subject: "u1", role: "executor", maxLevel: 1 });
    // 模拟中断：留下一个未 rename 的临时文件
    const stray = `${file(dir)}.tmp-999-deadbeef`;
    await writeFile(stray, '{"schema":"purgeplus.policy/1"', "utf8");
    const reloaded = new PolicyStore(dir);
    const doc = (await reloaded.load()).doc;
    assert.equal(doc.grants.length, 1, "临时文件不得影响读取");
    assert.equal(parseAndVerify(await readFile(file(dir), "utf8"), file(dir)).version, doc.version);
  });

  it("detects hash tampering and schema corruption", { timeout: 20000 }, async () => {
    const { dir, store, state } = await freshStore("tamper");
    await store.grant(state.localSubject, "owner", { subject: "u1", role: "executor", maxLevel: 1 });
    const raw = JSON.parse(await readFile(file(dir), "utf8"));
    raw.owner = "attacker";
    await writeFile(file(dir), JSON.stringify(raw, null, 2), "utf8");
    await assert.rejects(() => new PolicyStore(dir).load(), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "integrity_failed");
      return true;
    });

    await writeFile(file(dir), "{ not json", "utf8");
    await assert.rejects(() => new PolicyStore(dir).load(), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "schema_invalid");
      return true;
    });
  });

  it("rolls the change back when the audit hook fails", { timeout: 20000 }, async () => {
    let calls = 0;
    const dir = path.join(base, "audit-fail");
    await mkdir(dir, { recursive: true });
    const store = new PolicyStore(dir, {
      onChange: () => {
        calls += 1;
        if (calls >= 1) throw new Error("audit backend down");
      },
    });
    const { localSubject } = await store.load();
    const before = await readFile(file(dir), "utf8");
    await assert.rejects(() => store.grant(localSubject, "owner", { subject: "u1", role: "executor", maxLevel: 1 }), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.match(err.message, /audit failed; change reverted/);
      return true;
    });
    assert.equal(await readFile(file(dir), "utf8"), before, "审计失败必须回滚策略文件");
    const reloaded = await new PolicyStore(dir).load();
    assert.equal(reloaded.doc.grants.length, 0);
  });

  it("marks RECOVERY_REQUIRED when both audit and revert fail (no silent loss)", { timeout: 20000 }, async () => {
    const dir = path.join(base, "audit-revert-fail");
    await mkdir(dir, { recursive: true });
    let calls = 0;
    const store = new PolicyStore(dir, {
      onChange: () => {
        calls += 1;
        if (calls >= 1) throw new Error("audit backend down");
      },
      hooks: {
        beforeRestore: async () => {
          throw new Error("simulated revert failure");
        },
      },
    });
    const { localSubject } = await store.load();
    await assert.rejects(() => store.grant(localSubject, "owner", { subject: "u1", role: "executor", maxLevel: 1 }), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.match(String(err.message) + JSON.stringify(err.detail ?? {}), /RECOVERY_REQUIRED|revert failed/);
      return true;
    });
    const marker = await readFile(`${file(dir)}.recovery-required`, "utf8").catch(() => "");
    assert.ok(marker.length > 0, "必须留下 recovery-required 标记供人工处理");
  });

  it("honours TTL under concurrent reads (expired grant flips to deny)", { timeout: 20000 }, async () => {
    const { store, state } = await freshStore("ttl");
    await store.grant(state.localSubject, "owner", {
      subject: "exec",
      role: "executor",
      maxLevel: 3,
      expiresAt: new Date(Date.now() + 120).toISOString(),
    });
    const before = await store.evaluate({ actor: "exec", role: "executor", action: "pack.apply" });
    assert.equal(before.decision, "allow");
    await sleep(160);
    const after = await store.evaluate({ actor: "exec", role: "executor", action: "pack.apply" });
    assert.equal(after.decision, "deny");
  });

  it("re-validates the file when another process changes it (no stale authorization)", { timeout: 20000 }, async () => {
    const { dir, store, state } = await freshStore("refresh");
    const grant = await store.grant(state.localSubject, "owner", { subject: "exec", role: "executor", maxLevel: 3 });
    assert.equal((await store.evaluate({ actor: "exec", role: "executor", action: "pack.apply" })).decision, "allow");
    // 另一个 store 实例撤销授权（写盘 + mtime 变化）
    const other = new PolicyStore(dir);
    await other.load();
    await other.revoke(state.localSubject, "owner", grant.id);
    assert.equal((await store.evaluate({ actor: "exec", role: "executor", action: "pack.apply" })).decision, "deny", "必须重读文件而不是用旧缓存");
  });

  it("verifies write durability: file content equals the in-memory doc after each change", { timeout: 20000 }, async () => {
    const { dir, store, state } = await freshStore("durable");
    for (let i = 0; i < 5; i += 1) {
      await store.grant(state.localSubject, "owner", { subject: `u${i}`, role: "executor", maxLevel: 2 });
      const doc = (await store.state()).doc;
      const onDisk = parseAndVerify(await readFile(file(dir), "utf8"), file(dir));
      assert.equal(onDisk.hash, doc.hash);
      assert.equal(onDisk.version, doc.version);
      assert.equal(onDisk.grants.length, i + 1);
    }
  });
});
