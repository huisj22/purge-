import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigStore, diffConfig } from "../src/core/config.ts";
import { PurgeError } from "../src/core/errors.ts";

describe("config store", () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "purgeplus-config-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("applies defaults when the file is absent", async () => {
    const store = new ConfigStore(path.join(dir, "a"));
    const cfg = await store.load();
    assert.equal(cfg.port, 7801);
    assert.equal(cfg.policy.confirmThreshold, 30);
    assert.equal(cfg.logLevel, "info");
  });

  it("persists updates and records history with field-level diff", async () => {
    const store = new ConfigStore(path.join(dir, "b"));
    await store.load();
    const next = await store.update({ policy: { denyThreshold: 80 }, port: 7999 });
    assert.equal(next.policy.denyThreshold, 80);
    assert.equal(next.policy.confirmThreshold, 30, "untouched nested fields survive merge");
    const onDisk = JSON.parse(await readFile(path.join(dir, "b", "config.json"), "utf8"));
    assert.equal(onDisk.port, 7999);
    const history = await store.history();
    assert.equal(history.length, 1);
    assert.deepEqual(history[0]?.changed.sort(), ["policy.denyThreshold", "port"]);
    assert.equal((await store.readHistorySnapshot(1)).port, 7999);
  });

  it("rejects invalid values without writing", async () => {
    const store = new ConfigStore(path.join(dir, "c"));
    await store.load();
    await assert.rejects(() => store.update({ port: 99999 }), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "schema_invalid");
      const issues = (err.detail as { issues: Array<{ path: string }> }).issues;
      assert.equal(issues[0]?.path, "port");
      return true;
    });
    await assert.rejects(() => readFile(path.join(dir, "c", "config.json"), "utf8"));
  });

  it("reports a corrupt config file instead of silently using defaults", async () => {
    const store = new ConfigStore(path.join(dir, "d"));
    await store.load();
    await store.update({ port: 7000 });
    const file = path.join(dir, "d", "config.json");
    const fs = await import("node:fs/promises");
    await fs.writeFile(file, "{ not json", "utf8");
    await assert.rejects(() => new ConfigStore(path.join(dir, "d")).load(), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "schema_invalid");
      return true;
    });
  });

  it("keeps unknown keys in the file but out of the effective config", async () => {
    const store = new ConfigStore(path.join(dir, "e"));
    await store.load();
    await store.update({ experimentalFlag: true });
    const onDisk = JSON.parse(await readFile(path.join(dir, "e", "config.json"), "utf8"));
    assert.equal(onDisk.experimentalFlag, true);
    assert.equal("experimentalFlag" in store.get(), false);
  });

  it("preserves the original file mode on rewrite", async () => {
    const store = new ConfigStore(path.join(dir, "f"));
    await store.load();
    await store.update({ port: 7100 });
    const file = path.join(dir, "f", "config.json");
    const fs = await import("node:fs/promises");
    await fs.chmod(file, 0o600);
    await store.update({ port: 7101 });
    if (process.platform !== "win32") {
      const st = await stat(file);
      assert.equal(st.mode & 0o777, 0o600);
    }
  });

  it("diffConfig walks nested objects", () => {
    const d = diffConfig({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } });
    assert.deepEqual(d, [{ path: "a.c", from: 2, to: 3 }]);
  });
});
