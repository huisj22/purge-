#!/usr/bin/env node
/**
 * purgeplus CLI。
 *
 * 设计约束：
 * - 默认人可读输出；--json 给机器用。
 * - 退出码：0 成功 / 1 失败 / 2 用法错误 / 3 策略拒绝。
 * - 危险动作必须带 --yes（策略层同样会拦）。
 */
import * as path from "node:path";
import { createApiServer } from "../api/server.ts";
import { formatPlan } from "../packs/engine.ts";
import { APP_VERSION, PurgeApp, resolveDataDir } from "../app.ts";
import { asPurgeError, PurgeError } from "../core/errors.ts";

const EXIT = { ok: 0, failed: 1, usage: 2, denied: 3 } as const;

interface GlobalFlags {
  json: boolean;
  yes: boolean;
  dataDir?: string;
  args: string[];
}

function parseFlags(argv: string[]): GlobalFlags {
  const flags: GlobalFlags = { json: false, yes: false, args: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--json") flags.json = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--data-dir") {
      flags.dataDir = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--data-dir=")) flags.dataDir = a.slice("--data-dir=".length);
    else flags.args.push(a);
  }
  return flags;
}

const HELP = `Purge+ ${APP_VERSION}

用法：purgeplus <命令> [参数] [--json] [--yes] [--data-dir <目录>]

  serve [--port N] [--host H]     启动 API + UI
  doctor                          环境体检（数据目录/配置/数据库/审计链）
  host list                       发现宿主
  host inspect <hostId>           只读取证（磁盘态/进程态/加载态）
  diagnose [<hostId>] [--all]     运行诊断
  snapshot list|capture <label> <paths...>|restore <id>|verify <id>
  pack list|import <file>|plan <id> <hostId>|apply <id> <hostId>|revert <snapshotId>
  rule list|add <id> <title> --body <text>|show <id>|on|off|rm <id>|compose [--workspace <dir>]
  skill list|scan <root>|add <dir> [--overwrite]|rm <name>
  plugin list|install <dir> [--overwrite]|enable <name>|disable <name>|health <name>|invoke <name> <method> [json]|rm <name>
  update status|check [--index <file|url>]|plan [version]|apply [version]
  workflow list|run <id>|runs
  job list|add <id> <workflowId> <cron|间隔秒>|pause <id>|resume <id>|rm <id>
  audit [--limit N]               审计（含链校验）
  config get|set <key=value...>
  policy check <action> [paths...] 风险评分预览

退出码：0 成功 · 1 失败 · 2 用法错误 · 3 策略拒绝`;

async function main(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const [cmd, sub, ...rest] = flags.args;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${HELP}\n`);
    return EXIT.ok;
  }
  const out = (data: unknown, text?: string): void => {
    if (flags.json) process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
    else process.stdout.write(`${text ?? JSON.stringify(data, null, 2)}\n`);
  };

  if (cmd === "serve") {
    const app = new PurgeApp({ dataDir: flags.dataDir });
    const handle = createApiServer({ app });
    const url = await handle.listen();
    process.stdout.write(`Purge+ 已启动：${url}\n数据目录：${app.dataDir}\nCtrl+C 退出\n`);
    const shutdown = async (): Promise<void> => {
      await handle.close();
      process.exit(EXIT.ok);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    await new Promise<void>(() => {});
    return EXIT.ok;
  }

  const app = new PurgeApp({ dataDir: flags.dataDir, startScheduler: false });
  await app.start();
  const s = app.services;
  try {
    switch (cmd) {
      case "doctor": {
        const cfg = s.config.get();
        const audit = s.audit.verify();
        const hosts = await s.registry.discover(true);
        const report = {
          version: APP_VERSION,
          dataDir: app.dataDir,
          node: process.version,
          platform: `${process.platform}-${process.arch}`,
          config: { port: cfg.port, logLevel: cfg.logLevel, confirmThreshold: cfg.policy.confirmThreshold },
          database: { schemaVersion: s.db.version(), auditEntries: s.audit.count() },
          auditChain: audit,
          hosts: hosts.map((h) => ({ id: h.id, root: h.root, adapter: h.adapterId })),
          adapters: s.registry.adapters().map((a) => ({ id: a.id, name: a.displayName })),
        };
        out(
          report,
          [
            `Purge+ ${report.version} · node ${report.node} · ${report.platform}`,
            `数据目录 ${report.dataDir}`,
            `配置 port=${cfg.port} log=${cfg.logLevel} confirm≥${cfg.policy.confirmThreshold}`,
            `数据库 schema=v${report.database.schemaVersion} 审计 ${report.database.auditEntries} 条`,
            `审计链 ${audit.ok ? "✓ 完整" : `✗ 断链@${audit.brokenAt} ${audit.reason ?? ""}`}`,
            `宿主 ${hosts.length} 个${hosts.length ? `：${hosts.map((h) => h.id).join(", ")}` : ""}`,
            audit.ok ? "" : "结论：审计链已损坏，需人工核查（不会自动修复）",
          ]
            .filter((l) => l !== "")
            .join("\n"),
        );
        return audit.ok ? EXIT.ok : EXIT.failed;
      }

      case "host": {
        if (sub === "list") {
          const hosts = await s.registry.discover(true);
          out(
            hosts.map((h) => ({ id: h.id, root: h.root, adapter: h.adapterId })),
            hosts.length ? hosts.map((h) => `${h.id}\t${h.root}`).join("\n") : "未发现宿主",
          );
          return EXIT.ok;
        }
        if (sub === "inspect" && rest[0]) {
          const facts = await s.registry.inspect(rest[0], true);
          out(
            facts,
            [
              `宿主 ${facts.identity.product}@${facts.identity.version}（${facts.identity.confidence}）`,
              `磁盘形态 ${facts.shape} · 进程 ${facts.process.running === null ? "unknown" : facts.process.running ? "running" : "stopped"} · 加载形态 ${facts.loadedShape}`,
              `归档 ${facts.archive.exists ? `${facts.archive.size} 字节` : "无"} · 解包目录 ${facts.unpacked.exists ? facts.unpacked.entries.length + " 项" : "无"}`,
              `profile ${facts.profiles.map((p) => p.name).join(", ") || "无"}`,
              `修改痕迹 ${facts.modification.looksModified === null ? "unknown" : facts.modification.looksModified ? "已修改" : "未见"}`,
            ].join("\n"),
          );
          return EXIT.ok;
        }
        break;
      }

      case "diagnose": {
        const target = rest.find((a) => !a.startsWith("--"));
        const reports = target ? [await s.diagnostics.run(target)] : await s.diagnostics.runAll();
        const text = reports
          .map((r) => {
            const lines = [`${r.hostLabel} · ${r.host.shape}/${r.host.loadedShape} · ${r.level.toUpperCase()}`, `  通过 ${r.summary.pass} · 警告 ${r.summary.warn} · 失败 ${r.summary.fail} · 未知 ${r.summary.unknown}`];
            for (const f of r.findings.filter((f) => f.status !== "pass" && f.status !== "not_applicable")) {
              lines.push(`  [${f.status}] ${f.title}${f.rootCause ? ` — ${f.rootCause.text}` : ""}`);
            }
            return lines.join("\n");
          })
          .join("\n\n");
        out(reports, text || "未发现宿主");
        return reports.some((r) => r.level === "broken") ? EXIT.failed : EXIT.ok;
      }

      case "snapshot": {
        if (sub === "list") {
          const list = s.snapshots.list(50).map(({ manifest, ...r }) => r);
          out(list, list.map((r) => `${r.snapId}\t${r.label}\t${r.stats.files} 文件/${r.stats.bytes} 字节`).join("\n") || "无快照");
          return EXIT.ok;
        }
        if (sub === "capture" && rest[0] && rest.length > 1) {
          const label = rest[0];
          const targets = rest.slice(1).map((p) => path.resolve(p));
          const { result } = await app.guarded(
            "cli",
            { action: "snapshot.capture", target: label, paths: targets, origin: "human" },
            () => s.snapshots.capture(label, targets),
            { confirmed: flags.yes },
          );
          out(result, `已创建 ${result.snapId}（${result.stats.files} 文件 / ${result.stats.bytes} 字节）`);
          return EXIT.ok;
        }
        if (sub === "verify" && rest[0]) {
          const v = await s.snapshots.verify(rest[0]);
          out(v, v.ok ? "快照完整" : `快照损坏：${v.issues.join("; ")}`);
          return v.ok ? EXIT.ok : EXIT.failed;
        }
        if (sub === "restore" && rest[0]) {
          const id = rest[0];
          const snap = s.snapshots.get(id);
          const { result } = await app.guarded(
            "cli",
            { action: "snapshot.restore", target: id, paths: snap.manifest.entries.map((e) => e.path), origin: "human" },
            () => s.snapshots.restore(id),
            { confirmed: flags.yes, forceConfirm: true },
          );
          out(result, `恢复 ${result.restored.length} 个文件，删除 ${result.removed.length} 个，失败 ${result.failed.length} 个`);
          return result.failed.length === 0 ? EXIT.ok : EXIT.failed;
        }
        break;
      }

      case "workflow": {
        if (sub === "list") {
          const list = s.workflow.list();
          out(list.map((w) => ({ id: w.id, name: w.name, steps: w.steps.length })), list.map((w) => `${w.id}\t${w.name}（${w.steps.length} 步）`).join("\n"));
          return EXIT.ok;
        }
        if (sub === "runs") {
          const runs = s.workflow.listRuns(20);
          out(runs, runs.map((r) => `${r.runId}\t${r.workflowId}\t${r.state}`).join("\n") || "无运行记录");
          return EXIT.ok;
        }
        if (sub === "run" && rest[0]) {
          const { result } = await app.guarded("cli", { action: "workflow.run", target: rest[0], origin: "human" }, () => s.workflow.run(rest[0] as string));
          out(result, `${result.runId} → ${result.state}`);
          return result.state === "succeeded" ? EXIT.ok : EXIT.failed;
        }
        break;
      }

      case "job": {
        if (sub === "list") {
          const jobs = s.scheduler.list();
          out(jobs, jobs.map((j) => `${j.id}\t${j.state}\t${j.kind}\tnext=${j.nextRunMs === undefined ? "-" : new Date(j.nextRunMs).toISOString()}`).join("\n") || "无任务");
          return EXIT.ok;
        }
        if (sub === "add" && rest[0] && rest[1] && rest[2]) {
          const [id, workflowId, when] = rest as [string, string, string];
          const schedule = /^\d+$/.test(when)
            ? ({ type: "interval", seconds: Number(when) } as const)
            : ({ type: "cron", expr: when } as const);
          const { result } = await app.guarded(
            "cli",
            { action: "job.add", target: id, origin: "human" },
            async () => s.scheduler.add({ id, kind: "workflow", payload: { workflowId }, schedule }),
            { confirmed: flags.yes, forceConfirm: true },
          );
          out(result, `已添加 ${result.id}，下次 ${result.nextRunMs === undefined ? "-" : new Date(result.nextRunMs).toISOString()}`);
          return EXIT.ok;
        }
        if (sub === "pause" && rest[0]) {
          const j = s.scheduler.pause(rest[0]);
          out(j, `${j.id} → ${j.state}`);
          return EXIT.ok;
        }
        if (sub === "resume" && rest[0]) {
          const j = s.scheduler.resume(rest[0]);
          out(j, `${j.id} → ${j.state}`);
          return EXIT.ok;
        }
        if ((sub === "rm" || sub === "remove") && rest[0]) {
          s.scheduler.remove(rest[0]);
          out({ removed: rest[0] }, `已删除 ${rest[0]}`);
          return EXIT.ok;
        }
        break;
      }

      case "pack": {
        if (sub === "list") {
          const list = await s.packs.list();
          out(
            list.map((p) => ({ id: p.pack.id, version: p.pack.version, risk: p.pack.risk.level, rules: p.pack.rules.length, hash: p.hash, source: p.source })),
            list.map((p) => `${p.pack.id}@${p.pack.version}\t风险 ${p.pack.risk.level}\t${p.pack.rules.length} 条\t${p.hash.slice(0, 12)}`).join("\n") || "未导入任何包",
          );
          return EXIT.ok;
        }
        if (sub === "import" && rest[0]) {
          const file = path.resolve(rest[0]);
          const text = await (await import("node:fs/promises")).readFile(file, "utf8").catch(() => {
            throw new PurgeError({ code: "unreadable", message: `cannot read ${file}` });
          });
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch (err) {
            throw new PurgeError({ code: "schema_invalid", message: `invalid json: ${(err as Error).message}` });
          }
          const { result } = await app.guarded(
            "cli",
            { action: "pack.import", target: file, paths: [s.packs.dir], origin: "human" },
            () => s.packs.importPack(raw, file),
            { confirmed: flags.yes },
          );
          out({ id: result.pack.id, version: result.pack.version, hash: result.hash }, `已导入 ${result.pack.id}@${result.pack.version}（${result.hash.slice(0, 12)}）`);
          return EXIT.ok;
        }
        if ((sub === "plan" || sub === "apply") && rest[0] && rest[1]) {
          const [packId, hostId] = rest as [string, string];
          const facts = await s.registry.inspect(hostId, true);
          if (!facts.unpacked.exists) {
            throw new PurgeError({ code: "unsupported", message: "宿主未解包；v0.1 不对归档做就地修改" });
          }
          const stored = await s.packs.get(packId);
          const base = { baseRoot: facts.unpacked.path, hostVersion: facts.identity.version };
          if (sub === "plan") {
            const plan = await s.packEngine.plan(stored.pack, base);
            out(plan, formatPlan(plan));
            // 只有「确认的异常」才非零：漂移 / 命中不符 / 冲突 / 必需目标缺失
            const broken =
              plan.summary.drifted + plan.summary.hit_mismatch + plan.summary.conflict > 0 ||
              plan.entries.some((e) => e.status === "missing" && !stored.pack.rules.find((r) => r.id === e.ruleId)?.optional);
            return broken ? EXIT.failed : EXIT.ok;
          }
          const plan = await s.packEngine.plan(stored.pack, base);
          const targets = plan.entries.filter((e) => e.status === "pending").map((e) => e.path);
          const { result } = await app.guarded(
            "cli",
            { action: "pack.apply", target: `${stored.pack.id}@${stored.pack.version}`, paths: targets, origin: "human" },
            () => s.packEngine.apply(stored.pack, base),
            { confirmed: flags.yes, forceConfirm: true },
          );
          out(result, `已应用：写入 ${result.written.length} 个文件\n快照 ${result.snapshotId}\n事务 ${result.txId}`);
          return EXIT.ok;
        }
        if (sub === "revert" && rest[0]) {
          const { result } = await app.guarded(
            "cli",
            { action: "pack.revert", target: rest[0], paths: [], origin: "human" },
            () => s.packEngine.revert(rest[0] as string),
            { confirmed: flags.yes, forceConfirm: true },
          );
          out(result, `已恢复 ${result.restored.length} 个文件，失败 ${result.failed.length} 个`);
          return result.failed.length === 0 ? EXIT.ok : EXIT.failed;
        }
        break;
      }

      case "rule": {
        const flagValue = (name: string): string | undefined => {
          const i = rest.indexOf(name);
          return i >= 0 ? rest[i + 1] : undefined;
        };
        if (sub === "list") {
          const list = await s.rules.list();
          out(
            list.map((r) => ({ id: r.id, title: r.title, enabled: r.enabled, scope: r.scope, version: r.version })),
            list.map((r) => `${r.id}\t${r.enabled ? "on " : "off"}\t${r.scope.kind}${r.scope.kind === "workspace" ? `:${r.scope.path}` : ""}\t${r.title}`).join("\n") || "还没有规则",
          );
          return EXIT.ok;
        }
        if (sub === "add" && rest[0] && rest[1]) {
          const body = flagValue("--body") ?? (flagValue("--body-file") ? await (await import("node:fs/promises")).readFile(path.resolve(flagValue("--body-file") as string), "utf8") : undefined);
          if (!body) throw new PurgeError({ code: "invalid_argument", message: "需要 --body 或 --body-file" });
          const workspace = flagValue("--workspace");
          const { result } = await app.guarded(
            "cli",
            { action: "config.set", target: `rule:${rest[0]}`, paths: [s.rules.dir], origin: "human" },
            () =>
              s.rules.create({
                id: rest[0] as string,
                title: rest[1] as string,
                body,
                ...(workspace ? { scope: { kind: "workspace" as const, path: path.resolve(workspace) } } : {}),
              }),
            { confirmed: flags.yes },
          );
          out(result, `已创建规则 ${result.id}（v${result.version}）`);
          return EXIT.ok;
        }
        if (sub === "show" && rest[0]) {
          const rule = await s.rules.get(rest[0]);
          out(rule, s.rules.exportMarkdown(rule));
          return EXIT.ok;
        }
        if ((sub === "rm" || sub === "remove") && rest[0]) {
          await app.guarded("cli", { action: "config.set", target: `rule:${rest[0]}`, paths: [s.rules.dir], origin: "human" }, async () => {
            await s.rules.remove(rest[0] as string);
            return null;
          }, { confirmed: true });
          out({ removed: rest[0] }, `已删除 ${rest[0]}`);
          return EXIT.ok;
        }
        if (sub === "on" || sub === "off") {
          if (!rest[0]) break;
          const rule = await s.rules.update(rest[0], { enabled: sub === "on" });
          out(rule, `${rule.id} → ${rule.enabled ? "启用" : "停用"}`);
          return EXIT.ok;
        }
        if (sub === "compose") {
          const workspace = flagValue("--workspace");
          const composed = await s.rules.compose(workspace ? { workspace } : {});
          out(composed, composed.text || "（没有生效规则）");
          return EXIT.ok;
        }
        break;
      }

      case "skill": {
        if (sub === "list") {
          const list = await s.skills.list();
          out(
            list,
            list.map((k) => `${k.name}\t${k.files} 文件\t${k.bytes} 字节\t${k.description}${k.warnings.length ? `\t⚠${k.warnings.length}` : ""}`).join("\n") || "还没有技能",
          );
          return EXIT.ok;
        }
        if (sub === "scan" && rest[0]) {
          const found = await s.skills.scan([path.resolve(rest[0])]);
          out(found, found.map((k) => `${k.name}\t${k.description}\t${k.warnings.length ? `⚠${k.warnings.length}` : "ok"}`).join("\n") || "该目录下没有技能");
          return EXIT.ok;
        }
        if (sub === "add" && rest[0]) {
          const { result } = await app.guarded(
            "cli",
            { action: "config.set", target: `skill:${rest[0]}`, paths: [s.skills.dir], origin: "human" },
            () => s.skills.import(path.resolve(rest[0] as string), { overwrite: rest.includes("--overwrite") }),
            { confirmed: flags.yes },
          );
          out(result, `已导入技能 ${result.name}（${result.files} 文件 / ${result.bytes} 字节${result.warnings.length ? `，${result.warnings.length} 条提示` : ""}）`);
          return EXIT.ok;
        }
        if ((sub === "rm" || sub === "remove") && rest[0]) {
          await app.guarded("cli", { action: "config.set", target: `skill:${rest[0]}`, paths: [s.skills.dir], origin: "human" }, () => s.skills.remove(rest[0] as string), { confirmed: true });
          out({ removed: rest[0] }, `已删除技能 ${rest[0]}`);
          return EXIT.ok;
        }
        break;
      }

      case "plugin": {
        if (sub === "list") {
          const list = await s.plugins.list();
          out(
            list.map((p) => ({ name: p.manifest.name, version: p.manifest.version, state: p.state, capabilities: p.manifest.capabilities, error: p.error })),
            list.map((p) => `${p.manifest.name}@${p.manifest.version}\t${p.state}\t[${p.manifest.capabilities.join(",")}]${p.error ? `\t${p.error}` : ""}`).join("\n") || "还没有插件",
          );
          return EXIT.ok;
        }
        if (sub === "install" && rest[0]) {
          const { result } = await app.guarded(
            "cli",
            { action: "plugin.install", target: rest[0], paths: [s.plugins.dir], origin: "human" },
            () => s.plugins.install(path.resolve(rest[0] as string), { overwrite: rest.includes("--overwrite") }),
            { confirmed: flags.yes },
          );
          out(result, `已安装 ${result.manifest.name}@${result.manifest.version}（${result.state}）`);
          return EXIT.ok;
        }
        if (sub === "enable" && rest[0]) {
          const { result } = await app.guarded("cli", { action: "plugin.enable", target: rest[0], origin: "human" }, () => s.plugins.enable(rest[0] as string), { confirmed: flags.yes });
          out(result, `${result.manifest.name} → ${result.state}`);
          return EXIT.ok;
        }
        if (sub === "disable" && rest[0]) {
          const { result } = await app.guarded("cli", { action: "plugin.disable", target: rest[0], origin: "human" }, () => s.plugins.disable(rest[0] as string), { confirmed: flags.yes });
          out(result, `${result.manifest.name} → ${result.state}`);
          return EXIT.ok;
        }
        if (sub === "health" && rest[0]) {
          const health = await s.plugins.health(rest[0]);
          out(health, `${rest[0]}: ${health.ok ? "健康" : "异常"}（${health.state}）${health.detail ? ` — ${health.detail}` : ""}`);
          return health.ok ? EXIT.ok : EXIT.failed;
        }
        if (sub === "invoke" && rest[0] && rest[1]) {
          let args: unknown = {};
          if (rest[2]) {
            try {
              args = JSON.parse(rest[2]);
            } catch {
              throw new PurgeError({ code: "invalid_argument", message: "第三个参数必须是 JSON" });
            }
          }
          const result = await s.plugins.invoke(rest[0] as string, rest[1] as string, args);
          out(result, JSON.stringify(result, null, 2));
          return EXIT.ok;
        }
        if ((sub === "rm" || sub === "remove") && rest[0]) {
          await app.guarded("cli", { action: "plugin.remove", target: rest[0], origin: "human" }, () => s.plugins.remove(rest[0] as string), { confirmed: true });
          out({ removed: rest[0] }, `已删除插件 ${rest[0]}`);
          return EXIT.ok;
        }
        break;
      }

      case "update": {
        if (sub === "status" || !sub) {
          const status = await s.updates.status();
          out({ current: APP_VERSION, ...status }, `当前 ${APP_VERSION}${status.activeVersion ? ` · 已激活 ${status.activeVersion}` : ""}${status.lastCheck ? ` · 上次检查 ${status.lastCheck.checkedAt}（latest=${status.lastCheck.latest ?? "-"}）` : ""}`);
          return EXIT.ok;
        }
        if (sub === "check") {
          const idxFlag = rest.indexOf("--index");
          const indexSource = idxFlag >= 0 ? rest[idxFlag + 1] : undefined;
          const index = indexSource ? await s.updates.loadIndex(indexSource) : undefined;
          const check = await s.updates.check(index ? { index } : {});
          out(check, `当前 ${check.current} · 最新 ${check.latest ?? "-"} · ${check.hasUpdate ? "有更新" : "已是最新"}${check.note ? `（${check.note}）` : ""}`);
          return EXIT.ok;
        }
        if (sub === "plan") {
          const idxFlag = rest.indexOf("--index");
          const indexSource = idxFlag >= 0 ? rest[idxFlag + 1] : undefined;
          const index = indexSource ? await s.updates.loadIndex(indexSource) : undefined;
          const plan = await s.updates.plan(rest.find((a) => !a.startsWith("--") && a !== indexSource), index ? { index } : {});
          out(plan, `${plan.from} → ${plan.to}（${plan.artifacts.length} 个产物）${plan.notes ? `\n${plan.notes}` : ""}`);
          return EXIT.ok;
        }
        if (sub === "apply") {
          const idxFlag = rest.indexOf("--index");
          const indexSource = idxFlag >= 0 ? rest[idxFlag + 1] : undefined;
          const index = indexSource ? await s.updates.loadIndex(indexSource) : undefined;
          const plan = await s.updates.plan(rest.find((a) => !a.startsWith("--") && a !== indexSource), index ? { index } : {});
          const { result } = await app.guarded(
            "cli",
            { action: "update.apply", target: `${plan.from}->${plan.to}`, paths: [s.updates.dir], origin: "human" },
            async () => {
              const staged = await s.updates.stage(plan);
              return s.updates.activate(staged);
            },
            { confirmed: flags.yes, forceConfirm: true },
          );
          out(result, `已激活 ${result.version}${result.previous ? `（上一版本 ${result.previous}）` : ""}`);
          return EXIT.ok;
        }
        break;
      }

      case "audit": {
        const limitArg = rest.indexOf("--limit");
        const limit = limitArg >= 0 ? Number(rest[limitArg + 1]) : 20;
        const verify = s.audit.verify();
        const entries = s.audit.list({ limit: Number.isFinite(limit) ? limit : 20 });
        out(
          { verify, entries },
          [
            `审计链 ${verify.ok ? `✓ ${verify.checked} 条` : `✗ 断链@${verify.brokenAt}`}`,
            ...entries.map((e) => `${e.ts} #${e.seq} ${e.action} ${e.target ?? ""} risk=${e.risk}`),
          ].join("\n"),
        );
        return verify.ok ? EXIT.ok : EXIT.failed;
      }

      case "config": {
        if (sub === "get") {
          out(s.config.get(), JSON.stringify(s.config.get(), null, 2));
          return EXIT.ok;
        }
        if (sub === "set" && rest.length > 0) {
          const patch: Record<string, unknown> = {};
          for (const pair of rest) {
            const idx = pair.indexOf("=");
            if (idx <= 0) throw new PurgeError({ code: "invalid_argument", message: `expect key=value, got "${pair}"` });
            const key = pair.slice(0, idx);
            const raw = pair.slice(idx + 1);
            patch[key] = /^\d+$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw;
          }
          const { result } = await app.guarded(
            "cli",
            { action: "config.set", target: s.config.file, paths: [s.config.file], origin: "human" },
            () => s.config.update(patch),
            { confirmed: flags.yes },
          );
          out(result, `已更新：${Object.keys(patch).join(", ")}`);
          return EXIT.ok;
        }
        break;
      }

      case "policy": {
        if (sub === "check" && rest[0]) {
          const verdict = app.policyConfig();
          const { evaluatePolicy } = await import("../security/policy.ts");
          const v = evaluatePolicy(
            { action: rest[0], paths: rest.slice(1), origin: "human" },
            verdict,
          );
          out(v, `${v.decision.toUpperCase()} risk=${v.risk}\n${v.factors.map((f) => `  ${f.code} +${f.weight} (${f.note})`).join("\n")}`);
          return EXIT.ok;
        }
        break;
      }
      default:
        break;
    }
    process.stderr.write(`未知或参数不足的命令：${[cmd, sub].filter(Boolean).join(" ")}\n\n${HELP}\n`);
    return EXIT.usage;
  } finally {
    await app.stop();
  }
}

void main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const e = asPurgeError(err);
    process.stderr.write(`${e.code}: ${e.message}\n`);
    if (e.detail) process.stderr.write(`${JSON.stringify(e.detail, null, 2)}\n`);
    process.exit(e.code === "policy_denied" ? EXIT.denied : EXIT.failed);
  });

export { main, parseFlags, resolveDataDir };
