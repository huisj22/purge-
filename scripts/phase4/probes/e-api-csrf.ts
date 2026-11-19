/**
 * Phase 4 探针 E：API 是否存在跨站"简单请求"写入通道（无 CSRF/Origin 校验）。
 * 只启动本机临时端口，写入目标是临时数据目录里的 config.json，不触碰真实宿主。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DshHostAdapter } from "../../../src/adapters/dsh.ts";
import { createApiServer } from "../../../src/api/server.ts";
import { PurgeApp } from "../../../src/app.ts";

const dir = await mkdtemp(path.join(tmpdir(), "p4-probe-csrf-"));
const app = new PurgeApp({
  dataDir: path.join(dir, "data"),
  startScheduler: false,
  skipProcessProbe: true,
  adapters: [new DshHostAdapter({ includeDefaults: false, extraRoots: [], dshHome: path.join(dir, "home"), skipProcessProbe: true })],
});
const handle = createApiServer({ app, host: "127.0.0.1", port: 0 });
try {
  const base = await handle.listen();
  const before = app.services.config.get().port;
  // 模拟恶意页面：text/plain 属于 CORS 简单请求，不触发预检；服务端不校验 content-type
  const res = await fetch(`${base}/api/config`, {
    method: "POST",
    headers: { "content-type": "text/plain", origin: "https://evil.example" },
    body: JSON.stringify({ patch: { port: before + 1 }, confirm: true }),
  });
  const body = (await res.json()) as { ok: boolean };
  const after = app.services.config.get().port;
  console.log(
    JSON.stringify(
      {
        status: res.status,
        ok: body.ok,
        portBefore: before,
        portAfter: after,
        originSent: "https://evil.example",
        contentType: "text/plain",
        expectation: "非 JSON content-type 或跨源 Origin 的写入应被拒绝（415/403）",
      },
      null,
      2,
    ),
  );
  console.log(`\nPROBE_RESULT=${body.ok && after !== before ? "CSRF_WRITE_ACCEPTED" : "blocked"}`);
} finally {
  await handle.close();
  await rm(dir, { recursive: true, force: true });
}
