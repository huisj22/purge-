#!/usr/bin/env node
/**
 * 打包脚本（T-035）：生成 .tar.gz + MANIFEST + SHA256SUMS，并做自校验。
 * 用法：node scripts/package.mjs [--out dist/purge-plus-<version>.tar.gz]
 */
import * as path from "node:path";
import { createPackage, verifyPackage } from "../src/installer/installer.ts";

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : undefined;

const sourceDir = path.resolve(process.cwd());
const target = path.resolve(outFile ?? path.join("dist", `purge-plus-${await versionOf()}.tar.gz`));

const created = await createPackage({ sourceDir, outFile: target });
const verified = await verifyPackage(target);

process.stdout.write(
  [
    `包：${created.outFile}`,
    `版本：${created.version}`,
    `文件数：${created.files}`,
    `大小：${(created.bytes / 1024).toFixed(1)} KB`,
    `SHA256：${created.sha256}`,
    `自校验：${verified.ok ? "通过" : `失败 ${verified.problems.join("; ")}`}`,
  ].join("\n") + "\n",
);
process.exit(verified.ok ? 0 : 1);

async function versionOf() {
  const fsp = await import("node:fs/promises");
  const raw = await fsp.readFile(path.join(sourceDir, "package.json"), "utf8");
  return JSON.parse(raw).version;
}
