/**
 * P2-08 恢复冲突检测测试：
 *  - 快照之后被修改的文件默认阻止恢复
 *  - DELETED / UNCHANGED 允许恢复
 *  - force 必须给 authorizedBy
 *  - force 记录被覆盖的哈希
 *  - 预演与写盘之间的 TOCTOU 复检
 *  - 快照自身损坏（CORRUPTED）阻止恢复
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { PurgeError } from "../src/core/errors.ts";
import { SnapshotStore } from "../src/recovery/snapshot.ts";
import { openMemoryDatabase } from "../src/storage/database.ts";

let base = "";
before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "p5-recovery-"));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

async function fixture(sub: string) {
  const dir = path.join(base, sub);
  await mkdir(dir, { recursive: true });
  const db = openMemoryDatabase();
  const store = new SnapshotStore(path.join(dir, "data"), db);
  return { dir, db, store };
}

describe("P2-08 restore conflict detection", () => {
  it("blocks restore when the file changed after the snapshot", async () => {
    const { dir, db, store } = await fixture("modified");
    const file = path.join(dir, "a.txt");
    await writeFile(file, "v0", "utf8");
    const snap = await store.capture("s", [file]);
    await writeFile(file, "v1-user-edit", "utf8");

    const plan = await store.planRestore(snap.snapId);
    assert.equal(plan.blocked, true);
    assert.equal(plan.conflicts, 1);
    // 文件在快照之后被改写，mtime 必然更新 → 可能是 MODIFIED 或 NEWER，两者都属冲突
    assert.ok(["MODIFIED", "NEWER"].includes(plan.entries[0]?.status ?? ""));

    await assert.rejects(() => store.restore(snap.snapId), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "conflict");
      const detail = err.detail as { plan: { conflicts: number } };
      assert.equal(detail.plan.conflicts, 1);
      return true;
    });
    assert.equal(await readFile(file, "utf8"), "v1-user-edit", "被阻止时绝不能改文件");
    db.close();
  });

  it("allows restore when the file is unchanged (no-op semantics)", async () => {
    const { dir, db, store } = await fixture("unchanged");
    const file = path.join(dir, "a.txt");
    await writeFile(file, "v0", "utf8");
    const snap = await store.capture("s", [file]);
    const plan = await store.planRestore(snap.snapId);
    assert.equal(plan.blocked, false);
    const result = await store.restore(snap.snapId);
    assert.deepEqual(result.failed, []);
    assert.equal(await readFile(file, "utf8"), "v0");
    db.close();
  });

  it("allows restoring a file that was deleted (DELETED is not a conflict)", async () => {
    const { dir, db, store } = await fixture("deleted");
    const file = path.join(dir, "a.txt");
    await writeFile(file, "v0", "utf8");
    const snap = await store.capture("s", [file]);
    await rm(file);
    const plan = await store.planRestore(snap.snapId);
    assert.equal(plan.entries[0]?.status, "DELETED");
    assert.equal(plan.blocked, false);
    await store.restore(snap.snapId);
    assert.equal(await readFile(file, "utf8"), "v0");
    db.close();
  });

  it("marks files newer than the snapshot as NEWER and blocks them", async () => {
    const { dir, db, store } = await fixture("newer");
    const file = path.join(dir, "a.txt");
    await writeFile(file, "v0", "utf8");
    const snap = await store.capture("s", [file]);
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(file, "v1", "utf8");
    const plan = await store.planRestore(snap.snapId);
    assert.ok(["NEWER", "MODIFIED"].includes(plan.entries[0]?.status ?? ""));
    assert.equal(plan.blocked, true);
    db.close();
  });

  it("requires authorizedBy for force restore", async () => {
    const { dir, db, store } = await fixture("force-noauth");
    const file = path.join(dir, "a.txt");
    await writeFile(file, "v0", "utf8");
    const snap = await store.capture("s", [file]);
    await writeFile(file, "v1", "utf8");
    await assert.rejects(() => store.restore(snap.snapId, { policy: "force" }), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "policy_denied");
      return true;
    });
    assert.equal(await readFile(file, "utf8"), "v1");
    db.close();
  });

  it("force restore records who authorized it and which hashes were overwritten", async () => {
    const { dir, db, store } = await fixture("force");
    const file = path.join(dir, "a.txt");
    await writeFile(file, "v0", "utf8");
    const snap = await store.capture("s", [file]);
    await writeFile(file, "v1", "utf8");
    const beforeHash = (await store.planRestore(snap.snapId)).entries[0]?.currentHash;

    const result = await store.restore(snap.snapId, { policy: "force", authorizedBy: "alice", reason: "rollback experiment" });
    assert.deepEqual(result.failed, []);
    assert.equal(await readFile(file, "utf8"), "v0");
    assert.ok(result.force);
    assert.equal(result.force?.authorizedBy, "alice");
    assert.equal(result.force?.reason, "rollback experiment");
    assert.equal(result.force?.overwritten.length, 1);
    assert.equal(result.force?.overwritten[0]?.fromHash, beforeHash);
    assert.ok(result.preSnapshotId, "强制恢复前必须留下保护快照");
    db.close();
  });

  it("detects a change that happened between plan and apply (TOCTOU)", async () => {
    const { dir, db, store } = await fixture("toctou");
    const file = path.join(dir, "a.txt");
    await writeFile(file, "v0", "utf8");
    const snap = await store.capture("s", [file]);
    await assert.rejects(
      () =>
        store.restore(snap.snapId, {
          onBeforeApply: async () => {
            await writeFile(file, "changed-during-restore", "utf8");
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof PurgeError);
        assert.equal(err.code, "conflict");
        assert.match(err.message, /state changed between plan and apply/);
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), "changed-during-restore", "复检发现变化后必须放弃写入");
    db.close();
  });

  it("blocks when the snapshot content itself is corrupted", async () => {
    const { dir, db, store } = await fixture("corrupt");
    const file = path.join(dir, "a.txt");
    await writeFile(file, Buffer.alloc(40 * 1024, 65));
    const snap = await store.capture("s", [file]);
    const entry = snap.manifest.entries.find((e) => e.type === "file");
    assert.ok(entry?.hash);
    await writeFile(store.objectPath(entry.hash), "corrupted", "utf8");
    await writeFile(file, "current", "utf8");
    const plan = await store.planRestore(snap.snapId);
    assert.equal(plan.entries[0]?.status, "CORRUPTED");
    assert.equal(plan.blocked, true);
    await assert.rejects(() => store.restore(snap.snapId), /conflict/);
    assert.equal(await readFile(file, "utf8"), "current");
    db.close();
  });

  it("deleting a file that appeared after the snapshot requires force", async () => {
    const { dir, db, store } = await fixture("appeared");
    const absent = path.join(dir, "later.txt");
    const snap = await store.capture("s", [absent]);
    await writeFile(absent, "created after snapshot", "utf8");
    const plan = await store.planRestore(snap.snapId);
    // 文件在快照之后被改写，mtime 必然更新 → 可能是 MODIFIED 或 NEWER，两者都属冲突
    assert.ok(["MODIFIED", "NEWER"].includes(plan.entries[0]?.status ?? ""));
    assert.equal(plan.entries[0]?.action, "delete");
    await assert.rejects(() => store.restore(snap.snapId), /conflict/);
    assert.equal(await readFile(absent, "utf8"), "created after snapshot");
    const forced = await store.restore(snap.snapId, { policy: "force", authorizedBy: "bob" });
    assert.deepEqual(forced.failed, []);
    await assert.rejects(() => readFile(absent, "utf8"));
    db.close();
  });
});
