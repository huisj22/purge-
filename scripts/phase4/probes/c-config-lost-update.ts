/**
 * Phase 4 探针 C：ConfigCenter 并发提交是否会发生 Lost Update。
 * 只用临时目录里的文件。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ConfigCenter } from "../../../src/configcenter/managed.ts";

const dir = await mkdtemp(path.join(tmpdir(), "p4-probe-cfg-"));
try {
  const file = path.join(dir, "target.json");
  await writeFile(file, '{"v":0}\n', "utf8");
  const center = new ConfigCenter(path.join(dir, "data"));

  // 两个"客户端"读到同一个 hash，然后各自提交不同内容
  const read = await center.read(file);
  const results = await Promise.allSettled([
    center.commit(file, '{"v":"A"}\n', { expectHash: read.hash, actor: "client-A" }),
    center.commit(file, '{"v":"B"}\n', { expectHash: read.hash, actor: "client-B" }),
  ]);
  const finalContent = await readFile(file, "utf8");
  const fulfilled = results.filter((r) => r.status === "fulfilled").length;
  const rejected = results.filter((r) => r.status === "rejected").length;
  const history = await center.history(file);

  console.log(
    JSON.stringify(
      {
        bothClientsReadSameHash: true,
        fulfilled,
        rejected,
        rejectedReasons: results.filter((r) => r.status === "rejected").map((r) => ({ code: (r as PromiseRejectedResult).reason?.code ?? "?", message: (r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason) })),
        finalContent,
        historyEntries: history.length,
        expectedBehaviour: "同一 expectHash 只允许一次提交成功，第二次必须 conflict",
      },
      null,
      2,
    ),
  );
  const lostUpdate = fulfilled > 1;
  console.log(`\nPROBE_RESULT=${lostUpdate ? "LOST_UPDATE_CONFIRMED" : "guarded"}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
