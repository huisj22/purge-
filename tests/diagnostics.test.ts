import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { DshHostAdapter } from "../src/adapters/dsh.ts";
import { EventBus } from "../src/core/events.ts";
import { createLogger } from "../src/core/logger.ts";
import { DiagnosticsService } from "../src/inspector/diagnostics.ts";
import { HostRegistry } from "../src/registry/registry.ts";
import { AuditLog } from "../src/storage/audit.ts";
import { openMemoryDatabase } from "../src/storage/database.ts";
import { MetricStore, TraceStore } from "../src/storage/trace.ts";
import { makeFakeHost } from "./helpers/fixtures.ts";

async function buildFixture(base: string) {
  const db = openMemoryDatabase();
  const bus = new EventBus();
  const logger = createLogger({ sink: () => {} });
  const audit = new AuditLog(db);
  const traces = new TraceStore(db);
  const metrics = new MetricStore(db);
  const registry = new HostRegistry({ logger, bus });
  return { db, bus, logger, audit, traces, metrics, registry };
}

describe("host registry", () => {
  let base = "";
  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "purgeplus-reg-"));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("discovers, caches and invalidates host facts", async () => {
    const { registry } = await buildFixture(base);
    const host = await makeFakeHost(path.join(base, "reg1"), { markerFiles: 1 });
    registry.addAdapter(
      new DshHostAdapter({ extraRoots: [host.resources], dshHome: host.home, includeDefaults: false, skipProcessProbe: true }),
    );
    const found = await registry.discover();
    assert.equal(found.length, 1);
    const facts1 = await registry.inspect(found[0]?.id as string);
    const facts2 = await registry.inspect(found[0]?.id as string);
    assert.equal(facts1, facts2, "second inspect should hit cache");
    registry.invalidate();
    const facts3 = await registry.inspect(found[0]?.id as string);
    assert.notEqual(facts1, facts3);
    assert.throws(() => registry.get("nope"), /not found/);
  });

  it("rejects duplicate adapter ids", async () => {
    const { registry } = await buildFixture(base);
    registry.addAdapter(new DshHostAdapter({ includeDefaults: false, skipProcessProbe: true }));
    assert.throws(() => registry.addAdapter(new DshHostAdapter({ includeDefaults: false, skipProcessProbe: true })), /already registered/);
  });
});

describe("diagnostics", () => {
  let base = "";
  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "purgeplus-diag-"));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("flags an unmanaged modified host as broken with evidence", async () => {
    const ctx = await buildFixture(base);
    const host = await makeFakeHost(path.join(base, "modified"), { markerFiles: 2 });
    ctx.registry.addAdapter(
      new DshHostAdapter({ extraRoots: [host.resources], dshHome: host.home, includeDefaults: false, skipProcessProbe: true }),
    );
    const [candidate] = await ctx.registry.discover();
    const svc = new DiagnosticsService({
      registry: ctx.registry,
      db: ctx.db,
      audit: ctx.audit,
      traces: ctx.traces,
      metrics: ctx.metrics,
      logger: ctx.logger,
      bus: ctx.bus,
    });
    const report = await svc.run(candidate?.id as string);
    assert.equal(report.level, "broken");
    const traceFinding = report.findings.find((f) => f.ruleId === "modification.traceable");
    assert.equal(traceFinding?.status, "fail");
    assert.ok(traceFinding?.remediation);
    assert.equal(ctx.audit.verify().ok, true);
    const stored = svc.findingsFor(report.reportId);
    assert.equal(stored.length, report.findings.length);
    const recent = svc.recentReports();
    assert.equal(recent[0]?.reportId, report.reportId);
    assert.equal(recent[0]?.level, "broken");
    assert.equal(recent[0]?.hostId, candidate?.id);
    ctx.db.close();
  });

  it("reports a known legacy pack as warn, not fail", async () => {
    const ctx = await buildFixture(base);
    const host = await makeFakeHost(path.join(base, "legacy"), {
      markerFiles: 1,
      legacyApplied: { version: "1.6.91", at: "2026-01-01T00:00:00Z" },
      profile: { name: "desktop", dependencies: { "dsh-purge-community": "file:1.6.91.tgz" }, bundles: ["dsh-purge-community"] },
    });
    ctx.registry.addAdapter(
      new DshHostAdapter({ extraRoots: [host.resources], dshHome: host.home, includeDefaults: false, skipProcessProbe: true }),
    );
    const [candidate] = await ctx.registry.discover();
    const svc = new DiagnosticsService({
      registry: ctx.registry,
      db: ctx.db,
      audit: ctx.audit,
      traces: ctx.traces,
      metrics: ctx.metrics,
      logger: ctx.logger,
      bus: ctx.bus,
    });
    const report = await svc.run(candidate?.id as string);
    const traceable = report.findings.find((f) => f.ruleId === "modification.traceable");
    assert.equal(traceable?.status, "warn");
    const versionRule = report.findings.find((f) => f.ruleId === "modification.legacy_pack_version");
    assert.equal(versionRule?.status, "pass");
    const bundleRule = report.findings.find((f) => f.ruleId === "profile.bundle_declared");
    assert.equal(bundleRule?.status, "pass");
    // 进程探测被禁用 → 进程层 unknown，整体级别必须是 unknown 而不是 ok/warn
    assert.equal(report.findings.find((f) => f.ruleId === "process.probe")?.status, "unknown");
    assert.equal(report.level, "unknown");
    ctx.db.close();
  });

  it("stays unknown for a clean sealed host with no process evidence", async () => {
    const ctx = await buildFixture(base);
    const host = await makeFakeHost(path.join(base, "sealed"), { unpacked: false });
    ctx.registry.addAdapter(
      new DshHostAdapter({ extraRoots: [host.resources], dshHome: host.home, includeDefaults: false, skipProcessProbe: true }),
    );
    const [candidate] = await ctx.registry.discover();
    const svc = new DiagnosticsService({
      registry: ctx.registry,
      db: ctx.db,
      audit: ctx.audit,
      traces: ctx.traces,
      metrics: ctx.metrics,
      logger: ctx.logger,
      bus: ctx.bus,
    });
    const report = await svc.run(candidate?.id as string);
    assert.equal(report.host.shape, "sealed");
    assert.equal(report.host.loadedShape, "unknown");
    assert.ok(["unknown", "warn"].includes(report.level), `level was ${report.level}`);
    // 「未解包」不能被判成故障
    assert.equal(report.findings.find((f) => f.ruleId === "layout.dual_shape"), undefined);
    ctx.db.close();
  });

  it("detects a bundle that is enabled but not declared as a dependency", async () => {
    const ctx = await buildFixture(base);
    const host = await makeFakeHost(path.join(base, "bundle"), {
      markerFiles: 0,
      profile: { name: "desktop", dependencies: {}, bundles: ["dsh-purge-community"] },
    });
    ctx.registry.addAdapter(
      new DshHostAdapter({ extraRoots: [host.resources], dshHome: host.home, includeDefaults: false, skipProcessProbe: true }),
    );
    const [candidate] = await ctx.registry.discover();
    const svc = new DiagnosticsService({
      registry: ctx.registry,
      db: ctx.db,
      audit: ctx.audit,
      traces: ctx.traces,
      metrics: ctx.metrics,
      logger: ctx.logger,
      bus: ctx.bus,
    });
    const report = await svc.run(candidate?.id as string);
    const rule = report.findings.find((f) => f.ruleId === "profile.bundle_declared");
    assert.equal(rule?.status, "fail");
    assert.match(rule?.rootCause?.text ?? "", /缺少依赖/);
    ctx.db.close();
  });
});
