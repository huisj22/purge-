/**
 * P2-10 权限分级测试：角色分离、策略完整性、AI 边界、TTL/撤销、自提权阻断。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { PurgeError } from "../src/core/errors.ts";
import { levelOfAction, PolicyStore, policyHash } from "../src/security/policy-store.ts";

let base = "";
before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "p5-policy-"));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

const store = (sub: string) => new PolicyStore(path.join(base, sub));

describe("P2-10 policy hierarchy", () => {
  it("bootstraps an owner and rejects self-appointed owner", async () => {
    const s = store("boot");
    const state = await s.load();
    assert.ok(state.doc.owner.includes("@"));
    assert.equal(state.doc.version, 1);
    // 自称 owner 但不是策略 owner → 拒绝
    const verdict = await s.evaluate({ actor: "someone-else", role: "owner", action: "policy.grant" });
    assert.equal(verdict.decision, "deny");
    assert.match(verdict.reason, /not the policy owner/);
  });

  it("only the owner can grant permissions; executor cannot self-grant", async () => {
    const s = store("grant");
    const { doc, localSubject } = await s.load();
    await assert.rejects(
      () => s.grant("exec-1", "executor", { subject: "exec-1", role: "executor", maxLevel: 4 }),
      (err: unknown) => {
        assert.ok(err instanceof PurgeError);
        assert.equal(err.code, "policy_denied");
        return true;
      },
    );
    const grant = await s.grant(localSubject, "owner", { subject: "exec-1", role: "executor", maxLevel: 2 });
    assert.equal(grant.grantedBy, localSubject);
    assert.ok((await s.state()).doc.version > doc.version);
  });

  it("enforces granted level and revokes immediately", async () => {
    const s = store("revoke");
    const { localSubject } = await s.load();
    const grant = await s.grant(localSubject, "owner", { subject: "exec-2", role: "executor", maxLevel: 3 });
    assert.equal((await s.evaluate({ actor: "exec-2", role: "executor", action: "pack.apply" })).decision, "allow");
    await s.revoke(localSubject, "owner", grant.id);
    const after = await s.evaluate({ actor: "exec-2", role: "executor", action: "pack.apply" });
    assert.equal(after.decision, "deny");
  });

  it("expired grants stop working", async () => {
    const s = store("ttl");
    const { localSubject } = await s.load();
    await s.grant(localSubject, "owner", {
      subject: "exec-3",
      role: "executor",
      maxLevel: 3,
      expiresAt: new Date(Date.now() + 50).toISOString(),
    });
    assert.equal((await s.evaluate({ actor: "exec-3", role: "executor", action: "pack.apply" })).decision, "allow");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await s.evaluate({ actor: "exec-3", role: "executor", action: "pack.apply" })).decision, "deny");
  });

  it("AI advisor can never perform L3+ actions or grant permissions", async () => {
    const s = store("ai");
    const l3 = await s.evaluate({ actor: "ai-session", role: "advisor", action: "snapshot.restore" });
    assert.equal(l3.decision, "deny");
    assert.match(l3.reason, /advisor/);
    const l2 = await s.evaluate({ actor: "ai-session", role: "advisor", action: "config.set" });
    assert.equal(l2.decision, "deny", "advisor 没有 grant 时也不能写 L2");
    await assert.rejects(() => s.grant("ai-session", "advisor", { subject: "ai-session", role: "advisor", maxLevel: 2 }), /owner role/);
  });

  it("L4 actions are owner-only even for local operator", async () => {
    const s = store("l4");
    const { localSubject } = await s.load();
    const local = await s.evaluate({ actor: localSubject, role: "owner", action: "update.apply" });
    assert.equal(local.decision, "allow", "本地 owner 可以执行 L4");
    const other = await s.evaluate({ actor: "exec-9", role: "executor", action: "update.apply", level: 4 });
    assert.equal(other.decision, "deny");
  });

  it("action levels map deterministically, unknown actions default to L3", () => {
    assert.equal(levelOfAction("host.inspect"), 0);
    assert.equal(levelOfAction("diagnostic.run"), 1);
    assert.equal(levelOfAction("config.set"), 2);
    assert.equal(levelOfAction("snapshot.restore"), 3);
    assert.equal(levelOfAction("update.apply"), 4);
    assert.equal(levelOfAction("something.unknown"), 3);
  });

  it("detects a tampered policy file instead of silently falling back", async () => {
    const s = store("tamper");
    const { doc } = await s.load();
    const file = path.join(base, "tamper", "security", "policy.json");
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    onDisk.owner = "attacker";
    await writeFile(file, JSON.stringify(onDisk, null, 2), "utf8");
    await assert.rejects(() => new PolicyStore(path.join(base, "tamper")).load(), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "integrity_failed");
      return true;
    });
    // 原 hash 仍然自洽
    assert.equal(policyHash(doc), doc.hash);
  });

  it("records policy changes through the change hook", async () => {
    const events: string[] = [];
    const s = new PolicyStore(path.join(base, "audit"), { onChange: (e) => events.push(e.type) });
    const { localSubject } = await s.load();
    await s.grant(localSubject, "owner", { subject: "exec-4", role: "executor", maxLevel: 1 });
    assert.deepEqual(events, ["policy_grant"]);
  });

  it("auditor role gets no implicit authority", async () => {
    const s = store("auditor");
    await s.load();
    const v = await s.evaluate({ actor: "audit-bot", role: "auditor", action: "config.set" });
    assert.equal(v.decision, "deny");
  });
});
