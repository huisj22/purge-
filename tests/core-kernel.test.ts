import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PurgeError } from "../src/core/errors.ts";
import { EventBus } from "../src/core/events.ts";
import { Kernel } from "../src/core/kernel.ts";
import { createLogger } from "../src/core/logger.ts";

describe("kernel lifecycle", () => {
  it("starts and stops services in registration order", async () => {
    const order: string[] = [];
    const k = new Kernel({ logger: createLogger({ sink: () => {} }) });
    k.register("a", () => ({ id: "a", start: () => void order.push("start:a"), stop: () => void order.push("stop:a") }));
    k.register("b", () => ({ id: "b", start: () => void order.push("start:b"), stop: () => void order.push("stop:b") }));
    await k.start();
    assert.deepEqual(order, ["start:a", "start:b"]);
    await k.stop();
    assert.deepEqual(order, ["start:a", "start:b", "stop:b", "stop:a"]);
  });

  it("start is idempotent", async () => {
    let starts = 0;
    const k = new Kernel({ logger: createLogger({ sink: () => {} }) });
    k.register("a", () => ({ id: "a", start: () => void (starts += 1) }));
    const [p1, p2] = [k.start(), k.start()];
    assert.equal(p1, p2);
    await p1;
    assert.equal(starts, 1);
  });

  it("rolls back already-started services when one fails", async () => {
    const stopped: string[] = [];
    const k = new Kernel({ logger: createLogger({ sink: () => {} }) });
    k.register("a", () => ({ id: "a", start: () => {}, stop: () => void stopped.push("a") }));
    k.register("boom", () => ({
      id: "boom",
      start: () => {
        throw new Error("nope");
      },
    }));
    await assert.rejects(() => k.start(), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "service_failed");
      assert.equal((err.detail as { id: string }).id, "boom");
      return true;
    });
    assert.deepEqual(stopped, ["a"]);
    assert.equal(k.started, false);
  });

  it("reports a clear error for unknown services", () => {
    const k = new Kernel({ logger: createLogger({ sink: () => {} }) });
    assert.throws(() => k.get("missing"), (err: unknown) => {
      assert.ok(err instanceof PurgeError);
      assert.equal(err.code, "service_not_found");
      return true;
    });
  });

  it("isolates listener failures inside the event bus", () => {
    const errors: string[] = [];
    const bus = new EventBus({ onListenerError: (event) => errors.push(event) });
    let sawSecond = false;
    bus.on("x", () => {
      throw new Error("listener boom");
    });
    bus.on("x", () => {
      sawSecond = true;
    });
    const delivered = bus.emit("x", {});
    assert.equal(delivered, 1);
    assert.equal(sawSecond, true);
    assert.deepEqual(errors, ["x"]);
  });

  it("supports once subscriptions and unsubscribe", () => {
    const bus = new EventBus();
    let n = 0;
    bus.once("y", () => (n += 1));
    bus.emit("y");
    bus.emit("y");
    assert.equal(n, 1);
    const off = bus.on("z", () => (n += 10));
    bus.emit("z");
    off();
    off();
    bus.emit("z");
    assert.equal(n, 11);
  });
});
