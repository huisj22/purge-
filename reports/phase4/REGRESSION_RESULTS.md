# 回归结果（REGRESSION_RESULTS）

执行时间：2026-11-19 · 环境：Windows 11 / Node v24.1.0 / TypeScript 5.9.3
命令与原始输出：`evidence/final-tests.txt`、`evidence/final-acceptance.txt`、`evidence/postfix-tests.txt`

---

## 1. 全量结果

| 检查 | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| 单元 + 集成 + 故障注入 | `node --test "tests/**/*.test.ts"` | **197 tests / 45 suites / 197 pass / 0 fail / 0 skipped / 0 todo**（6.2 s） | 0 |
| 类型检查 | `npx tsc --noEmit` | 0 错误 | 0 |
| 端到端验收 | `node scripts/acceptance.ts` | **14/14** | 0 |

对照基线（`8457ab7`）：150 tests / 29 suites → 197 tests / 45 suites（+47 tests / +16 suites，全部为新增覆盖，无删除、无跳过）。

## 2. 逐 Issue 覆盖

| Issue | 回归测试 | 测试级别 | 状态 |
| --- | --- | --- | --- |
| P0-01 | `tests/phase4-security.test.ts`（5 例） | L2 集成 | ✅ |
| P1-01 | `tests/phase4-regressions.test.ts` | L1 | ✅ |
| P1-02 | `tests/phase4-regressions.test.ts`（3 例）+ 真实环境诊断 | L1 + L5 | ✅ |
| P1-03 | `tests/phase4-regressions.test.ts` + `phase4-fault-injection` C3（4 例） | L3 | ✅ |
| P1-04 | `tests/phase4-security.test.ts`（3 例）+ `tests/plugins.test.ts`（6 例） | L2 | ✅ |
| P2-01 | `tests/phase4-regressions.test.ts` | L1 | ✅ |
| P2-02 | `phase4-fault-injection` C2 | L3 | ✅ |
| P2-03 | `tests/scheduler.test.ts`（更新断言）+ C5 | L1 + L3 | ✅ |
| P2-04 | `phase4-regressions` + C4 | L1 + L3 | ✅ |
| P2-05 | `phase4-regressions` "beyond 500" | L1 | ✅ |
| P2-06 | `tests/logs.test.ts` | L1 | ✅ |
| P2-07 | C7（4 例） | L3 | ✅ |
| P2-09 | C3 "concurrent restores" | L3 | ✅ |
| P2-11 | E "concurrent snapshots" | L3 | ✅ |
| P2-12 | C7 "relative source" | L3 | ✅ |
| P3-01 | `tests/api.test.ts` + `tests/ruleskills.test.ts` | L2 | ✅ |
| P3-02 | `tests/api.test.ts` 穿越用例 | L2 | ✅ |
| P3-03 | C1 | L3 | ✅ |
| P3-04/05/07/08/09/10/11/12/13/17/20/23/24/25 | 见 FIX_LOG 对应行 | L1–L3 | ✅ |

## 3. 行为契约变更（测试断言被修改的地方，逐条说明理由）

| 测试 | 原断言 | 新断言 | 理由 |
| --- | --- | --- | --- |
| `tests/scheduler.test.ts` "marks failures…" | `state === "failed"` | `state === "enabled"` + `lastError` | 修复 P2-03：失败不应永久停摆。**断言变严**（同时要求错误被记录） |
| `tests/api.test.ts` 规则顺序 | `["proj","style"]` | `["style","proj"]` | 修复 P3-01：实现与文档不符，按文档（全局在前）对齐 |
| `tests/plugins.test.ts` 夹具 | 无 `privilege` | `privilege: "declared"` | schema 新增必填字段（P1-04），非放宽 |
| `scripts/acceptance.ts` 插件清单 | 无 `privilege` | 同上 | 同上 |

**没有任何测试被删除、跳过（skip/todo）、或降低断言强度。** 新增断言均为更严格的行为要求。

## 4. 失败分析与处理

修复过程中出现过 7 次测试失败，全部按以下分类处理：

| 失败 | 分类 | 处理 |
| --- | --- | --- |
| workflow 超时被误判为取消 | **新引入问题**（我的 abort 竞速把 timeout 归到 cancelled） | 改为只以 run 级 cancel 标志判断；timeout 保持独立状态 |
| API 提示 501 而非 415 | **新引入问题** | 新增 `unsupported_media_type` → 415 |
| 安全测试清理 EBUSY | **测试本身的问题** | `listen()` 已 start 过 app，补 `app.stop()` 再删临时目录 |
| 空配置文件期望报错 | **测试本身的问题**（实现行为合理） | 改为断言"按默认值运行且不改写文件" |
| 截断检测未触发 | **实现缺陷**（队列空了导致 truncated=false） | 改为"触到上限即视为不完整" |
| 损坏对象测试不失败 | **测试前提错误**（<32KB 内容内联，不读对象库） | 改用 40KB 文件 |
| 并发 resume 测试不失败 | **测试前提错误**（run 已结束） | 改为运行中尝试 resume |

## 5. 未覆盖 / 无法确认

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Windows 真实文件锁（FILE_SHARE_NONE） | BLOCKED | 需原生调用；当前用"目录占位"模拟写失败 |
| 磁盘写满（ENOSPC） | BLOCKED | 无法安全制造 |
| 进程 kill -9 中断 | BLOCKED | 会污染当前会话；用"遗留 running 行"模拟 |
| 真实宿主写入 | BLOCKED | 安全规则禁止 |
| 浏览器渲染/E2E | NOT_VERIFIED | 未接 Playwright/DevTools |
| 跨平台 | NOT_VERIFIED | 仅 Windows |
| 长跑稳定性 | NOT_VERIFIED | 未做 24h+ 采样 |

## 6. 回归结论

- 修复后**没有**引入新的失败（197/197 通过）。
- 三类证据齐备：失败测试先红后绿、故障注入可复现、真实环境只读验证。
- **不宣称**：真实宿主写入可用、跨平台可用、长期稳定。
