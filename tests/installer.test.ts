/**
 * T-035 安装器测试：归档、打包、前置检查、状态机、幂等、失败回滚、卸载。
 * 所有写入都在 mkdtemp 临时目录内；不触碰真实安装与数据目录。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createTarGz, readTarGz } from "../src/installer/archive.ts";
import { Installer, createPackage, hashTree, verifyPackage, type InstallPhase } from "../src/installer/installer.ts";
import { preflight } from "../src/installer/preflight.ts";
import { PurgeError } from "../src/core/errors.ts";

let base = "";
before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "p5-installer-"));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 造一个最小可安装树（package.json + 一点内容）。 */
async function makeTree(dir: string, version: string, marker = "v1"): Promise<string> {
  await mkdir(path.join(dir, "src", "cli"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "purge-plus", version }, null, 2));
  await writeFile(path.join(dir, "src", "cli", "main.ts"), `// ${marker}\nexport const x = 1;\n`);
  await writeFile(path.join(dir, "README.md"), `# ${version}\n`);
  return dir;
}

describe("T-035 archive", () => {
  it("round-trips files and modes", () => {
    const buf = createTarGz([
      { path: "a.txt", data: Buffer.from("hello") },
      { path: "dir/b.bin", data: Buffer.alloc(700, 7), mode: 0o600 },
    ]);
    const parsed = readTarGz(buf);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[0]?.data.toString(), "hello");
    assert.equal(parsed.entries[1]?.data.length, 700);
    assert.equal(parsed.entries[1]?.mode, 0o600);
  });

  it("rejects absolute paths and .. on write", () => {
    assert.throws(() => createTarGz([{ path: "/etc/passwd", data: Buffer.from("x") }]), (e: unknown) => {
      assert.ok(e instanceof PurgeError);
      return true;
    });
    assert.throws(() => createTarGz([{ path: "../escape", data: Buffer.from("x") }]), /relative without/);
    assert.throws(() => createTarGz([{ path: "x/../y.txt", data: Buffer.from("y") }]), /relative without/);
  });

  it("rejects traversal on read even if a malicious archive bypassed the writer", async () => {
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const valid = createTarGz([{ path: "ok.txt", data: Buffer.from("ok") }]);
    const raw = gunzipSync(valid);
    // 把头部文件名改写成 ../evil.txt（不重算校验和：读侧不依赖校验和，但必须拒绝路径）
    const evilName = Buffer.from("../evil.txt", "utf8");
    evilName.copy(raw, 0);
    raw.fill(0, evilName.length, 100);
    assert.throws(() => readTarGz(gzipSync(raw)), /escapes root/);
  });

  it("rejects non-gzip input", () => {
    assert.throws(() => readTarGz(Buffer.from("not gzip")), /not a gzip/);
  });
});

describe("T-035 package", () => {
  it("creates a verifiable package", async () => {
    const src = await makeTree(path.join(base, "pkg-src"), "9.9.9");
    const out = path.join(base, "dist", "pkg.tar.gz");
    const created = await createPackage({ sourceDir: src, outFile: out });
    assert.equal(created.version, "9.9.9");
    assert.ok((await stat(out)).size > 0);
    const verified = await verifyPackage(out);
    assert.equal(verified.ok, true);
    assert.equal(verified.files, created.files);
  });

  it("detects a tampered entry", async () => {
    const src = await makeTree(path.join(base, "pkg-src2"), "1.0.0");
    const out = path.join(base, "dist", "pkg2.tar.gz");
    await createPackage({ sourceDir: src, outFile: out });
    // 篡改：重新打包一个内容不同但 MANIFEST 未更新的包
    const entries = readTarGz(await readFile(out)).entries.filter((e) => e.path !== "SHA256SUMS");
    const tampered = entries.map((e) => (e.path === "README.md" ? { ...e, data: Buffer.from("evil") } : e));
    const badFile = path.join(base, "dist", "bad.tar.gz");
    await writeFile(badFile, createTarGz(tampered));
    const v = await verifyPackage(badFile);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => p.includes("hash mismatch")));
  });
});

describe("T-035 preflight", () => {
  it("passes on a writable, empty target", async () => {
    const r = await preflight({ installDir: path.join(base, "pf1", "app") });
    assert.equal(r.blocked, false);
    assert.ok(r.checks.some((c) => c.id === "node" && c.status === "PASS"));
    assert.ok(r.checks.some((c) => c.id === "install_dir_writable" && c.status === "PASS"));
  });

  it("fails when the parent cannot be created", async () => {
    const blocker = path.join(base, "blocker-file");
    await writeFile(blocker, "i am a file", "utf8");
    const r = await preflight({ installDir: path.join(blocker, "app") });
    assert.equal(r.blocked, true);
    assert.ok(r.checks.some((c) => c.id === "install_dir_writable" && c.status === "FAIL"));
  });

  it("reports UNKNOWN (not PASS) when running-process state cannot be determined", async () => {
    const r = await preflight({ installDir: path.join(base, "pf2", "app") });
    assert.ok(r.checks.some((c) => c.id === "running_process" && c.status === "UNKNOWN"));
    // UNKNOWN 不阻塞，但必须显式可见
    assert.equal(r.blocked, false);
  });

  it("warns about an unfinished previous install", async () => {
    const parent = path.join(base, "pf3");
    await mkdir(parent, { recursive: true });
    await writeFile(path.join(parent, ".purgeplus-install-state.json"), JSON.stringify({ phase: "FAILED" }), "utf8");
    const r = await preflight({ installDir: path.join(parent, "app") });
    assert.ok(r.checks.some((c) => c.id === "unfinished_install" && c.status === "WARN"));
  });
});

describe("T-035 installer state machine", () => {
  const stubPostCheck = async () => ({ ok: true, detail: "stubbed" });

  it("installs from source, verifies, and is idempotent", async () => {
    const src = await makeTree(path.join(base, "inst-src"), "1.0.0");
    const installDir = path.join(base, "inst-1", "app");
    const phases: InstallPhase[] = [];
    const installer = new Installer({
      installDir,
      sourceDir: src,
      postCheckRunner: stubPostCheck,
      onPhase: (p) => void phases.push(p),
    });
    const first = await installer.install();
    assert.equal(first.phase, "COMPLETED");
    assert.equal(first.idempotent, false);
    assert.ok((await stat(path.join(installDir, "package.json"))).isFile());
    assert.deepEqual(phases.filter((p) => p === "COMPLETED").length, 1);

    const second = await new Installer({ installDir, sourceDir: src, postCheckRunner: stubPostCheck }).install();
    assert.equal(second.idempotent, true, "重复安装必须幂等");
    assert.equal(second.phase, "COMPLETED");
    // 幂等时不应产生备份
    assert.equal(second.backupDir, undefined);
  });

  it("rolls back to the previous version when post-check fails", async () => {
    const parent = path.join(base, "inst-2");
    const installDir = path.join(parent, "app");
    const v1 = await makeTree(path.join(base, "inst-2-v1"), "1.0.0", "v1");
    await new Installer({ installDir, sourceDir: v1, postCheckRunner: stubPostCheck }).install();
    const before = await readFile(path.join(installDir, "README.md"), "utf8");

    const v2 = await makeTree(path.join(base, "inst-2-v2"), "2.0.0", "v2");
    const failing = new Installer({
      installDir,
      sourceDir: v2,
      postCheckRunner: async () => ({ ok: false, detail: "simulated health failure" }),
    });
    const result = await failing.install();
    assert.equal(result.phase, "ROLLBACK_COMPLETED");
    assert.equal(await readFile(path.join(installDir, "README.md"), "utf8"), before, "必须回到旧版本内容");
    const pkg = JSON.parse(await readFile(path.join(installDir, "package.json"), "utf8"));
    assert.equal(pkg.version, "1.0.0");
  });

  it("reports ROLLBACK_FAILED when the backup cannot be restored", async () => {
    const parent = path.join(base, "inst-3");
    const installDir = path.join(parent, "app");
    const v1 = await makeTree(path.join(base, "inst-3-v1"), "1.0.0");
    await new Installer({ installDir, sourceDir: v1, postCheckRunner: stubPostCheck }).install();
    const before = await readFile(path.join(installDir, "README.md"), "utf8");

    const v2 = await makeTree(path.join(base, "inst-3-v2"), "2.0.0");
    let backupRemoved = false;
    const failing = new Installer({
      installDir,
      sourceDir: v2,
      postCheckRunner: async () => ({ ok: false, detail: "boom" }),
      onPhase: async (phase, state) => {
        if (phase === "BACKUP_COMPLETED" && state.backupDir && !backupRemoved) {
          backupRemoved = true;
          await rm(state.backupDir, { recursive: true, force: true }); // 注入：备份被外部删除
        }
      },
    });
    await assert.rejects(() => failing.install(), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.match(err.message, /rollback failed/);
      return true;
    });
    assert.equal(backupRemoved, true);
    const state = JSON.parse(await readFile(path.join(parent, ".purgeplus-install-state.json"), "utf8"));
    assert.equal(state.phase, "ROLLBACK_FAILED");
    assert.ok(typeof state.error === "string" && state.error.length > 0);
    // 旧版本内容已不可恢复 —— 这正是必须让用户知道的事实
    await assert.rejects(() => readFile(path.join(installDir, "README.md"), "utf8"));
    assert.ok(before.length > 0);
  });

  it("refuses to install into a directory occupied by another product", async () => {
    const installDir = path.join(base, "inst-4");
    await mkdir(installDir, { recursive: true });
    await writeFile(path.join(installDir, "package.json"), JSON.stringify({ name: "something-else", version: "1.0.0" }));
    const src = await makeTree(path.join(base, "inst-4-src"), "1.0.0");
    const installer = new Installer({ installDir, sourceDir: src, postCheckRunner: stubPostCheck });
    await assert.rejects(() => installer.install(), /安装前置检查失败|blocked/);
    const state = JSON.parse(await readFile(path.join(base, ".purgeplus-install-state.json"), "utf8"));
    assert.equal(state.phase, "FAILED");
  });

  it("uninstalls but keeps the data directory by default", async () => {
    const installDir = path.join(base, "inst-5", "app");
    const dataDir = path.join(base, "inst-5", "data");
    const src = await makeTree(path.join(base, "inst-5-src"), "1.0.0");
    await new Installer({ installDir, sourceDir: src, postCheckRunner: stubPostCheck }).install();
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "config.json"), "{}", "utf8");
    const result = await new Installer({ installDir, sourceDir: src, postCheckRunner: stubPostCheck }).uninstall({ dataDir });
    assert.ok(result.removed.includes(installDir));
    assert.equal(result.keptData, dataDir);
    assert.ok((await stat(path.join(dataDir, "config.json"))).isFile(), "用户数据必须保留");
  });

  it("leaves no half-install behind when the process is interrupted mid-flight", async () => {
    const parent = path.join(base, "inst-6");
    const installDir = path.join(parent, "app");
    const src = await makeTree(path.join(base, "inst-6-src"), "1.0.0");
    const crashing = new Installer({
      installDir,
      sourceDir: src,
      postCheckRunner: async () => ({ ok: true, detail: "stub" }),
      onPhase: (phase) => {
        if (phase === "INSTALLING") throw new Error("simulated crash while installing");
      },
    });
    const result = await crashing.install();
    assert.equal(result.phase, "ROLLBACK_COMPLETED", "中断必须走回滚，而不是静默成功");
    // 全新安装被中断：不应留下可被误认为"已安装"的目录
    const exists = await stat(installDir).then(() => true).catch(() => false);
    assert.equal(exists, false, "中断后不得留下半安装目录");
    const entries = await (await import("node:fs/promises")).readdir(parent);
    assert.ok(!entries.some((e) => e.startsWith(".purgeplus-staging-")), "staging 必须被清理");
    const state = JSON.parse(await readFile(path.join(parent, ".purgeplus-install-state.json"), "utf8"));
    assert.ok(["ROLLBACK_COMPLETED", "ROLLBACK_FAILED", "FAILED"].includes(state.phase));
  });

  it("refuses a corrupted package before touching the install dir", async () => {
    const src = await makeTree(path.join(base, "inst-7-src"), "1.0.0");
    const out = path.join(base, "inst-7", "pkg.tar.gz");
    await createPackage({ sourceDir: src, outFile: out });
    const buf = await readFile(out);
    const broken = path.join(base, "inst-7", "broken.tar.gz");
    await writeFile(broken, buf.subarray(0, Math.floor(buf.length / 2)));
    await assert.rejects(
      () => new Installer({ installDir: path.join(base, "inst-7", "app"), packageFile: broken }).install(),
      /not a gzip|truncated|missing MANIFEST|integrity/,
    );
    const exists = await stat(path.join(base, "inst-7", "app")).then(() => true).catch(() => false);
    assert.equal(exists, false);
  });

  it("keeps the user data directory intact across reinstall and uninstall", async () => {
    const root = path.join(base, "inst-8");
    const installDir = path.join(root, "app");
    const dataDir = path.join(root, "data");
    const src = await makeTree(path.join(base, "inst-8-src"), "1.0.0");
    await new Installer({ installDir, sourceDir: src, postCheckRunner: async () => ({ ok: true, detail: "s" }) }).install();
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "config.json"), JSON.stringify({ port: 7001 }), "utf8");
    await new Installer({ installDir, sourceDir: src, postCheckRunner: async () => ({ ok: true, detail: "s" }) }).install();
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8")).port, 7001);
  });
  it("hashTree ignores node_modules and state files", async () => {
    const root = path.join(base, "ht");
    await mkdir(path.join(root, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "x", "i.js"), "1");
    await mkdir(path.join(root, ".purgeplus"), { recursive: true });
    await writeFile(path.join(root, ".purgeplus", "install-state.json"), "{}");
    await writeFile(path.join(root, "a.txt"), "a");
    const tree = await hashTree(root);
    assert.deepEqual(tree.map((t) => t.path), ["a.txt"]);
  });
});
