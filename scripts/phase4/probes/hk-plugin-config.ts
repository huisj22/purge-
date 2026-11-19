/**
 * Phase 4 探针 H：插件能力白名单是否等于安全沙箱（它能否绕过 ctx.use 直接访问 fs）。
 * 探针 K：ConfigStore 在磁盘写入失败时，内存态是否已经改变（内存/磁盘不一致）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ConfigStore } from "../../../src/core/config.ts";
import { createLogger } from "../../../src/core/logger.ts";
import { PLUGIN_API_VERSION, PluginHost } from "../../../src/plugins/host.ts";

// ---------- H ----------
{
  const dir = await mkdtemp(path.join(tmpdir(), "p4-probe-plugin-"));
  try {
    const pluginDir = path.join(dir, "evil-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "evil-plugin", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, entry: "index.mjs", privilege: "host", capabilities: [] }),
    );
    const escapeFile = path.join(dir, "escaped.txt");
    await writeFile(
      path.join(pluginDir, "index.mjs"),
      [
        'import * as fs from "node:fs";',
        "let wrote = false;",
        `export function activate() { fs.writeFileSync(${JSON.stringify(escapeFile)}, "plugin bypassed capability system"); wrote = true; }`,
        "export function health() { return { ok: wrote, detail: 'wrote file without any capability' }; }",
      ].join("\n"),
    );
    const host = new PluginHost({ dataDir: path.join(dir, "data"), logger: createLogger({ sink: () => {} }), resolveService: () => ({}) });
    await host.install(pluginDir);
    await host.enable("evil-plugin", { trusted: true }); // host 特权必须显式信任，但信任后仍无沙箱
    const health = await host.health("evil-plugin");
    const escaped = await readFile(escapeFile, "utf8").catch(() => "");
    console.log(
      JSON.stringify(
        {
          probe: "H-plugin-boundary",
          pluginCapabilitiesDeclared: [],
          pluginWroteOutsideDataDir: escaped.length > 0,
          fileContent: escaped,
          health,
          conclusion: "capability 白名单只约束 ctx.use()，不是进程级沙箱；插件代码拥有与宿主相同的 Node 权限",
        },
        null,
        2,
      ),
    );
    console.log(`H_RESULT=${escaped.length > 0 ? "NOT_A_SANDBOX_CONFIRMED" : "isolated"}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- K ----------
{
  const dir = await mkdtemp(path.join(tmpdir(), "p4-probe-cfgstore-"));
  try {
    const store = new ConfigStore(path.join(dir, "data"));
    await store.load();
    // 让 config.json 写入必然失败：把它变成一个目录
    await mkdir(path.join(dir, "data", "config.json"), { recursive: true });
    let errorCode = "";
    try {
      await store.update({ port: 7999 });
    } catch (err) {
      errorCode = (err as { code?: string }).code ?? String(err);
    }
    const inMemory = store.get().port;
    const onDisk = await readFile(path.join(dir, "data", "config.json"), "utf8").catch(() => "<not a file>");
    console.log(
      JSON.stringify(
        {
          probe: "K-config-write-failure",
          errorCode,
          inMemoryPortAfterFailure: inMemory,
          diskReadable: onDisk !== "<not a file>",
          historyEntries: (await store.history()).length,
          expectation: "写入失败时内存态必须回滚，否则后续请求会按未落盘的配置运行",
        },
        null,
        2,
      ),
    );
    console.log(`K_RESULT=${inMemory === 7999 ? "MEMORY_DIVERGED_CONFIRMED" : "consistent"}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
