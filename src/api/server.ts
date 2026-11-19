/**
 * HTTP API（node:http，无框架）。
 *
 * 约定：
 * - 统一响应 { ok:true, data } / { ok:false, error:{code,message,detail} }。
 * - 变更类接口在应用层走 PurgeApp.guarded()：策略判定 + 审计。
 * - 静态 UI 与 API 同源；路径穿越被拒绝。
 */
import * as fsp from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as path from "node:path";
import type { PurgeApp } from "../app.ts";
import { APP_VERSION } from "../app.ts";
import { asPurgeError, PurgeError, purgeError } from "../core/errors.ts";
import { evaluatePolicy, type ActionRequest } from "../security/policy.ts";
import type { Schedule } from "../scheduler/cron.ts";

export interface ApiOptions {
  app: PurgeApp;
  host?: string;
  port?: number;
  staticDir?: string;
  /** 请求体上限，默认 1 MiB。 */
  maxBodyBytes?: number;
}

export interface ApiHandle {
  server: Server;
  url: string;
  listen(): Promise<string>;
  close(): Promise<void>;
}

const STATUS_BY_CODE: Record<string, number> = {
  invalid_argument: 400,
  schema_invalid: 400,
  not_found: 404,
  conflict: 409,
  unreadable: 422,
  unwritable: 422,
  integrity_failed: 422,
  policy_denied: 403,
  confirmation_required: 428,
  unsupported: 501,
  timeout: 504,
  service_failed: 500,
  internal: 500,
};

export function createApiServer(opts: ApiOptions): ApiHandle {
  const { app } = opts;
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const staticDir = opts.staticDir ?? path.join(import.meta.dirname, "..", "ui");

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        const result = await route(req, url);
        sendJson(res, 200, { ok: true, data: result });
      } else {
        await serveStatic(url.pathname, res);
      }
    } catch (err) {
      const e = asPurgeError(err);
      const status = STATUS_BY_CODE[e.code] ?? 500;
      if (status >= 500) app.services.logger.error("api error", { path: req.url, code: e.code, message: e.message });
      sendJson(res, status, { ok: false, error: e.toJSON() });
    } finally {
      app.services.metrics.record("api.request_ms", Date.now() - started);
    }
  }

  async function route(req: IncomingMessage, url: URL): Promise<unknown> {
    const s = app.services;
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter((p) => p.length > 0); // ["api", ...]
    const resource = parts[1] ? decodeURIComponent(parts[1]) : undefined;
    const id = parts[2] ? decodeURIComponent(parts[2]) : undefined;
    const action = parts[3] ? decodeURIComponent(parts[3]) : undefined;

    if (method === "GET" && resource === "health") {
      return {
        ok: true,
        version: APP_VERSION,
        uptimeSec: Math.round(process.uptime()),
        dataDir: app.dataDir,
        counts: { audit: s.audit.count() },
      };
    }

    if (method === "GET" && resource === "overview") {
      const hosts = await s.registry.discover();
      const facts = [] as Array<Record<string, unknown>>;
      for (const h of hosts) {
        try {
          const f = await s.registry.inspect(h.id);
          facts.push({
            id: h.id,
            root: h.root,
            product: f.identity.product,
            version: f.identity.version,
            shape: f.shape,
            running: f.process.running,
            modified: f.modification.looksModified,
          });
        } catch (err) {
          facts.push({ id: h.id, root: h.root, error: asPurgeError(err).message });
        }
      }
      const runs = s.workflow.listRuns(5).map((r) => ({ runId: r.runId, workflowId: r.workflowId, state: r.state }));
      return {
        version: APP_VERSION,
        hosts: facts,
        runs,
        jobs: s.scheduler.list().map((j) => ({ id: j.id, state: j.state, nextRunMs: j.nextRunMs })),
        audit: { count: s.audit.count(), verify: s.audit.verify() },
        traces: s.traces.listTraces({ limit: 5 }),
      };
    }

    if (resource === "hosts") {
      if (method === "GET" && !id) {
        const hosts = await s.registry.discover();
        return hosts.map((h) => ({ id: h.id, adapter: h.adapterId, root: h.root, resourcesDir: h.resourcesDir, home: h.home }));
      }
      if (method === "POST" && id === "discover") {
        const hosts = await s.registry.discover(true);
        return { discovered: hosts.length, hosts: hosts.map((h) => h.id) };
      }
      if (method === "GET" && id && action === "inspect") {
        return s.registry.inspect(id, true);
      }
    }

    if (resource === "diagnostics") {
      if (method === "GET") return { recent: s.diagnostics.recentReports(20) };
      if (method === "POST" && id === "run") {
        const body = await readJson(req, maxBody);
        const hostId = typeof body.hostId === "string" ? body.hostId : "";
        if (hostId) return s.diagnostics.run(hostId);
        return s.diagnostics.runAll();
      }
    }

    if (resource === "workflows") {
      if (method === "GET" && !id) return s.workflow.list();
      if (method === "GET" && id) return s.workflow.get(id);
      if (method === "POST" && id && action === "run") {
        const body = await readJson(req, maxBody);
        const resumed = typeof body.resumeRunId === "string" ? body.resumeRunId : undefined;
        const { result } = await app.guarded("api", { action: "workflow.run", target: id, origin: body.origin === "ai" ? "ai" : "human" }, () =>
          s.workflow.run(id, resumed ? { resumeRunId: resumed } : {}),
        );
        return result;
      }
    }

    if (resource === "runs") {
      if (method === "GET" && !id) return s.workflow.listRuns(50);
      if (method === "GET" && id) {
        const run = s.workflow.getRun(id);
        if (!run) throw purgeError("not_found", `run not found: ${id}`);
        return run;
      }
      if (method === "POST" && id && action === "cancel") {
        s.workflow.cancel(id);
        return { cancelled: id };
      }
    }

    if (resource === "jobs") {
      if (method === "GET" && !id) return s.scheduler.list();
      if (method === "POST" && !id) {
        const body = await readJson(req, maxBody);
        const schedule = body.schedule as Schedule | undefined;
        if (!schedule) throw purgeError("invalid_argument", "schedule is required");
        const { result } = await app.guarded(
          "api",
          { action: "job.add", target: String(body.id ?? ""), origin: body.origin === "ai" ? "ai" : "human" },
          async () =>
            s.scheduler.add({
              id: String(body.id ?? ""),
              kind: String(body.kind ?? "workflow"),
              payload: (body.payload as Record<string, unknown>) ?? {},
              schedule,
            }),
          { confirmed: body.confirm === true, forceConfirm: true },
        );
        return result;
      }
      if (id && action) {
        if (method === "POST" && action === "pause") return s.scheduler.pause(id);
        if (method === "POST" && action === "resume") return s.scheduler.resume(id);
        if (method === "POST" && action === "run") {
          const { result } = await app.guarded(
            "api",
            { action: "job.run", target: id, origin: "human" },
            () => s.scheduler.runNow(id),
            { confirmed: true },
          );
          return result;
        }
      }
      if (method === "DELETE" && id) {
        s.scheduler.remove(id);
        return { removed: id };
      }
    }

    if (resource === "snapshots") {
      if (method === "GET" && !id) return s.snapshots.list(50).map(({ manifest, ...rest }) => rest);
      if (method === "POST" && !id) {
        const body = await readJson(req, maxBody);
        const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string") : [];
        const label = typeof body.label === "string" ? body.label : "manual";
        if (paths.length === 0) throw purgeError("invalid_argument", "paths[] is required");
        const { result } = await app.guarded(
          "api",
          { action: "snapshot.capture", target: label, paths, origin: "human" },
          () => s.snapshots.capture(label, paths),
          { confirmed: body.confirm === true },
        );
        const { manifest, ...rest } = result;
        void manifest;
        return rest;
      }
      if (method === "GET" && id && action === "verify") return s.snapshots.verify(id);
      if (method === "POST" && id && action === "restore") {
        const body = await readJson(req, maxBody);
        const rec = s.snapshots.get(id);
        const paths = rec.manifest.entries.map((e) => e.path);
        const { result } = await app.guarded(
          "api",
          { action: "snapshot.restore", target: id, paths, origin: "human" },
          () => s.snapshots.restore(id),
          { confirmed: body.confirm === true, forceConfirm: true },
        );
        return result;
      }
    }

    if (resource === "packs") {
      if (method === "GET" && !id) {
        const list = await s.packs.list();
        return list.map((p) => ({
          id: p.pack.id,
          name: p.pack.name,
          version: p.pack.version,
          hash: p.hash,
          risk: p.pack.risk,
          target: p.pack.target,
          rules: p.pack.rules.length,
          source: p.source,
          importedAt: p.importedAt,
        }));
      }
      if (method === "POST" && id === "import") {
        const body = await readJson(req, maxBody);
        let raw: unknown = body.pack;
        let source = typeof body.source === "string" ? body.source : "api";
        if (raw === undefined && typeof body.path === "string") {
          const text = await fsp.readFile(path.resolve(body.path), "utf8").catch(() => {
            throw purgeError("unreadable", `cannot read pack file: ${body.path}`);
          });
          try {
            raw = JSON.parse(text);
          } catch (err) {
            throw purgeError("schema_invalid", `pack file is not valid json: ${(err as Error).message}`);
          }
          source = body.path;
        }
        if (raw === undefined) throw purgeError("invalid_argument", "body must contain pack or path");
        const { result } = await app.guarded(
          "api",
          { action: "pack.import", target: source, paths: [s.packs.dir], origin: "human" },
          () => s.packs.importPack(raw, source),
          { confirmed: body.confirm === true },
        );
        return { id: result.pack.id, version: result.pack.version, hash: result.hash };
      }
      if (id && action === "plan" && method === "POST") {
        const body = await readJson(req, maxBody);
        const base = await resolveBaseRoot(s, String(body.hostId ?? ""));
        const stored = await s.packs.get(id, typeof body.version === "string" ? body.version : undefined);
        return s.packEngine.plan(stored.pack, { baseRoot: base.root, hostVersion: base.version });
      }
      if (id && action === "apply" && method === "POST") {
        const body = await readJson(req, maxBody);
        const base = await resolveBaseRoot(s, String(body.hostId ?? ""));
        const stored = await s.packs.get(id, typeof body.version === "string" ? body.version : undefined);
        const plan = await s.packEngine.plan(stored.pack, { baseRoot: base.root, hostVersion: base.version });
        const targets = plan.entries.filter((e) => e.status === "pending").map((e) => e.path);
        const { result } = await app.guarded(
          "api",
          { action: "pack.apply", target: `${stored.pack.id}@${stored.pack.version}`, paths: targets, origin: "human" },
          () => s.packEngine.apply(stored.pack, { baseRoot: base.root, hostVersion: base.version }),
          { confirmed: body.confirm === true, forceConfirm: true },
        );
        return result;
      }
      if (id && action === "revert" && method === "POST") {
        const body = await readJson(req, maxBody);
        const snapshotId = String(body.snapshotId ?? "");
        if (!snapshotId) throw purgeError("invalid_argument", "snapshotId is required");
        const { result } = await app.guarded(
          "api",
          { action: "pack.revert", target: snapshotId, paths: [], origin: "human" },
          () => s.packEngine.revert(snapshotId),
          { confirmed: body.confirm === true, forceConfirm: true },
        );
        return result;
      }
    }

    if (resource === "rules") {
      if (method === "GET" && !id) return s.rules.list();
      if (method === "GET" && id) return s.rules.get(id);
      if (method === "POST" && !id) {
        const body = await readJson(req, maxBody);
        if (typeof body.markdown === "string") {
          const { result } = await app.guarded(
            "api",
            { action: "config.set", target: "rules:import", paths: [s.rules.dir], origin: "human" },
            () => s.rules.importMarkdown(body.markdown as string, { overwrite: body.overwrite === true }),
            { confirmed: body.confirm === true },
          );
          return result;
        }
        const { result } = await app.guarded(
          "api",
          { action: "config.set", target: `rule:${String(body.id ?? "")}`, paths: [s.rules.dir], origin: "human" },
          () =>
            s.rules.create({
              id: String(body.id ?? ""),
              title: String(body.title ?? ""),
              body: String(body.body ?? ""),
              ...(body.enabled === undefined ? {} : { enabled: body.enabled === true }),
              ...(body.scope === undefined ? {} : { scope: body.scope as never }),
              ...(Array.isArray(body.tags) ? { tags: body.tags.filter((t): t is string => typeof t === "string") } : {}),
            }),
          { confirmed: body.confirm === true },
        );
        return result;
      }
      if (method === "POST" && id === "compose") {
        const body = await readJson(req, maxBody);
        return s.rules.compose({ workspace: typeof body.workspace === "string" ? body.workspace : undefined });
      }
      if (method === "POST" && id && action) {
        const body = await readJson(req, maxBody);
        if (action === "enable" || action === "disable") {
          const { result } = await app.guarded(
            "api",
            { action: "config.set", target: `rule:${id}`, paths: [s.rules.dir], origin: "human" },
            () => s.rules.update(id, { enabled: action === "enable" }),
            { confirmed: body.confirm === true },
          );
          return result;
        }
        if (action === "update") {
          const { result } = await app.guarded(
            "api",
            { action: "config.set", target: `rule:${id}`, paths: [s.rules.dir], origin: "human" },
            () => s.rules.update(id, body as never),
            { confirmed: body.confirm === true },
          );
          return result;
        }
      }
      if (method === "DELETE" && id) {
        const { result } = await app.guarded(
          "api",
          { action: "config.set", target: `rule:${id}`, paths: [s.rules.dir], origin: "human" },
          async () => {
            await s.rules.remove(id);
            return { removed: id };
          },
          { confirmed: true },
        );
        return result;
      }
    }

    if (resource === "skills") {
      if (method === "GET" && !id) return s.skills.list();
      if (method === "GET" && id === "scan") {
        const roots = url.searchParams.getAll("root");
        if (roots.length === 0) throw purgeError("invalid_argument", "at least one root query param is required");
        return s.skills.scan(roots);
      }
      if (method === "POST" && id === "import") {
        const body = await readJson(req, maxBody);
        const sourceDir = String(body.path ?? "");
        if (!sourceDir) throw purgeError("invalid_argument", "path is required");
        const { result } = await app.guarded(
          "api",
          { action: "config.set", target: `skill:${sourceDir}`, paths: [s.skills.dir], origin: "human" },
          () => s.skills.import(sourceDir, { overwrite: body.overwrite === true }),
          { confirmed: body.confirm === true },
        );
        return result;
      }
      if (method === "POST" && id && action === "remove") {
        const { result } = await app.guarded(
          "api",
          { action: "config.set", target: `skill:${id}`, paths: [s.skills.dir], origin: "human" },
          () => s.skills.remove(id),
          { confirmed: true },
        );
        return result;
      }
    }

    if (resource === "plugins") {
      if (method === "GET" && !id) return s.plugins.list();
      if (method === "GET" && id && action === "health") return s.plugins.health(id);
      if (method === "POST" && id === "install") {
        const body = await readJson(req, maxBody);
        const source = String(body.path ?? "");
        if (!source) throw purgeError("invalid_argument", "path is required");
        const { result } = await app.guarded(
          "api",
          { action: "plugin.install", target: source, paths: [s.plugins.dir], origin: "human" },
          () => s.plugins.install(source, { overwrite: body.overwrite === true }),
          { confirmed: body.confirm === true },
        );
        return result;
      }
      if (method === "POST" && id && action) {
        const body = await readJson(req, maxBody);
        if (action === "enable") {
          const { result } = await app.guarded(
            "api",
            { action: "plugin.enable", target: id, origin: "human" },
            () => s.plugins.enable(id),
            { confirmed: body.confirm === true },
          );
          return result;
        }
        if (action === "disable") {
          const { result } = await app.guarded(
            "api",
            { action: "plugin.disable", target: id, origin: "human" },
            () => s.plugins.disable(id),
            { confirmed: body.confirm === true },
          );
          return result;
        }
        if (action === "remove") {
          const { result } = await app.guarded(
            "api",
            { action: "plugin.remove", target: id, origin: "human" },
            () => s.plugins.remove(id),
            { confirmed: true },
          );
          return result;
        }
      }
    }

    if (resource === "update") {
      if (method === "GET" && !id) return { status: await s.updates.status(), current: APP_VERSION };
      if (method === "POST" && id === "check") {
        const body = await readJson(req, maxBody);
        const src = typeof body.index === "string" ? body.index : undefined;
        const index = src ? await s.updates.loadIndex(src) : undefined;
        return s.updates.check(index ? { index } : {});
      }
      if (method === "POST" && id === "plan") {
        const body = await readJson(req, maxBody);
        const version = typeof body.version === "string" ? body.version : undefined;
        const src = typeof body.index === "string" ? body.index : undefined;
        const index = src ? await s.updates.loadIndex(src) : undefined;
        return s.updates.plan(version, index ? { index } : {});
      }
      if (method === "POST" && id === "apply") {
        const body = await readJson(req, maxBody);
        const version = typeof body.version === "string" ? body.version : undefined;
        const src = typeof body.index === "string" ? body.index : undefined;
        const index = src ? await s.updates.loadIndex(src) : undefined;
        const plan = await s.updates.plan(version, index ? { index } : {});
        const { result } = await app.guarded(
          "api",
          { action: "update.apply", target: `${plan.from}->${plan.to}`, paths: [s.updates.dir], origin: "human" },
          async () => {
            const staged = await s.updates.stage(plan);
            return s.updates.activate(staged);
          },
          { confirmed: body.confirm === true, forceConfirm: true },
        );
        return result;
      }
    }

    if (resource === "traces") {
      if (method === "GET" && !id) return s.traces.listTraces({ limit: 50 });
      if (method === "GET" && id) return s.traces.spansOf(id);
    }

    if (resource === "metrics") {
      if (method === "GET") {
        const names = s.metrics.names();
        return names.map((name) => ({ name, stats: s.metrics.stats(name) }));
      }
    }

    if (resource === "audit") {
      if (method === "GET" && !id) {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        return { verify: s.audit.verify(), entries: s.audit.list({ limit: Number.isFinite(limit) ? limit : 50 }) };
      }
      if (method === "GET" && id === "verify") return s.audit.verify();
    }

    if (resource === "config") {
      if (method === "GET" && !id) return { config: s.config.get(), history: await s.config.history() };
      if (method === "POST" && !id) {
        const body = await readJson(req, maxBody);
        const patch = (body.patch as Record<string, unknown>) ?? body;
        const { result } = await app.guarded(
          "api",
          { action: "config.set", target: s.config.file, paths: [s.config.file], origin: "human" },
          () => s.config.update(patch),
          { confirmed: body.confirm === true },
        );
        return result;
      }
    }

    if (resource === "policy" && method === "POST") {
      const body = await readJson(req, maxBody);
      const request: ActionRequest = {
        action: String(body.action ?? ""),
        target: typeof body.target === "string" ? body.target : undefined,
        paths: Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string") : undefined,
        recursive: body.recursive === true,
        command: typeof body.command === "string" ? body.command : undefined,
        network: body.network === true,
        sensitive: body.sensitive === true,
        origin: body.origin === "ai" ? "ai" : "human",
      };
      return evaluatePolicy(request, app.policyConfig());
    }

    throw purgeError("not_found", `no route for ${method} ${url.pathname}`);
  }

  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(staticDir, rel);
    if (!file.startsWith(path.resolve(staticDir))) throw purgeError("policy_denied", "path traversal blocked");
    let data: Buffer;
    try {
      data = await fsp.readFile(file);
    } catch {
      if (rel !== "index.html") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      throw purgeError("not_found", "ui assets missing");
    }
    const type = rel.endsWith(".html")
      ? "text/html; charset=utf-8"
      : rel.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : rel.endsWith(".css")
          ? "text/css; charset=utf-8"
          : rel.endsWith(".svg")
            ? "image/svg+xml"
            : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(data);
  }

  async function listen(): Promise<string> {
    await app.start();
    const port = opts.port ?? app.services.config.get().port;
    const host = opts.host ?? app.services.config.get().host;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    return `http://${host}:${actualPort}`;
  }

  async function close(): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.stop();
  }

  return { server, url: "", listen, close };
}

/** 解析 pack 的作用基目录：只支持已解包宿主（v0.1 不做归档换包）。 */
async function resolveBaseRoot(s: PurgeApp["services"], hostId: string): Promise<{ root: string; version: string }> {
  if (!hostId) throw purgeError("invalid_argument", "hostId is required");
  const facts = await s.registry.inspect(hostId, true);
  if (!facts.unpacked.exists) {
    throw purgeError("unsupported", "宿主未解包；v0.1 不对归档做就地修改", {
      hostId,
      shape: facts.shape,
      hint: "先由宿主自身解包，或等待 v0.3 的换包能力",
    });
  }
  return { root: facts.unpacked.path, version: facts.identity.version };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      // 继续排空剩余字节（不保存），这样才能把 400 真正回给调用方。
      overflow = true;
      continue;
    }
    chunks.push(buf);
  }
  if (overflow) throw new PurgeError({ code: "invalid_argument", message: `body too large (>${maxBytes})` });
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw purgeError("invalid_argument", "body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof PurgeError) throw err;
    throw purgeError("invalid_argument", `invalid json body: ${(err as Error).message}`);
  }
}
