import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PurgeError } from "../src/core/errors.ts";
import { DEFAULT_POLICY, evaluatePolicy, guard } from "../src/security/policy.ts";

describe("policy risk scoring", () => {
  it("allows read-only actions", () => {
    const v = evaluatePolicy({ action: "host.inspect", target: "host:dsh" });
    assert.equal(v.decision, "allow");
    assert.equal(v.risk, 0);
  });

  it("requires confirmation for mutating actions", () => {
    const v = evaluatePolicy({ action: "config.set", paths: ["a.json"] });
    assert.equal(v.decision, "confirm");
    assert.ok(v.risk >= 30);
    assert.ok(v.factors.some((f) => f.code === "mutating_action"));
  });

  it("denies wide recursive destructive actions", () => {
    const v = evaluatePolicy({
      action: "files.delete",
      paths: Array.from({ length: 25 }, (_, i) => `p${i}`),
      recursive: true,
    });
    assert.equal(v.decision, "deny");
    assert.equal(v.risk, 100);
  });

  it("flags credential paths", () => {
    const v = evaluatePolicy({ action: "host.inspect", paths: ["/home/u/.ssh/id_rsa"] });
    assert.ok(v.factors.some((f) => f.code === "sensitive_path"));
    assert.equal(v.decision, "confirm");
  });

  it("never lowers risk for AI-originated requests", () => {
    const human = evaluatePolicy({ action: "config.set", paths: ["a"] });
    const ai = evaluatePolicy({ action: "config.set", paths: ["a"], origin: "ai" });
    assert.ok(ai.risk > human.risk);
    assert.ok(ai.factors.some((f) => f.code === "ai_origin"));
  });

  it("treats plugin and scheduler origins as higher risk", () => {
    const plugin = evaluatePolicy({ action: "pack.plan", origin: "plugin" });
    const sched = evaluatePolicy({ action: "pack.plan", origin: "scheduler" });
    assert.ok(plugin.risk > sched.risk);
  });

  it("deduplicates identical risk factors", () => {
    const v = evaluatePolicy({ action: "pack.apply", paths: ["a", "b", "c", "d", "e", "f"] });
    const codes = v.factors.map((f) => f.code);
    assert.equal(new Set(codes).size, codes.length);
  });

  it("honours allowlisted actions but keeps the risk visible", () => {
    const cfg = { ...DEFAULT_POLICY, allowActions: ["config.set"] };
    const v = evaluatePolicy({ action: "config.set", paths: ["a"] }, cfg);
    assert.equal(v.decision, "allow");
    assert.ok(v.factors.some((f) => f.code === "allowlisted"));
    assert.ok(v.risk > 0, "risk must still be reported for the audit trail");
  });

  it("respects custom thresholds", () => {
    const strict = { confirmThreshold: 10, denyThreshold: 45, allowActions: [] };
    const v = evaluatePolicy({ action: "pack.apply", paths: ["a"], origin: "ai" }, strict);
    assert.equal(v.risk, 50);
    assert.equal(v.decision, "deny");
  });
});

describe("policy guard", () => {
  it("throws policy_denied for denied actions", () => {
    assert.throws(
      () => guard({ action: "files.delete", paths: Array.from({ length: 30 }, (_, i) => `p${i}`), recursive: true }),
      (err: unknown) => {
        assert.ok(err instanceof PurgeError);
        assert.equal(err.code, "policy_denied");
        return true;
      },
    );
  });

  it("throws confirmation_required unless confirmed", () => {
    assert.throws(() => guard({ action: "config.set", paths: ["a"] }), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "confirmation_required");
      return true;
    });
    const v = guard({ action: "config.set", paths: ["a"] }, DEFAULT_POLICY, { confirmed: true });
    assert.equal(v.decision, "confirm");
  });

  it("forceConfirm blocks read-only actions when explicitly required", () => {
    assert.throws(() => guard({ action: "host.inspect" }, DEFAULT_POLICY, { forceConfirm: true }), /confirmation required/);
  });

  it("does not let confirmation override a deny", () => {
    assert.throws(
      () =>
        guard(
          { action: "files.delete", paths: Array.from({ length: 30 }, (_, i) => `p${i}`), recursive: true },
          DEFAULT_POLICY,
          { confirmed: true },
        ),
      (err: unknown) => {
        assert.ok(err instanceof PurgeError);
        assert.equal(err.code, "policy_denied");
        return true;
      },
    );
  });
});
