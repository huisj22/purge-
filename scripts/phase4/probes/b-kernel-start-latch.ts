/**
 * Phase 4 探针 B：Kernel 启动失败后是否永久锁死（不能重试）。
 * 只读：不构造任何服务副作用。
 */
import { Kernel } from "../../../src/core/kernel.ts";
import { createLogger } from "../../../src/core/logger.ts";

const k = new Kernel({ logger: createLogger({ sink: () => {} }) });
let attempts = 0;
k.register("flaky", () => ({
  id: "flaky",
  start: () => {
    attempts += 1;
    if (attempts === 1) throw new Error("first start fails");
  },
}));

let firstError = "";
try {
  await k.start();
} catch (err) {
  firstError = (err as Error).message;
}

let secondError = "";
let secondSucceeded = false;
try {
  await k.start();
  secondSucceeded = true;
} catch (err) {
  secondError = (err as Error).message;
}

console.log(
  JSON.stringify(
    {
      firstError,
      secondError,
      secondSucceeded,
      startAttempts: attempts,
      kernelStarted: k.started,
      note: "服务第二次应当被真正调用一次（attempts 变 2）；若仍为 1 且抛同一错误，说明 start() 被永久锁死",
    },
    null,
    2,
  ),
);
console.log(`\nPROBE_RESULT=${!secondSucceeded && attempts === 1 ? "START_LATCH_CONFIRMED" : "retry-works"}`);
