import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { readAsarFile, readAsarIndex, readAsarJson, listAsarTop, lookupAsarNode } from "../src/adapters/asar.ts";
import { DshHostAdapter } from "../src/adapters/dsh.ts";
import { PurgeError } from "../src/core/errors.ts";

/** 写一个最小合法 ASAR（仅供测试，生产侧是只读的）。 */
export async function writeAsar(file: string, entries: Record<string, Buffer>, unpacked: string[] = []): Promise<void> {
  const files: Record<string, unknown> = {};
  let offset = 0;
  const blobs: Buffer[] = [];
  for (const [rel, buf] of Object.entries(entries)) {
    const parts = rel.split("/");
    let node = files;
    for (const part of parts.slice(0, -1)) {
      node[part] = (node[part] as Record<string, unknown>) ?? { files: {} };
      node = (node[part] as { files: Record<string, unknown> }).files;
    }
    node[parts[parts.length - 1] as string] = { size: buf.length, offset: String(offset), unpacked: unpacked.includes(rel) };
    offset += buf.length;
    blobs.push(buf);
  }
  const json = Buffer.from(JSON.stringify({ files }), "utf8");
  const headerSize = 8 + json.length;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(headerSize, 4);
  head.writeUInt32LE(json.length, 8);
  head.writeUInt32LE(json.length, 12);
  await writeFile(file, Buffer.concat([head, json, ...blobs]));
}

describe("asar reader", () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "purgeplus-asar-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the index, entries and nested files", async () => {
    const file = path.join(dir, "app.asar");
    await writeAsar(file, {
      "package.json": Buffer.from(JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: "9.9.9", main: "lib/main.js" })),
      "lib/main.js": Buffer.from("console.log('hi')"),
      "lib/nested/x.txt": Buffer.from("nested"),
    });
    const idx = await readAsarIndex(file);
    assert.deepEqual(listAsarTop(idx), ["lib", "package.json"]);
    const pkg = await readAsarJson<{ name: string; version: string }>(file, "package.json");
    assert.equal(pkg.name, "@deepseek-ai/dsh-desktop");
    assert.equal(pkg.version, "9.9.9");
    assert.equal((await readAsarFile(file, "lib/nested/x.txt")).toString(), "nested");
    assert.equal(lookupAsarNode(idx, "lib/missing.js"), undefined);
  });

  it("rejects non-asar files with a typed error", async () => {
    const file = path.join(dir, "bad.asar");
    await writeFile(file, Buffer.from("this is not an asar archive at all"));
    await assert.rejects(() => readAsarIndex(file), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "schema_invalid");
      return true;
    });
  });

  it("reports missing entries instead of returning garbage", async () => {
    const file = path.join(dir, "app2.asar");
    await writeAsar(file, { "a.txt": Buffer.from("a") });
    await assert.rejects(() => readAsarFile(file, "b.txt"), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "not_found");
      return true;
    });
  });
});

describe("dsh host adapter", () => {
  let base = "";
  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "purgeplus-dsh-"));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("identifies a sealed host from the archive alone", async () => {
    const resources = path.join(base, "sealed", "resources");
    await mkdir(resources, { recursive: true });
    await writeAsar(path.join(resources, "app.asar"), {
      "package.json": Buffer.from(
        JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: "0.2.2-rc.5", main: "lib/main.js", dshBuildCommit: "abc123" }),
      ),
    });
    const adapter = new DshHostAdapter({ extraRoots: [resources], dshHome: path.join(base, "sealed", "home"), includeDefaults: false, skipProcessProbe: true });
    const candidates = await adapter.discover();
    assert.equal(candidates.length, 1);
    const facts = await adapter.inspect(candidates[0] as never);
    assert.equal(facts.shape, "sealed");
    assert.equal(facts.identity.product, "@deepseek-ai/dsh-desktop");
    assert.equal(facts.identity.version, "0.2.2-rc.5");
    assert.equal(facts.identity.commit, "abc123");
    assert.equal(facts.identity.confidence, "verified");
    assert.equal(facts.archive.readable, true);
    assert.equal(facts.unpacked.exists, false);
    assert.equal(facts.process.running, null, "process state stays unknown when probing is disabled");
    assert.equal(facts.loadedShape, "unknown");
  });

  it("detects an unpacked host, its profiles and third-party modification footprint", async () => {
    const root = path.join(base, "unpacked");
    const resources = path.join(root, "resources");
    const app = path.join(resources, "app");
    const home = path.join(root, "home");
    await mkdir(path.join(app, "lib"), { recursive: true });
    await mkdir(path.join(app, "node_modules", "@deepseek-ai", "dsh-user-approval", "lib"), { recursive: true });
    await mkdir(path.join(home, "profiles", "desktop"), { recursive: true });
    await mkdir(path.join(home, "dsh-purge"), { recursive: true });
    await writeFile(
      path.join(app, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: "0.2.2-rc.1", main: "lib/main.js" }),
    );
    await writeFile(path.join(app, "lib", "main.js"), "// clean\n");
    await writeFile(
      path.join(app, "node_modules", "@deepseek-ai", "dsh-user-approval", "lib", "index.js"),
      "// [dsh-purge] approval auto-granted\n",
    );
    await writeFile(
      path.join(home, "profiles", "desktop", "package.json"),
      JSON.stringify({ dependencies: { "some-plugin": "1.0.0" }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }),
    );
    await writeFile(path.join(home, "dsh-purge", "applied.json"), JSON.stringify({ version: "1.6.91", at: "2026-01-01T00:00:00Z" }));

    const adapter = new DshHostAdapter({ extraRoots: [resources], dshHome: home, includeDefaults: false, skipProcessProbe: true });
    const candidates = await adapter.discover();
    const facts = await adapter.inspect(candidates[0] as never);
    assert.equal(facts.shape, "unpacked");
    assert.equal(facts.profiles.length, 1);
    assert.deepEqual(facts.profiles[0]?.dependencies, { "some-plugin": "1.0.0" });
    assert.deepEqual(facts.profiles[0]?.bundles, ["@deepseek-ai/dsh-base"]);
    assert.equal(facts.modification.packs.length, 1);
    assert.equal(facts.modification.packs[0]?.tool, "dsh-purge");
    assert.equal(facts.modification.packs[0]?.version, "1.6.91");
    assert.ok(facts.modification.markerHits.length >= 1);
    assert.equal(facts.modification.looksModified, true);
  });

  it("returns no candidates when nothing looks like a host", async () => {
    const empty = path.join(base, "empty");
    await mkdir(empty, { recursive: true });
    const adapter = new DshHostAdapter({ extraRoots: [empty], dshHome: path.join(empty, "home"), includeDefaults: false, skipProcessProbe: true });
    assert.deepEqual(await adapter.discover(), []);
  });
});
