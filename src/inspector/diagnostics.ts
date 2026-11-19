/**
 * 诊断服务：DISCOVER → ANALYZE → DIAGNOSE → REPORT。
 *
 * 产物全部落库（finding 表）并进 trace；报告级别由词表决定，
 * 只有「确认故障」才 broken，「证据不足」只能是 unknown。
 */
import { randomUUID } from "node:crypto";
import type { EventBus } from "../core/events.ts";
import { EVENTS } from "../core/events.ts";
import { asPurgeError, purgeError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type { HostRegistry } from "../registry/registry.ts";
import type { AuditLog } from "../storage/audit.ts";
import type { Database } from "../storage/database.ts";
import type { MetricStore, TraceStore } from "../storage/trace.ts";
import { evaluateRules } from "./rules.ts";
import { levelFromFindings, type DiagnosticReport, type Finding } from "./types.ts";

export interface DiagnosticsOptions {
  registry: HostRegistry;
  db: Database;
  audit: AuditLog;
  traces: TraceStore;
  metrics: MetricStore;
  logger: Logger;
  bus: EventBus;
}

export class DiagnosticsService {
  readonly #o: DiagnosticsOptions;

  constructor(opts: DiagnosticsOptions) {
    this.#o = opts;
  }

  async run(hostId: string): Promise<DiagnosticReport> {
    const span = this.#o.traces.startSpan("diagnostic.run", { service: "inspector", attrs: { hostId } });
    const started = Date.now();
    try {
      const facts = await this.#o.registry.inspect(hostId, true);
      const ruleSpan = this.#o.traces.startSpan("diagnostic.rules", {
        traceId: span.traceId,
        parentId: span.spanId,
        service: "inspector",
      });
      const findings = evaluateRules(facts);
      ruleSpan.end("ok", { rules: findings.length });
      const level = levelFromFindings(findings);
      const report: DiagnosticReport = {
        reportId: `diag-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
        hostId,
        hostLabel: `${facts.identity.product}@${facts.identity.version}`,
        level,
        host: {
          product: facts.identity.product,
          version: facts.identity.version,
          confidence: facts.identity.confidence,
          shape: facts.shape,
          loadedShape: facts.loadedShape,
          running: facts.process.running,
        },
        findings,
        summary: summarize(findings),
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      };
      this.#persist(report);
      this.#o.metrics.record("diagnostic.duration_ms", report.durationMs, { level });
      this.#o.metrics.record("diagnostic.findings", findings.length, { level });
      this.#o.audit.append({
        actor: "inspector",
        action: "diagnostic.run",
        target: `host:${hostId}`,
        risk: 0,
        detail: { reportId: report.reportId, level, findings: findings.length },
      });
      this.#o.bus.emit(EVENTS.diagnosticCompleted, { reportId: report.reportId, hostId, level });
      span.end("ok", { level, findings: findings.length });
      this.#o.logger.info("diagnostic completed", { hostId, level, findings: findings.length });
      return report;
    } catch (err) {
      const e = asPurgeError(err);
      span.end("error", { code: e.code, message: e.message });
      throw e;
    }
  }

  async runAll(): Promise<DiagnosticReport[]> {
    const hosts = await this.#o.registry.discover();
    const reports: DiagnosticReport[] = [];
    for (const host of hosts) {
      try {
        reports.push(await this.run(host.id));
      } catch (err) {
        this.#o.logger.warn("diagnostic failed for host", { host: host.id, error: asPurgeError(err).message });
      }
    }
    return reports;
  }

  findingsFor(reportId: string): Finding[] {
    const rows = this.#o.db.raw
      .prepare("SELECT rule_id,severity,status,title,evidence,remediation FROM finding WHERE run_id=? ORDER BY rowid")
      .all(reportId) as unknown as Array<{
      rule_id: string;
      severity: string;
      status: string;
      title: string;
      evidence: string;
      remediation: string | null;
    }>;
    return rows.map((r) => {
      const finding: Finding = {
        id: r.rule_id,
        ruleId: r.rule_id,
        title: r.title,
        severity: r.severity as Finding["severity"],
        status: r.status as Finding["status"],
        evidence: JSON.parse(r.evidence),
      };
      if (r.remediation) finding.remediation = JSON.parse(r.remediation);
      return finding;
    });
  }

  recentReports(limit = 20): Array<{ reportId: string; hostId: string; level: string; findings: number; at: string }> {
    const rows = this.#o.db.raw
      .prepare(
        `SELECT run_id, ref, state, started_ms, result FROM run WHERE kind='diagnostic' ORDER BY started_ms DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 200))) as unknown as Array<{
      run_id: string;
      ref: string;
      state: string;
      started_ms: number;
      result: string | null;
    }>;
    return rows.map((r) => {
      const parsed = r.result ? (JSON.parse(r.result) as { findings?: number }) : {};
      return {
        reportId: r.run_id,
        hostId: r.ref,
        level: r.state,
        findings: parsed.findings ?? 0,
        at: new Date(Number(r.started_ms)).toISOString(),
      };
    });
  }

  #persist(report: DiagnosticReport): void {
    const stmt = this.#o.db.raw.prepare(
      "INSERT INTO finding(finding_id,run_id,rule_id,severity,status,title,evidence,remediation,created_ms) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    const now = Date.now();
    for (const f of report.findings) {
      stmt.run(
        `${report.reportId}:${f.ruleId}`,
        report.reportId,
        f.ruleId,
        f.severity,
        f.status,
        f.title,
        JSON.stringify(f.evidence),
        f.remediation ? JSON.stringify(f.remediation) : null,
        now,
      );
    }
    this.#o.db.raw
      .prepare("INSERT OR REPLACE INTO run(run_id,kind,ref,state,started_ms,ended_ms,result,error) VALUES(?,?,?,?,?,?,?,NULL)")
      .run(
        report.reportId,
        "diagnostic",
        report.hostId,
        report.level,
        Date.parse(report.generatedAt),
        Date.parse(report.generatedAt) + report.durationMs,
        JSON.stringify({ findings: report.findings.length, summary: report.summary }),
      );
  }
}

function summarize(findings: Finding[]): DiagnosticReport["summary"] {
  const count = (s: Finding["status"]): number => findings.filter((f) => f.status === s).length;
  return {
    total: findings.length,
    pass: count("pass"),
    warn: count("warn"),
    fail: count("fail"),
    unknown: count("unknown"),
    notApplicable: count("not_applicable"),
  };
}

export function assertHostId(id: string): string {
  if (!/^[a-z0-9@._:-]+$/i.test(id)) throw purgeError("invalid_argument", `invalid host id: ${id}`);
  return id;
}
