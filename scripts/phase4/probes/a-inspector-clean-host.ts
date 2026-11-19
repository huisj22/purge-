/**
 * Phase 4 探针 A：干净（未打补丁）的解包宿主是否被误判为「未登记的宿主修改」。
 * 只读：在临时目录构造宿主，不触碰真实安装。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DshHostAdapter } from "../../../src/adapters/dsh.ts";
import { evaluateRules } from "../../../src/inspector/rules.ts";
import { writeAsar } from "../../../tests/helpers/fixtures.ts";

const root = await mkdtemp(path.join(tmpdir(), "p4-probe-inspector-"));
try {
  const resources = path.join(root, "resources");
  const app = path.join(resources, "app");
  const home = path.join(root, "home");
  await mkdir(path.join(app, "lib"), { recursive: true });
  await mkdir(path.join(home, "profiles", "desktop"), { recursive: true });
  const pkg = JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: "0.2.2-rc.5", main: "lib/main.js" });
  // 先写 asar（mtime 较旧）
  await writeAsar(path.join(resources, "app.asar"), { "package.json": Buffer.from(pkg) });
  await new Promise((r) => setTimeout(r, 50));
  // 再「解包」：app/ 下所有文件 mtime 都比 asar 新（模拟真实解包后果）
  await writeFile(path.join(app, "package.json"), pkg);
  await writeFile(path.join(app, "lib", "main.js"), "// clean unpacked entry, no patch markers\n");
  await writeFile(
    path.join(home, "profiles", "desktop", "package.json"),
    JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }),
  );

  const adapter = new DshHostAdapter({ extraRoots: [resources], dshHome: home, includeDefaults: false, skipProcessProbe: true });
  const [candidate] = await adapter.discover();
  const facts = await adapter.inspect(candidate as never);
  const findings = evaluateRules(facts);
  const traceable = findings.find((f) => f.ruleId === "modification.traceable");

  console.log(
    JSON.stringify(
      {
        shape: facts.shape,
        markerHits: facts.modification.markerHits.length,
        packs: facts.modification.packs.length,
        looksModified: facts.modification.looksModified,
        verdict: traceable?.status,
        verdictText: traceable?.rootCause?.text,
        severity: traceable?.severity,
        allRuleStatuses: findings.map((f) => `${f.ruleId}=${f.status}`),
      },
      null,
      2,
    ),
  );
  const falsePositive = traceable?.status === "fail" && facts.modification.markerHits.length === 0;
  console.log(`\nPROBE_RESULT=${falsePositive ? "FALSE_POSITIVE_CONFIRMED" : "no-false-positive"}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
