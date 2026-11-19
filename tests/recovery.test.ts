import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { SnapshotStore } from "../src/recovery/snapshot.ts";
import { Transaction } from "../src/recovery/transaction.ts";
import { openMemoryDatabase } from "../src/storage/database.ts";

async function tempDir(tag: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `purgeplus-${tag}-`));
}

describe("snapshot store", () => {
  let dir = "";
  let dataDir = "";
  before(async () => {
    dir = await tempDir("snap");
    dataDir = await tempDir("snapdata");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("captures files, dirs and absent paths, then restores exact bytes", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(dataDir, db);
    const file = path.join(dir, "a.txt");
    const sub = path.join(dir, "sub");
    const absent = path.join(dir, "missing.txt");
    await writeFile(file, "original", "utf8");
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, "b.txt"), "nested", "utf8");

    const snap = await store.capture("test", [file, sub, absent]);
    assert.equal(snap.stats.files, 2);
    assert.equal(snap.stats.dirs, 1);
    assert.ok(snap.manifest.entries.some((e) => e.type === "absent" && e.path === absent));

    await writeFile(file, "changed", "utf8");
    await rm(path.join(sub, "b.txt"));
    await writeFile(absent, "now exists", "utf8");

    const r = await store.restore(snap.snapId);
    assert.deepEqual(r.failed, []);
    assert.equal(await readFile(file, "utf8"), "original");
    assert.equal(await readFile(path.join(sub, "b.txt"), "utf8"), "nested");
    await assert.rejects(() => stat(absent));
    db.close();
  });

  it("detects tampered objects", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(dataDir, db);
    const file = path.join(dir, "c.txt");
    await writeFile(file, "payload-that-is-long-enough-to-be-hashed", "utf8");
    const snap = await store.capture("tamper", [file]);
    const entry = snap.manifest.entries.find((e) => e.type === "file");
    assert.ok(entry?.hash);
    const objPath = store.objectPath(entry.hash);
    await writeFile(objPath, "corrupted", "utf8");
    const v = await store.verify(snap.snapId);
    assert.equal(v.ok, false);
    assert.ok(v.issues.some((i) => i.includes("missing/corrupt")));
    db.close();
  });

  it("inlines small files and keeps big ones in the object store", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(dataDir, db);
    const small = path.join(dir, "small.txt");
    const big = path.join(dir, "big.bin");
    await writeFile(small, "small", "utf8");
    await writeFile(big, Buffer.alloc(40 * 1024, 7));
    const snap = await store.capture("inline", [small, big]);
    const smallEntry = snap.manifest.entries.find((e) => e.path === small);
    const bigEntry = snap.manifest.entries.find((e) => e.path === big);
    assert.ok(smallEntry?.inline);
    assert.equal(bigEntry?.inline, undefined);
    assert.equal(snap.stats.inline, 1);
    db.close();
  });

  it("prunes unreferenced objects without touching referenced ones", async () => {
    const db = openMemoryDatabase();
    const store = new SnapshotStore(dataDir, db);
    const file = path.join(dir, "keep.txt");
    await writeFile(file, "keep me", "utf8");
    const snap = await store.capture("prune", [file]);
    const kept = snap.manifest.entries.find((e) => e.type === "file")?.hash;
    assert.ok(kept);
    const orphan = await store.putObject(Buffer.from("orphan-payload"));
    const res = await store.prune();
    assert.ok(res.removed >= 1);
    await store.getObject(kept);
    await assert.rejects(() => store.getObject(orphan));
    db.close();
  });
});

describe("transaction", () => {
  let dir = "";
  let dataDir = "";
  before(async () => {
    dir = await tempDir("tx");
    dataDir = await tempDir("txdata");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("requires begin() before mutating", async () => {
    const db = openMemoryDatabase();
    const snapshots = new SnapshotStore(dataDir, db);
    const tx = new Transaction("no-begin", { snapshots });
    await assert.rejects(() => tx.write(path.join(dir, "x.txt"), "x"), /call begin/);
    db.close();
  });

  it("commits only after verify passes", async () => {
    const db = openMemoryDatabase();
    const snapshots = new SnapshotStore(dataDir, db);
    const file = path.join(dir, "commit.txt");
    await writeFile(file, "v1", "utf8");
    const tx = new Transaction("commit", { snapshots, actor: "test" });
    await tx.begin([file]);
    await tx.write(file, "v2");
    assert.throws(() => tx.commit(), /verify/);
    const v = await tx.verify();
    assert.equal(v.ok, true);
    const res = tx.commit();
    assert.equal(res.state, "committed");
    assert.equal(await readFile(file, "utf8"), "v2");
    db.close();
  });

  it("rolls back writes and removals to the pre-transaction state", async () => {
    const db = openMemoryDatabase();
    const snapshots = new SnapshotStore(dataDir, db);
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    const c = path.join(dir, "created.txt");
    await writeFile(a, "A0", "utf8");
    await writeFile(b, "B0", "utf8");
    const tx = new Transaction("rollback", { snapshots, actor: "test" });
    await tx.begin([a, b, c]);
    await tx.write(a, "A1");
    await tx.remove(b);
    await tx.write(c, "C1");
    const res = await tx.rollback();
    assert.equal(res.state, "rolled_back");
    assert.equal(await readFile(a, "utf8"), "A0");
    assert.equal(await readFile(b, "utf8"), "B0");
    await assert.rejects(() => stat(c));
    db.close();
  });

  it("refuses to roll back a committed transaction", async () => {
    const db = openMemoryDatabase();
    const snapshots = new SnapshotStore(dataDir, db);
    const f = path.join(dir, "z.txt");
    await writeFile(f, "z0", "utf8");
    const tx = new Transaction("done", { snapshots });
    await tx.begin([f]);
    await tx.write(f, "z1");
    await tx.verify();
    tx.commit();
    await assert.rejects(() => tx.rollback(), /committed/);
    assert.equal(await readFile(f, "utf8"), "z1");
    db.close();
  });

  it("verify reports external modification", async () => {
    const db = openMemoryDatabase();
    const snapshots = new SnapshotStore(dataDir, db);
    const f = path.join(dir, "race.txt");
    await writeFile(f, "start", "utf8");
    const tx = new Transaction("race", { snapshots });
    await tx.begin([f]);
    await tx.write(f, "mine");
    await writeFile(f, "someone-else", "utf8");
    const v = await tx.verify();
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => p.includes("hash")));
    await tx.rollback();
    assert.equal(await readFile(f, "utf8"), "start");
    db.close();
  });
});
