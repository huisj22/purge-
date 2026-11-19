import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLogger } from "../src/core/logger.ts";
import { PurgeError } from "../src/core/errors.ts";
import { sha256 } from "../src/core/atomic.ts";
import { UpdateService, validateIndex, type ReleaseIndex } from "../src/update/service.ts";
import { compareVersions, isNewer, parseVersion } from "../src/update/version.ts";

describe("semver compare", () => {
  it("orders numeric segments", () => {
    assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
    assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });

  it("treats prerelease as lower than release and compares identifiers", () => {
    assert.equal(compareVersions("1.0.0-alpha", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.2"), -1);
    assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
    assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1, "numeric identifier < alphanumeric");
  });

  it("rejects malformed versions", () => {
    assert.throws(() => parseVersion("1.2"), /invalid semver/);
    assert.throws(() => parseVersion("v1.2.3"), /invalid semver/);
  });

  it("isNewer helpers", () => {
    assert.equal(isNewer("0.2.0", "0.1.9"), true);
    assert.equal(isNewer("0.1.0", "0.1.0"), false);
  });
});

describe("update service", () => {
  let base = "";
  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "purgeplus-update-"));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function makeIndex(opts: { versions: Array<{ version: string; content: string; badHash?: boolean; channel?: string }>; artifactAt: string }) {
    const releases = [];
    for (const v of opts.versions) {
      const file = path.join(opts.artifactAt, `${v.version}.bin`);
      await mkdir(opts.artifactAt, { recursive: true });
      await writeFile(file, v.content, "utf8");
      releases.push({
        version: v.version,
        ...(v.channel ? { channel: v.channel } : {}),
        notes: `release ${v.version}`,
        artifacts: [
          {
            name: "payload.bin",
            source: file,
            sha256: v.badHash ? "0".repeat(64) : sha256(Buffer.from(v.content)),
            size: Buffer.byteLength(v.content),
          },
        ],
      });
    }
    const index: ReleaseIndex = { schema: "purgeplus.release-index/1", channel: "stable", releases };
    const file = path.join(base, `index-${Date.now().toString(36)}.json`);
    await writeFile(file, JSON.stringify(index, null, 2), "utf8");
    return { index, file };
  }

  const svc = (currentVersion: string, indexSource: string, dataSub: string) =>
    new UpdateService({
      dataDir: path.join(base, dataSub),
      currentVersion,
      logger: createLogger({ sink: () => {} }),
      indexSource,
    });

  it("checks and finds a newer version without touching anything", async () => {
    const { file } = await makeIndex({ versions: [{ version: "0.2.0", content: "new" }], artifactAt: path.join(base, "art1") });
    const service = svc("0.1.0", file, "d1");
    const check = await service.check();
    assert.equal(check.current, "0.1.0");
    assert.equal(check.latest, "0.2.0");
    assert.equal(check.hasUpdate, true);
    assert.deepEqual(check.versions, ["0.2.0"]);
    const status = await service.status();
    assert.equal(status.lastCheck?.latest, "0.2.0");
    assert.equal(status.activeVersion, undefined, "checking must not activate anything");
  });

  it("reports no update when current is already latest", async () => {
    const { file } = await makeIndex({ versions: [{ version: "0.1.0", content: "same" }], artifactAt: path.join(base, "art2") });
    const check = await svc("0.1.0", file, "d2").check();
    assert.equal(check.hasUpdate, false);
  });

  it("stages, verifies and activates, keeping the previous pointer", async () => {
    const { file } = await makeIndex({ versions: [{ version: "0.2.0", content: "payload-2" }], artifactAt: path.join(base, "art3") });
    const service = svc("0.1.0", file, "d3");
    const plan = await service.plan();
    assert.equal(plan.to, "0.2.0");
    assert.equal(plan.artifacts.length, 1);
    const staged = await service.stage(plan);
    assert.deepEqual(staged.verified, ["payload.bin"]);
    assert.equal(await readFile(path.join(staged.stagingDir, "payload.bin"), "utf8"), "payload-2");
    const activated = await service.activate(staged);
    assert.equal(activated.version, "0.2.0");
    const status = await service.status();
    assert.equal(status.activeVersion, "0.2.0");
    assert.ok(status.activeDir?.includes("0.2.0"));
    const manifest = JSON.parse(await readFile(path.join(activated.dir, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.verified, ["payload.bin"]);
  });

  it("fails on a sha256 mismatch and leaves no staging behind", async () => {
    const { file } = await makeIndex({ versions: [{ version: "0.3.0", content: "tampered", badHash: true }], artifactAt: path.join(base, "art4") });
    const service = svc("0.1.0", file, "d4");
    const plan = await service.plan();
    await assert.rejects(() => service.stage(plan), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "integrity_failed");
      return true;
    });
    const status = await service.status();
    assert.equal(status.activeVersion, undefined, "failed staging must not activate anything");
    const stagingRoot = path.join(service.dir, "staging");
    const leftovers = await readFile(path.join(base, "d4", "update", "state.json"), "utf8").then(() => []).catch(() => []);
    assert.deepEqual(leftovers, []);
    void stagingRoot;
  });

  it("rejects malformed indexes and unknown versions", async () => {
    const bad = path.join(base, "bad-index.json");
    await writeFile(bad, JSON.stringify({ schema: "wrong", releases: [] }), "utf8");
    await assert.rejects(() => svc("0.1.0", bad, "d5").check(), /invalid release index/);
    assert.throws(
      () => validateIndex({ schema: "purgeplus.release-index/1", channel: "stable", releases: [{ version: "1.0.0", artifacts: [{ name: "../x", source: "s", sha256: "zz" }] }] }, "test"),
      /invalid release index/,
    );
    const { file } = await makeIndex({ versions: [{ version: "0.2.0", content: "x" }], artifactAt: path.join(base, "art5") });
    await assert.rejects(() => svc("0.1.0", file, "d6").plan("9.9.9"), /version not in index/);
  });

  it("filters by channel", async () => {
    const { file } = await makeIndex({
      versions: [
        { version: "0.2.0", content: "stable", channel: "stable" },
        { version: "0.3.0", content: "beta", channel: "beta" },
      ],
      artifactAt: path.join(base, "art6"),
    });
    const stable = await svc("0.1.0", file, "d7").check();
    assert.equal(stable.latest, "0.2.0");
    const beta = new UpdateService({
      dataDir: path.join(base, "d8"),
      currentVersion: "0.1.0",
      logger: createLogger({ sink: () => {} }),
      indexSource: file,
      channel: "beta",
    });
    const betaCheck = await beta.check();
    assert.equal(betaCheck.latest, "0.3.0");
  });
});
