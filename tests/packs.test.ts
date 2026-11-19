import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { PurgeError } from "../src/core/errors.ts";
import { PackEngine } from "../src/packs/engine.ts";
import { applyRuleToText, countHits, evaluateRule } from "../src/packs/matcher.ts";
import { packHash, packSupportsVersion, validatePack, type Pack } from "../src/packs/schema.ts";
import { SnapshotStore } from "../src/recovery/snapshot.ts";
import { Transaction } from "../src/recovery/transaction.ts";
import { openMemoryDatabase } from "../src/storage/database.ts";

function makePack(overrides: Partial<Pack> = {}): Pack {
  return {
    schema: "purgeplus.pack/1",
    id: "demo-pack",
    name: "演示包",
    version: "1.0.0",
    target: { adapter: "dsh" },
    risk: { level: "medium", reasons: ["改写宿主代码"] },
    rules: [
      {
        id: "r1",
        layer: "code",
        path: "pkg/lib/index.js",
        markers: ["[purge-plus]"],
        replacements: [{ pattern: "const timeout = 1;", replace: "const timeout = 300; // [purge-plus]" }],
      },
    ],
    ...overrides,
  };
}

describe("pack schema", () => {
  it("accepts a well formed pack", () => {
    const pack = validatePack(makePack());
    assert.equal(pack.id, "demo-pack");
  });

  it("rejects packs whose replacement lacks a marker", () => {
    const bad = makePack({
      rules: [
        {
          id: "r1",
          layer: "code",
          path: "a.js",
          markers: ["[purge-plus]"],
          replacements: [{ pattern: "x", replace: "y" }],
        },
      ],
    });
    assert.throws(() => validatePack(bad), /marker/);
  });

  it("rejects path escapes and missing ids", () => {
    const bad = makePack({
      rules: [{ id: "r1", layer: "code", path: "../etc/passwd", markers: ["[x]"], replacements: [{ pattern: "a", replace: "b[x]" }] }],
    });
    assert.throws(() => validatePack(bad), /relative path/);
    assert.throws(() => validatePack(makePack({ id: "" })), /id must match/);
    assert.throws(() => validatePack(makePack({ rules: [] })), /non-empty/);
  });

  it("hashes canonically and matches versions", () => {
    const a = makePack();
    const b = makePack();
    assert.equal(packHash(a), packHash(b));
    assert.notEqual(packHash(a), packHash(makePack({ version: "1.0.1" })));
    assert.equal(packSupportsVersion(makePack({ target: { adapter: "dsh", versions: ["0.2.x"] } }), "0.2.2-rc.5"), true);
    assert.equal(packSupportsVersion(makePack({ target: { adapter: "dsh", versions: ["0.1.x"] } }), "0.2.2-rc.5"), false);
  });
});

describe("matcher", () => {
  it("counts literal and regex hits", () => {
    assert.equal(countHits("a b a", "a"), 2);
    assert.equal(countHits("foo1 foo2", "/foo\\d/g"), 2);
  });

  it("marks applied when the marker is present", () => {
    const rule = makePack().rules[0];
    const text = "const timeout = 300; // [purge-plus]";
    assert.equal(evaluateRule(text, rule as never).status, "applied");
  });

  it("reports drifted vs hit_mismatch distinctly", () => {
    const rule = makePack().rules[0];
    assert.equal(evaluateRule("const timeout = 999;", rule as never).status, "drifted");
    const twice = makePack({
      rules: [
        {
          id: "r1",
          layer: "code",
          path: "a.js",
          markers: ["[purge-plus]"],
          replacements: [{ pattern: "dup", replace: "dup [purge-plus]" }],
        },
      ],
    });
    assert.equal(evaluateRule("dup dup", twice.rules[0] as never).status, "hit_mismatch");
  });

  it("refuses to write when the hit count differs from expect", () => {
    const pack = makePack({
      rules: [
        {
          id: "r1",
          layer: "code",
          path: "a.js",
          markers: ["[purge-plus]"],
          replacements: [{ pattern: "dup", replace: "x [purge-plus]", expect: 1 }],
        },
      ],
    });
    assert.throws(() => applyRuleToText("dup dup", pack.rules[0] as never), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "integrity_failed");
      return true;
    });
  });
});

describe("pack engine", () => {
  let base = "";
  let dataDir = "";
  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "purgeplus-pack-"));
    dataDir = await mkdtemp(path.join(tmpdir(), "purgeplus-packdata-"));
    await mkdir(path.join(base, "pkg", "lib"), { recursive: true });
    await writeFile(path.join(base, "pkg", "lib", "index.js"), "const timeout = 1;\nexport const x = 1;\n");
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  function engine() {
    const db = openMemoryDatabase();
    const snapshots = new SnapshotStore(dataDir, db);
    const e = new PackEngine({
      snapshots,
      createTransaction: async (label, targets) => {
        const tx = new Transaction(label, { snapshots });
        await tx.begin(targets);
        return tx;
      },
    });
    return { e, snapshots, db };
  }

  it("plans without touching the disk", async () => {
    const { e, db } = engine();
    const before = await readFile(path.join(base, "pkg", "lib", "index.js"), "utf8");
    const plan = await e.plan(makePack(), { baseRoot: base, hostVersion: "0.2.2-rc.5" });
    assert.equal(plan.summary.pending, 1);
    assert.equal(plan.changes, true);
    assert.ok(plan.entries[0]?.preview?.includes("+"));
    assert.equal(await readFile(path.join(base, "pkg", "lib", "index.js"), "utf8"), before, "plan must be read-only");
    db.close();
  });

  it("applies inside a transaction, verifies, and becomes idempotent", async () => {
    const { e, db } = engine();
    const result = await e.apply(makePack(), { baseRoot: base, hostVersion: "0.2.2-rc.5" });
    assert.equal(result.written.length, 1);
    const text = await readFile(path.join(base, "pkg", "lib", "index.js"), "utf8");
    assert.ok(text.includes("const timeout = 300; // [purge-plus]"));
    const after = await e.plan(makePack(), { baseRoot: base, hostVersion: "0.2.2-rc.5" });
    assert.equal(after.summary.applied, 1);
    assert.equal(after.summary.pending, 0);
    await assert.rejects(() => e.apply(makePack(), { baseRoot: base, hostVersion: "0.2.2-rc.5" }), /no pending rules/);
    db.close();
  });

  it("reverts to the exact pre-apply bytes via snapshot", async () => {
    const { e, db } = engine();
    const file = path.join(base, "pkg", "lib", "index.js");
    const original = (await readFile(file, "utf8")).replace("const timeout = 300; // [purge-plus]", "const timeout = 1;");
    await writeFile(file, original);
    const result = await e.apply(makePack(), { baseRoot: base, hostVersion: "0.2.2-rc.5" });
    assert.ok((await readFile(file, "utf8")).includes("[purge-plus]"));
    const reverted = await e.revert(result.snapshotId);
    assert.deepEqual(reverted.failed, []);
    assert.equal(await readFile(file, "utf8"), original);
    db.close();
  });

  it("reports drifted (not skipped) when the anchor disappears", async () => {
    const { e, db } = engine();
    await writeFile(path.join(base, "pkg", "lib", "index.js"), "const somethingElse = 2;\n");
    const plan = await e.plan(makePack(), { baseRoot: base, hostVersion: "0.2.2-rc.5" });
    assert.equal(plan.entries[0]?.status, "drifted");
    assert.equal(plan.changes, false);
    db.close();
  });

  it("reports missing targets and optional rules without failing the pack", async () => {
    const { e, db } = engine();
    const pack = makePack({
      rules: [
        { id: "a", layer: "code", path: "gone.js", markers: ["[purge-plus]"], replacements: [{ pattern: "x", replace: "y [purge-plus]" }], optional: true },
        { id: "b", layer: "code", path: "pkg/lib/index.js", markers: ["[purge-plus]"], replacements: [{ pattern: "const somethingElse = 2;", replace: "const somethingElse = 3; // [purge-plus]" }] },
      ],
    });
    const plan = await e.plan(pack, { baseRoot: base, hostVersion: "0.2.2-rc.5" });
    assert.ok(plan.entries.some((x) => x.ruleId === "a" && x.status === "missing"));
    assert.equal(plan.summary.pending, 1);
    db.close();
  });

  it("refuses paths outside the base root", async () => {
    const { e, db } = engine();
    const pack = makePack({
      rules: [{ id: "r", layer: "code", path: "../escape.js", markers: ["[x]"], replacements: [{ pattern: "a", replace: "b[x]" }] }],
    });
    assert.throws(() => validatePack(pack), /relative path/);
    db.close();
  });
});
