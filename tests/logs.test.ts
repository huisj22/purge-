import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogger } from "../src/core/logger.ts";
import { openMemoryDatabase } from "../src/storage/database.ts";
import { LogStore } from "../src/storage/logs.ts";

describe("log store", () => {
  it("persists records produced by the logger sink", () => {
    const db = openMemoryDatabase();
    const logs = new LogStore(db);
    const logger = createLogger({ level: "debug", sink: (rec) => logs.append(rec) });
    logger.info("hello", { a: 1 });
    logger.warn("careful");
    logger.error("boom", { token: "secret-value" });

    const rows = logs.query({ limit: 10 });
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.level, "error", "newest first");
    assert.equal(rows[2]?.msg, "hello");
    assert.equal(logs.stats().byLevel.info, 1);
    const raw = JSON.stringify(rows);
    assert.ok(!raw.includes("secret-value"), "secrets must be redacted before persisting");
    db.close();
  });

  it("filters by level and substring", () => {
    const db = openMemoryDatabase();
    const logs = new LogStore(db);
    logs.append({ ts: new Date().toISOString(), level: "info", msg: "diagnostic completed", ctx: { host: "dsh" } });
    logs.append({ ts: new Date().toISOString(), level: "error", msg: "pack failed", ctx: null });
    assert.equal(logs.query({ level: "error" }).length, 1);
    assert.equal(logs.query({ contains: "diagnostic" }).length, 1);
    assert.equal(logs.query({ contains: "dsh" }).length, 1, "ctx is searchable too");
    assert.equal(logs.query({}).length, 2);
    db.close();
  });

  it("prunes the oldest rows when over the cap and reports it", () => {
    const db = openMemoryDatabase();
    const logs = new LogStore(db, { maxRows: 100 });
    for (let i = 0; i < 130; i += 1) {
      logs.append({ ts: new Date(Date.now() + i).toISOString(), level: "info", msg: `row-${i}`, ctx: null });
    }
    const stats = logs.stats();
    assert.equal(stats.total, 100);
    assert.equal(stats.pruned, 30);
    const rows = logs.query({ limit: 5 });
    assert.equal(rows[0]?.msg, "row-129");
    db.close();
  });
});
