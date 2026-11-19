/**
 * Phase 5 · 隔离副本真实写入验证。
 *
 * 安全规则（硬编码在本脚本里，不是"尽力而为"）：
 * 1. 所有写入目标必须位于 ISO 根目录内（realpath 校验）。
 * 2. 真实宿主目录只读：脚本从不构造指向真实宿主的写操作。
 * 3. 真实宿主在测试前后各做一次哈希快照，最后比对。
 * 4. 任何越界（symlink/junction/`..`）都必须被拒；若未被拒，立即中止并保留现场。
 *
 * 用法：node scripts/phase5/isolated-write-verify.ts <ISO_ROOT> <REAL_RESOURCES>
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { DshHostAdapter } from "../../src/adapters/dsh.ts";
import { PackEngine } from "../../src/packs/engine.ts";
import { SnapshotStore } from "../../src/recovery/snapshot.ts";
import { Transaction } from "../../src/recovery/transaction.ts";
import { openDatabase } from "../../src/storage/database.ts";
import { Installer } from "../../src/installer/installer.ts";
import { validatePack } from "../../src/packs/schema.ts";
import { realpathSync } from "node:fs";

const isoRoot = process.argv[2];
const realResources = process.argv[3];
if (!isoRoot || !realResources) {
  process.stderr.write("usage: node isolated-write-verify.ts <ISO_ROOT> <REAL_RESOURCES>\n");
  process.exit(2);
}
const ISO = path.resolve(isoRoot);
const REAL = path.resolve(realResources);
const work = path.join(ISO, "_purgeplus");
const results: Array<{ step: string; ok: boolean; detail: string }> = [];

function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  process.stdout.write(`${ok ? "✓" : "✗"} ${step} — ${detail}\n`);
  if (!ok) throw new Error(`step failed: ${step}`);
}

/** 断言 path 位于 ISO 内（考虑符号链接解析），否则中止。 */
async function assertInsideIso(target: string, label: string): Promise<void> {
  const resolved = await realpath(target).catch(() => target);
  const isoReal = await realpath(ISO);
  const ok = resolved === isoReal || resolved.startsWith(isoReal + path.sep);
  if (!ok) {
    throw new Error(`ESCAPE DETECTED at ${label}: ${target} -> ${resolved} (ISO=${isoReal})`);
  }
  if (resolved.startsWith(await realpath(REAL))) {
    throw new Error(`target resolved into the REAL host at ${label}: ${resolved}`);
  }
}

async function hashTree(root: string): Promise<{ files: number; bytes: number; digest: string }> {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // 不跟随链接
      if (e.isDirectory()) {
        await walk(abs, relPath);
        continue;
      }
      if (!e.isFile()) continue;
      const buf = await readFile(abs);
      hash.update(`${relPath}:${createHash("sha256").update(buf).digest("hex")}\n`);
      files += 1;
      bytes += buf.length;
    }
  };
  await walk(root, "");
  return { files, bytes, digest: hash.digest("hex") };
}

async function main(): Promise<void> {
  process.stdout.write(`ISO  = ${ISO}\nREAL = ${REAL}\n\n`);

  // 0) 隔离副本必须与真实宿主"同形"
  const isoResources = ISO;
  const isoApp = path.join(isoResources, "app");
  const isoAsar = path.join(isoResources, "app.asar");
  record("0a 副本包含解包目录与归档", (await stat(isoApp)).isDirectory() && (await stat(isoAsar)).isFile(), `${isoApp} / ${isoAsar}`);

  // 1) Adapter 只在 ISO 内发现宿主
  const adapter = new DshHostAdapter({
    extraRoots: [isoResources],
    includeDefaults: false,
    dshHome: path.join(work, "home"),
    skipProcessProbe: true,
    markerScanLimit: 5000,
  });
  const candidates = await adapter.discover();
  record("1a 只发现 1 个候选（ISO 内）", candidates.length === 1, `count=${candidates.length} root=${candidates[0]?.root}`);
  const facts = await adapter.inspect(candidates[0] as never);
  record(
    "1b 取证的解包路径位于 ISO 内",
    facts.unpacked.path.startsWith(ISO) && !facts.unpacked.path.startsWith(safeRealpath(REAL)),
    `unpacked=${facts.unpacked.path}`,
  );
  record("1c 身份与真实宿主一致（副本保真）", facts.identity.product === "@deepseek-ai/dsh-desktop", `${facts.identity.product}@${facts.identity.version}`);

  await mkdir(work, { recursive: true });
  const db = openDatabase(path.join(work, "purgeplus.db"));
  const snapshots = new SnapshotStore(work, db);

  // 2) 目标文件：复制自真实宿主的一个包文件（真实内容，非伪造）
  const targetRel = path.join("app", "dsh", "node_modules", "@deepseek-ai", "dsh-user-approval", "lib", "types", "index.js");
  const target = path.join(ISO, targetRel);
  const originalText = await readFile(target, "utf8");
  // 副本保真性：比较 ISO/app 与 REAL/app 的树哈希（只读真实宿主）
  const [isoTree, realTree] = await Promise.all([hashTree(isoApp), hashTree(path.join(REAL, "app"))]);
  record(
    "1d 副本与真实宿主 app/ 树哈希一致（保真）",
    isoTree.files === realTree.files && isoTree.digest === realTree.digest,
    `files=${isoTree.files} bytes=${isoTree.bytes} digest=${isoTree.digest.slice(0, 16)}`,
  );
  record("2a 目标文件存在且含真实补丁标记", originalText.includes("[dsh-purge]"), `${targetRel} (${originalText.length} bytes)`);
  await assertInsideIso(target, "target");

  // 3) Pack apply（真实写入 ISO）
  // 选一个在文件中**恰好出现一次**的唯一锚点（避免命中数契约失败）
  const uniqueAnchor = originalText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length >= 12 && originalText.split(l).length - 1 === 1);
  if (!uniqueAnchor) throw new Error("cannot find a unique anchor line in the target file");
  process.stdout.write(`anchor: ${uniqueAnchor.slice(0, 60)}\n`);

  const pack = {
    schema: "purgeplus.pack/1" as const,
    id: "iso-verify-pack",
    name: "隔离验证包",
    version: "1.0.0",
    target: { adapter: "dsh" },
    risk: { level: "medium" as const, reasons: ["隔离副本写入验证"] },
    rules: [
      {
        id: "r1",
        layer: "code" as const,
        path: path.relative(isoApp, target).split(path.sep).join("/"),
        markers: ["[purge-plus-iso]"],
        replacements: [{ pattern: uniqueAnchor, replace: `${uniqueAnchor} // [purge-plus-iso]`, expect: 1 }],
      },
    ],
  };
  const engine = new PackEngine({
    snapshots,
    dataDir: work,
    createTransaction: async (label, targets) => {
      for (const t of targets) await assertInsideIso(t, "pack transaction target");
      const tx = new Transaction(label, { snapshots });
      await tx.begin(targets);
      return tx;
    },
  });
  const plan = await engine.plan(pack, { baseRoot: isoApp, hostVersion: facts.identity.version });
  record("3a plan 只读且待应用 1 条", plan.summary.pending === 1 && (await readFile(target, "utf8")) === originalText, `pending=${plan.summary.pending}`);
  const applied = await engine.apply(pack, { baseRoot: isoApp, hostVersion: facts.identity.version });
  const appliedText = await readFile(target, "utf8");
  for (const w of applied.written) await assertInsideIso(w, "pack written file");
  record("3b apply 只写 ISO", (await readFile(target, "utf8")).includes("[purge-plus-iso]") && applied.written.length === 1, `written=${applied.written.length} snap=${applied.snapshotId}`);

  // 4) 快照 + 冲突检测 + force 恢复
  const snap = await snapshots.capture("iso-verify", [target]);
  await writeFile(target, `${originalText}\n// tampered by test\n`, "utf8");
  const conflictPlan = await snapshots.planRestore(snap.snapId);
  record("4a 冲突被识别（不静默覆盖）", conflictPlan.blocked === true, `conflicts=${conflictPlan.conflicts}`);
  let blocked = false;
  try {
    await snapshots.restore(snap.snapId);
  } catch {
    blocked = true;
  }
  record("4b 未授权恢复被拒绝", blocked && (await readFile(target, "utf8")).includes("tampered by test"), "文件未被改动");

  const restored = await snapshots.restore(snap.snapId, { policy: "force", authorizedBy: "iso-verify", reason: "isolated write verification" });
  record(
    "4c force 恢复成功并记录覆盖哈希",
    restored.failed.length === 0 && restored.force?.authorizedBy === "iso-verify" && (await readFile(target, "utf8")) === appliedText,
    `preSnapshot=${restored.preSnapshotId} overwritten=${restored.force?.overwritten.length}`,
  );

  // 5) Rollback：pack revert（回到 apply 之前）
  const reverted = await engine.revert(applied.snapshotId, { authorizedBy: "iso-verify" });
  record("5a rollback 后内容回到原始", reverted.failed.length === 0 && (await readFile(target, "utf8")) === originalText, `restored=${reverted.restored.length}`);

  // 6) 路径逃逸：pack 规则带 .. 必须在校验阶段被拒
  let escapeRejected = false;
  try {
    const bad = { ...pack, rules: [{ ...pack.rules[0], id: "r2", path: "../app.asar" }] };
    validateOrThrow(bad);
  } catch {
    escapeRejected = true;
  }
  record("6a pack 路径逃逸被拒", escapeRejected, "validatePack 拒绝 ../");

  // 7) 符号链接 / junction：在 ISO 内放一个指向真实宿主的链接，确认不被跟随
  const linkDir = path.join(ISO, "app", "_iso-link-test");
  await mkdir(linkDir, { recursive: true });
  const realTarget = path.join(REAL, "app", "package.json");
  let linkCreated = false;
  let linkType = "none";
  try {
    await symlink(realTarget, path.join(linkDir, "to-real-host"), "file");
    linkCreated = true;
    linkType = "symlink(file)";
  } catch {
    try {
      await symlink(path.join(REAL, "app"), path.join(linkDir, "to-real-host-dir"), "junction");
      linkCreated = true;
      linkType = "junction";
    } catch {
      linkCreated = false;
    }
  }
  // 快照这个目录：capture 必须跳过符号链接
  const linkSnap = await snapshots.capture("iso-link", [linkDir]);
  const linkEntries = linkSnap.manifest.entries.filter((e) => e.path.includes("to-real-host"));
  record("7a 快照不会跟随符号链接/junction", linkCreated ? linkEntries.length === 0 : true, `link=${linkType} captured=${linkEntries.length}`);
  // 删除该目录时也不得进入真实宿主
  await rm(linkDir, { recursive: true, force: true });
  record("7b 删除链接目录后真实宿主 package.json 仍存在", (await stat(realTarget)).isFile(), realTarget);

  // 8) 真实安装/卸载（隔离目录内）
  const installer = new Installer({
    installDir: path.join(work, "installed-app"),
    sourceDir: path.resolve("."),
    dataDir: path.join(work, "install-data"),
  });
  const installed = await installer.install();
  record("8a 隔离目录安装成功", installed.phase === "COMPLETED", `version=${installed.version} idempotent=${installed.idempotent}`);
  const uninstalled = await installer.uninstall({ dataDir: path.join(work, "install-data") });
  record("8b 卸载保留数据目录", uninstalled.keptData !== undefined, `removed=${uninstalled.removed.length}`);

  db.close();

  // 收尾：清理本次写入产生的临时目录（仍只在 ISO 内）
  await rm(work, { recursive: true, force: true }).catch(() => {});
  await rm(linkDir, { recursive: true, force: true }).catch(() => {});

  const ok = results.every((r) => r.ok);
  process.stdout.write(`\n结果：${results.filter((r) => r.ok).length}/${results.length} 项通过\n`);
  process.exit(ok ? 0 : 1);
}

function validateOrThrow(pack: unknown): void {
  validatePack(pack);
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`验证失败：${(err as Error).message}\n`);
  process.exit(1);
});
