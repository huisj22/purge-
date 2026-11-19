/**
 * Phase 4 探针 D：SnapshotStore.restore 是否具备事务性（部分失败会留下什么状态）。
 * 只用临时目录。
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SnapshotStore } from "../../../src/recovery/snapshot.ts";
import { openMemoryDatabase } from "../../../src/storage/database.ts";

const dir = await mkdtemp(path.join(tmpdir(), "p4-probe-restore-"));
const db = openMemoryDatabase();
try {
  const store = new SnapshotStore(path.join(dir, "data"), db);
  const a = path.join(dir, "a.txt");
  const bDir = path.join(dir, "b-dir");
  const b = path.join(bDir, "b.txt");
  await mkdir(bDir, { recursive: true });
  await writeFile(a, "A0", "utf8");
  await writeFile(b, "B0", "utf8");

  const snap = await store.capture("probe", [a, b]);
  await writeFile(a, "A1", "utf8");
  await writeFile(b, "B1", "utf8");

  // 破坏第二个文件的恢复路径：把它的父目录换成同名普通文件
  await rm(bDir, { recursive: true, force: true });
  await writeFile(bDir, "i-am-a-file-now", "utf8");

  const result = await store.restore(snap.snapId);
  const aAfter = await readFile(a, "utf8");
  const bParentIsFile = await stat(bDir).then((s) => s.isFile()).catch(() => false);

  console.log(
    JSON.stringify(
      {
        restored: result.restored.map((p) => path.basename(p)),
        failed: result.failed.map((f) => ({ file: path.basename(f.path), error: f.error })),
        aAfter,
        bParentIsFile,
        rolledBack: (result as { rolledBack?: boolean }).rolledBack,
        expectation: "恢复失败时要么整体回滚，要么明确告知哪些已改、哪些没改；当前实现只做逐文件尽力而为",
      },
      null,
      2,
    ),
  );
  const rolledBack = (result as { rolledBack?: boolean }).rolledBack === true;
  const partial = result.failed.length > 0 && result.restored.length > 0 && !rolledBack;
  console.log(`\nPROBE_RESULT=${partial ? "PARTIAL_RESTORE_CONFIRMED" : rolledBack ? "ROLLED_BACK" : "atomic-or-none"}`);
} finally {
  db.close();
  await rm(dir, { recursive: true, force: true });
}
