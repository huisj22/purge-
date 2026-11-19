import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuditLog, GENESIS_HASH, computeAuditHash } from "../src/storage/audit.ts";
import { openMemoryDatabase } from "../src/storage/database.ts";
import { MetricStore, TraceStore } from "../src/storage/trace.ts";

describe("audit hash chain", () => {
  it("appends a verifiable chain", () => {
    const db = openMemoryDatabase();
    const audit = new AuditLog(db);
    const a = audit.append({ actor: "cli", action: "diagnostic.run", target: "host:dsh", risk: 5, detail: { rules: 12 } });
    const b = audit.append({ actor: "cli", action: "pack.apply", target: "pack:x", risk: 60 });
    assert.equal(a.seq, 1);
    assert.equal(a.prevHash, GENESIS_HASH);
    assert.equal(b.prevHash, a.hash);
    const v = audit.verify();
    assert.equal(v.ok, true);
    assert.equal(v.checked, 2);
    db.close();
  });

  it("detects tampering", () => {
    const db = openMemoryDatabase();
    const audit = new AuditLog(db);
    audit.append({ actor: "cli", action: "a", risk: 0 });
    audit.append({ actor: "cli", action: "b", risk: 0 });
    db.raw.prepare("UPDATE audit SET action='tampered' WHERE seq=1").run();
    const v = audit.verify();
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 1);
    db.close();
  });

  it("detects sequence gaps", () => {
    const db = openMemoryDatabase();
    const audit = new AuditLog(db);
    audit.append({ actor: "cli", action: "a" });
    audit.append({ actor: "cli", action: "b" });
    db.raw.prepare("DELETE FROM audit WHERE seq=1").run();
    const v = audit.verify();
    assert.equal(v.ok, false);
    db.close();
  });

  it("redacts secrets before persisting", () => {
    const db = openMemoryDatabase();
    const audit = new AuditLog(db);
    audit.append({ actor: "cli", action: "config.set", detail: { token: "ghp_abcdefghijklmnop", nested: { password: "hunter2" } } });
    const row = db.raw.prepare("SELECT detail FROM audit WHERE seq=1").get() as { detail: string };
    assert.ok(!row.detail.includes("ghp_abcdefghijklmnop"));
    assert.ok(!row.detail.includes("hunter2"));
    assert.ok(row.detail.includes("[redacted]"));
    db.close();
  });

  it("hash is sensitive to every field", () => {
    const base = { prevHash: GENESIS_HASH, seq: 1, ts: "t", actor: "a", action: "b", target: null, risk: 0, detail: null };
    const h1 = computeAuditHash(base);
    const h2 = computeAuditHash({ ...base, risk: 1 });
    assert.notEqual(h1, h2);
  });
});

describe("trace store", () => {
  it("records spans and aggregates traces", () => {
    const db = openMemoryDatabase();
    const traces = new TraceStore(db);
    const root = traces.startSpan("diagnostic.run", { service: "inspector" });
    const child = traces.startSpan("rule.check", { traceId: root.traceId, parentId: root.spanId, service: "inspector" });
    child.end("ok", { rules: 3 });
    root.end("ok");
    const list = traces.listTraces();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.root, "diagnostic.run");
    assert.equal(list[0]?.spans, 2);
    assert.equal(list[0]?.status, "ok");
    const spans = traces.spansOf(root.traceId);
    assert.equal(spans.length, 2);
    assert.equal(spans[1]?.parentId, root.spanId);
    db.close();
  });

  it("marks traces with failed spans as error", () => {
    const db = openMemoryDatabase();
    const traces = new TraceStore(db);
    const s = traces.startSpan("x");
    s.end("error");
    assert.equal(traces.listTraces()[0]?.status, "error");
    db.close();
  });

  it("returns null stats for an empty metric window", () => {
    const db = openMemoryDatabase();
    const metrics = new MetricStore(db);
    assert.equal(metrics.stats("never.recorded"), null);
    metrics.record("run.duration", 12);
    metrics.record("run.duration", 30);
    const st = metrics.stats("run.duration");
    assert.equal(st?.count, 2);
    assert.equal(st?.max, 30);
    assert.equal(st?.min, 12);
    db.close();
  });
});
