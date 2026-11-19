# 修复记录（FIX_LOG）

原则：每一项都遵循 **复现 → 记录证据 → 让测试先失败 → 改代码 → 复测 → 回归**。
禁止用「加 try/catch 吞掉」「默认成功」「放宽策略」「降断言」来"修"。

---

## P0-01 · API 入口无身份/无来源校验

- **复现**：`scripts/phase4/probes/e-api-csrf.ts` → 200，port 7801→7802（`evidence/probe-e-csrf.txt`）
- **失败测试**：`tests/phase4-security.test.ts` → 415/403/绑定守卫/token 四例
- **改动**：
  - `src/core/config.ts`：新增 `apiToken`
  - `src/core/errors.ts`：新增 `unsupported_media_type`
  - `src/api/server.ts`：`checkAuth()`、`isSameOrigin()`、Content-Type 强制、`listen()` 绑定守卫
- **验证**：同一探针 → `blocked`（`evidence/probe-e-csrf-fixed.txt`）；5 例测试全绿
- **回归**：`tests/api.test.ts` 19 例（含既有 17 例）全部通过

## P1-01 · Kernel 启动失败后永久锁死

- **复现**：`probes/b-kernel-start-latch.ts` → attempts 恒为 1（`START_LATCH_CONFIRMED`）
- **失败测试**：`tests/phase4-regressions.test.ts` "retries the service on the next start() call"
- **改动**：`src/core/kernel.ts` — 失败分支 `this.#startPromise = null`，并加 `catch` 兜底清空
- **验证**：探针 → `retry-works`

## P1-02 · 干净解包宿主被判「未登记修改」

- **复现**：`probes/a-inspector-clean-host.ts` → `looksModified:true, verdict:fail`（`FALSE_POSITIVE_CONFIRMED`）
- **失败测试**：3 例（干净宿主 pass / 有标记 fail / 截断 unknown）
- **改动**：
  - `src/adapters/dsh.ts`：`looksModified` 改为「标记或修改包记录」；mtime 降级为提示字段 `mtimeNewerThanArchive`；新增 `scanTruncated`；`MARKER_SCAN_LIMIT` 可配
  - `src/adapters/types.ts`：footprint 增加 `scanTruncated` / `mtimeNewerThanArchive`
  - `src/inspector/rules.ts`：`modification.traceable` 支持 unknown；`disk_vs_loaded` 与 `dual_shape` 去重
- **验证**：探针 → `no-false-positive`；真实宿主诊断由 `BROKEN` 变为 `UNKNOWN`（含 2 条真实 warning）

## P1-03 · 恢复非事务

- **复现**：`probes/d-restore-partial.ts` → `restored=[a.txt], failed=[b.txt]`（`PARTIAL_RESTORE_CONFIRMED`）
- **失败测试**：`tests/phase4-regressions.test.ts` "rolls back to the pre-restore state…"
- **改动**：`src/recovery/snapshot.ts`
  - `restore()` 先拍 `pre-restore` 快照 → 应用 → 失败则用该快照回滚，返回 `rolledBack`
  - 新增 `RestoreResult` 类型（`rolledBack`/`preSnapshotId`/`rollbackFailed`）
  - `get()` 改为按 id 精确查询（P2-05）
  - `prune()` 引用集改为覆盖全部快照（P3-20）
  - `capture()` 末尾自检，失败即撤销该快照（P3-25）
  - `putObject()` 并发写同一对象改为幂等（P2-11）
- **验证**：探针 → `ROLLED_BACK`；4 例故障注入全绿；`Transaction.rollback` 复测通过

## P1-04 · 插件边界表述失真 + 无超时

- **复现**：`probes/hk-plugin-config.ts` → 零能力插件写任意文件（`NOT_A_SANDBOX_CONFIRMED`）
- **失败测试**：`tests/phase4-security.test.ts` 3 例（缺 privilege 拒绝 / host 特权需 trust / invoke 超时）
- **改动**：
  - `src/plugins/host.ts`：`privilege` 必填；`enable(name,{trusted})`；`invoke/health` 5s 超时
  - `src/api/server.ts`、`src/cli/main.ts`：把 `confirm/--yes` 映射为 `trusted`
  - `README.md`、`docs/ARCHITECTURE.md`：改为「能力声明（非沙箱）」
- **验证**：3 例全绿；探针仍显示 `NOT_A_SANDBOX`（**这是预期**：我们不再声称它是沙箱）

## P2-01 · 配置写失败后内存已改

- **复现**：`probes/hk-plugin-config.ts` K 段 → 内存 7999 / 磁盘未写（`MEMORY_DIVERGED_CONFIRMED`）
- **改动**：`src/core/config.ts` — 先校验、再写盘、最后切换内存态
- **验证**：探针 → `consistent`；回归测试通过

## P2-02 / P3-13 · 配置中心并发与历史原子性

- **复现**：`probes/c-config-lost-update.ts` → 竞争时报 `integrity_failed`，历史丢一条
- **改动**：`src/configcenter/managed.ts`
  - 按路径进程内串行锁 `#withLock`
  - 并发竞争统一报 `conflict`
  - 历史记录失败 → 回写提交前内容并抛 `unwritable`
- **验证**：故障注入 C2 "并发提交恰好一个成功" 通过；探针 → `guarded`

## P2-03 / P3-17 · 调度失败即停摆 / runNow 推进计划

- **复现**：`probes/fg-scheduler-workflow.ts` F2 段 → 10 个周期 attempts 仍为 1
- **改动**：`src/scheduler/scheduler.ts`
  - 失败后保持 `enabled`，记录 `lastError`/`attempts`
  - `runNow` 不推进 `nextRunMs`（`advanceSchedule:false`）
- **验证**：F2 → `still-scheduled`；C5 三例全绿；原 scheduler 测试断言更新为"保持 enabled"（行为契约变更）

## P2-04 / P3-16 · 取消不中断 / 同 run 并发

- **复现**：探针 G → 1213 ms 才返回，`run=cancelled` 但 `step=succeeded`
- **改动**：`src/workflow/engine.ts`
  - `#controllers` 记录每步 AbortController，`cancel()` 统一 abort
  - 步骤与 abort 竞速（并尊重执行器忽略 signal 的情况：不再等待）
  - `#activeRuns` 互斥，同一 run 不允许并发 resume（`finally` 释放）
  - 新增 `recoverInterrupted()`；`RunState` 增加 `interrupted`
- **验证**：探针 G → 107 ms、`step=cancelled`；C4 五例全绿；`src/app.ts` 启动时调用恢复

## P2-05 / P2-06 / P2-07 / P2-11 / P2-12

| Issue | 改动 | 验证 |
| --- | --- | --- |
| P2-05 快照 500 条上限 | `SnapshotStore.get()` 改 SQL 精确查询 | C3/回归测试 |
| P2-06 每次 COUNT(*) | `LogStore` 内存计数 + 首次加载 | `tests/logs.test.ts` |
| P2-07 无超时/无备份 | `fetchTimeoutMs` + 同版本激活先改名备份 | C7 四例 |
| P2-11 并发对象写失败 | `putObject` 失败后校验既有对象（CAS 幂等） | E 并发快照 |
| P2-12 plan 绕过索引校验 | `plan()` 内 `validateIndex` | C7 "相对路径来源" |

## P3 批量修复

| Issue | 改动 | 验证 |
| --- | --- | --- |
| P3-01 规则顺序 | `compose()` 全局先、工作区后（组内 id 序） | `tests/api.test.ts` 顺序断言 + ruleskills |
| P3-02 静态前缀 | 加 `path.sep` 校验 | `tests/api.test.ts` 穿越用例 |
| P3-03 删除静默失败 | `removeTreeNoFollow` 抛 `unwritable` | 故障注入 C1 |
| P3-04 技能 O(n²) | 累加 `totalBytes` | ruleskills 全绿 |
| P3-05 发现无单飞 | `#discovering` Promise 复用 | registry 测试 |
| P3-07 重复告警 | `disk_vs_loaded` 在 `shape=both` 时返回 null | 真实诊断输出 |
| P3-08 死状态 | `recoverInterrupted()` + 启动调用 | C4 "遗留 running" |
| P3-09 日志无 traceId | 迁移 v4 增列 + logger 绑定 + API 过滤 | `tests/logs.test.ts` |
| P3-10 更新协议/清理 | 来源协议白名单 + `prune()` | C7 prune |
| P3-11 扫描截断 | `scanTruncated` → unknown | 回归测试 |
| P3-12 备份假阳性 | 规则改 `unknown` 并指向快照屏 | 真实诊断 |
| P3-23 CLI 帮助 | 明确 capture 语义 | 手工核对 |
| P3-24 配置无 UI | 新增「配置」屏（含策略预演） | UI 语法检查 + 手工 |

---

## 未修项（明示）

| Issue | 决定 | 理由 |
| --- | --- | --- |
| P2-08 恢复不比较新旧 | OPEN（文档化） | 恢复语义就是"回到快照"；自动判断"哪个更新"会引入歧义。已新增 pre-restore 快照作为安全网，建议 UI 增加二次确认 |
| P2-10 allowActions 自我解除 | OPEN | 需要设计"改策略"的更高确认等级，属于功能设计而非补丁 |
| P3-06 无注销语义 | DEFERRED | 无需求 |
| P3-14 技能依赖不可达性 | OPEN | 需要依赖图，超出本轮范围 |
| P3-15 步骤无幂等键 | OPEN | 需要业务层提供幂等键语义 |
| P3-18 无运行中取消 job | DEFERRED | 与 workflow 取消可复用同一机制，留待下阶段 |
| P3-19 metrics 无分组 | OPEN | 需要标签索引 |
| P3-22 无依赖图 | DEFERRED | Purge+ 自身零运行时依赖 |
