// 生成演示用 release index（离线可跑）：读取 examples/release-artifact.bin 并计算 sha256。
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const payload = "purgeplus-demo-payload-v0.2.0";
const artifact = path.resolve("examples/release-artifact.bin");
await fsp.writeFile(artifact, payload, "utf8");
const buf = await fsp.readFile(artifact);
const sha256 = createHash("sha256").update(buf).digest("hex");

const index = {
  schema: "purgeplus.release-index/1",
  channel: "stable",
  releases: [
    {
      version: "0.2.0",
      notes: "演示版本：仅用于验证 check/plan/stage/activate 流程",
      artifacts: [{ name: "payload.bin", source: artifact.split(path.sep).join("/"), sha256, size: buf.length }],
    },
  ],
};
await fsp.writeFile(path.resolve("examples/release-index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ artifact, sha256, size: buf.length }));
