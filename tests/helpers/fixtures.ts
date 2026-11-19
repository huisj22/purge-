/**
 * 测试夹具：构造最小合法 ASAR 与假宿主目录。
 * 注意：生产代码里 ASAR 是只读的，这里只是为了造出可验证的输入。
 */
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

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

export interface FakeHostOptions {
  /** 是否保留归档。 */
  archive?: boolean;
  /** 是否解包出 app/ 目录。 */
  unpacked?: boolean;
  version?: string;
  product?: string;
  /** 写入 [dsh-purge] 标记的文件数。 */
  markerFiles?: number;
  /** 写一个 legacy dsh-purge applied.json。 */
  legacyApplied?: { version: string; at: string };
  /** profile 的 dependencies / bundles。 */
  profile?: { name: string; dependencies: Record<string, string>; bundles: string[] };
}

export async function makeFakeHost(base: string, opts: FakeHostOptions = {}): Promise<{ resources: string; home: string }> {
  const resources = path.join(base, "resources");
  const home = path.join(base, "home");
  await mkdir(resources, { recursive: true });
  await mkdir(home, { recursive: true });
  const product = opts.product ?? "@deepseek-ai/dsh-desktop";
  const version = opts.version ?? "0.2.2-rc.1";
  const pkg = JSON.stringify({ name: product, version, main: "lib/main.js", dshBuildCommit: "deadbeef" });
  if (opts.archive !== false) {
    await writeAsar(path.join(resources, "app.asar"), {
      "package.json": Buffer.from(pkg, "utf8"),
      "lib/main.js": Buffer.from("// entry\n", "utf8"),
    });
  }
  if (opts.unpacked !== false) {
    const app = path.join(resources, "app");
    await mkdir(path.join(app, "lib"), { recursive: true });
    await writeFile(path.join(app, "package.json"), pkg);
    await writeFile(path.join(app, "lib", "main.js"), "// entry\n");
    const markers = opts.markerFiles ?? 0;
    for (let i = 0; i < markers; i += 1) {
      const dir = path.join(app, "node_modules", "@deepseek-ai", `pkg-${i}`, "lib");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "index.js"), `// [dsh-purge] patched ${i}\nexport const x = ${i};\n`);
    }
  }
  if (opts.legacyApplied) {
    const dir = path.join(home, "dsh-purge");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "applied.json"), JSON.stringify(opts.legacyApplied));
  }
  const profile = opts.profile ?? { name: "desktop", dependencies: {}, bundles: [] };
  const profileDir = path.join(home, "profiles", profile.name);
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    path.join(profileDir, "package.json"),
    JSON.stringify({ dependencies: profile.dependencies, dsh: { profile: { bundles: profile.bundles } } }),
  );
  return { resources, home };
}
