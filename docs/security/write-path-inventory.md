# 写入口清单（WRITE PATH INVENTORY）

Phase 5.5 · T055-01 · 审计时间：2026-11-19
代码实测：`src/**/*.ts` 中所有 `writeFile / atomicWriteFile / mkdir / rm / rename / INSERT / DELETE / UPDATE`

状态定义：
- `COMPLETE`：跨进程保护 + 原子性/事务 + 有对应测试
- `PARTIAL`：有保护但存在明确缺口（缺口写在"备注"）
- `NOT_COVERED`：无跨进程保护（原因与风险见备注；按任务要求不得静默）
- `BOUNDARY`：属于"外部进程/外部机器直接改文件"，本地锁无法覆盖 → 已写入风险登记

---

## A. 已闭合（本阶段新增或加固）

| ID | 模块 | 文件 | 函数 | 入口 | 写入对象 | 并发保护 | 原子性 | 审计 | 测试 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W-01 | Config Center | `configcenter/managed.ts` | `#commitLocked` | CLI/API/外部调用 | 受管文件 + `managed-history/*` | global → config | ✅ temp+rename | 历史快照（内容寻址） | `configcenter.test.ts`、`lock.test.ts` | COMPLETE |
| W-02 | Self Config | `core/config.ts` | `#updateLocked` | CLI/API | `config.json` | global → setting | ✅ | ❌（P3-34） | `config.test.ts`、`write-path-locks.test.ts` | COMPLETE（审计缺失另记） |
| W-03 | Rules | `ruleskills/rules.ts` | `create/update/remove` | CLI/API | `rules/<id>.json` | global → rules | ✅ | ❌（P3-34） | `write-path-locks.test.ts` | COMPLETE |
| W-04 | Skills | `ruleskills/skills.ts` | `#importLocked` / `#removeLocked` | CLI/API | `skills/<name>/**` | global → skills | ✅ staging→rename | ❌（P3-34） | `write-path-locks.test.ts` | COMPLETE |
| W-05 | Audit Append | `storage/audit.ts` | `append` | 全部服务 | `audit` 表 | `BEGIN IMMEDIATE`（SQLite） | ✅ 事务 | 自身 | `storage.test.ts`、`write-path-locks.test.ts` | COMPLETE |
| W-06 | **Audit Prune** | `storage/audit.ts` | `prune` | CLI/维护任务 | `audit` + `audit_checkpoint` | `BEGIN IMMEDIATE` | ✅ 事务 | ✅ 写 `audit.prune` 事件 | `write-path-closure.test.ts`（3 例） | COMPLETE（**新增**） |
| W-07 | Snapshot Capture | `recovery/snapshot.ts` | `#captureLocked` | CLI/API/事务 | `objects/**` + `snapshot` 表 | global → snapshot | ✅ + 写后自检 | ❌ | `recovery.test.ts`、`lock.test.ts` | COMPLETE |
| W-08 | Snapshot Restore | 同上 | `restore` | CLI/API | 目标文件 | global → snapshot | ✅ + 回滚 + TOCTOU | ❌（返回结果即证据） | `recovery-conflict.test.ts` | COMPLETE |
| W-09 | **Snapshot GC** | 同上 | `prune` → `#pruneLocked` | CLI/维护 | `objects/**` | global → snapshot（**新增**） | ✅（先改名后删） | ❌ | `write-path-closure.test.ts` | COMPLETE（**新增**） |
| W-10 | Pack Import | `packs/store.ts` | `#importPackLocked` | CLI/API | `packs/<id>@<ver>.json` + `index.json` | global → packs（**新增**，waitMs 5s） | ✅ | ❌（P3-34） | `write-path-closure.test.ts`（3 进程并发） | COMPLETE（**新增**） |
| W-11 | Pack Apply/Revert | `packs/engine.ts` | `#applyLocked` / `revert` | CLI/API | 目标文件 | global → pack | ✅ 事务 | ✅ 事务记录 | `packs.test.ts` | COMPLETE |
| W-12 | Plugin Install/Remove | `plugins/host.ts` | `#installLocked` / `#removeLocked` | CLI/API | `plugins/<name>@<ver>/**`、`plugin-state.json` | global → plugin | 部分（目录复制后 rename） | ❌ | `plugins.test.ts` | COMPLETE |
| W-13 | **Plugin Enable/Disable** | `plugins/host.ts` | `#enableLocked` / `#disableLocked` | CLI/API | `plugin-state.json` | global → plugin（**新增**，waitMs 5s） | ✅ | ❌ | `write-path-closure.test.ts` | COMPLETE（**新增**） |
| W-14 | Update Stage | `update/service.ts` | `stage` | CLI/API | `update/staging/*` | ❌（staging 名唯一，冲突风险低） | ✅ | ❌ | `update.test.ts` | PARTIAL |
| W-15 | Update Activate | 同上 | `#activateLocked` | CLI/API | `versions/*` + `state.json` | global → update | ✅ 两段 rename | ❌ | `update.test.ts` | COMPLETE |
| W-16 | **Update Prune** | 同上 | `#pruneLocked` | CLI/维护 | `versions/*` | global → update（**新增**） | ✅ removeTreeNoFollow | ❌ | `write-path-closure.test.ts` | COMPLETE（**新增**） |
| W-17 | Installer | `installer/installer.ts` | `install` / `uninstall` | CLI | 安装目录 + 状态文件 | `<parent>/locks/install.lock` | ✅ 备份→rename→验证 | 状态机日志 | `installer.test.ts` | COMPLETE |
| W-18 | Transaction | `recovery/transaction.ts` | `begin/write/commit/rollback` | 内部 | 目标文件 + 快照 | 经 snapshot 锁 | ✅ | ✅ | `recovery.test.ts` | COMPLETE |

## B. 未闭合（明确记录）

| ID | 模块 | 文件 | 写入点 | 原因 | 风险 | 处置 |
| --- | --- | --- | --- | --- | --- | --- |
| W-19 | Logs | `storage/logs.ts` | `append` / `prune`（`DELETE ... LIMIT`） | 日志是高频热路径，加全局锁会拖慢所有请求 | P3：并发写只会插入更多日志；prune 可能删掉刚写入的日志（可接受） | 记录为可接受风险；prune 保留量足够大 |
| W-20 | Trace/Metric | `storage/trace.ts` | `start/end/metric` | 同上 | P3：UPDATE 可能被覆盖（同一 span 只由创建者写） | 可接受 |
| W-21 | Snapshot self-cleanup | `recovery/snapshot.ts` | `DELETE FROM snapshot`（自检失败时） | 发生在 capture 锁内 | 无 | 已被 W-07 覆盖 |
| W-22 | Scheduler | `scheduler/scheduler.ts` | job 状态（INSERT/DELETE/UPDATE） | SQLite 单写者语义 + 无锁 | P2：多进程同时 tick 可能重复执行同一 job | 见 T055-01 备注：需 lease 机制，列入 Phase 6 |
| W-23 | Workflow | `workflow/engine.ts` | run/step 状态 | 同上 | P2：并发 resume 可能重复写状态 | 同上 |
| W-24 | Diagnostics | `inspector/diagnostics.ts` | `INSERT OR REPLACE INTO run` | 同上 | P3：报告互相覆盖 | 可接受 |
| W-25 | **Policy Store** | `security/policy-store.ts` | `#persist` | —— | **P1：无锁、无版本 CAS、无写后复读** | **T055-02 处理** |
| W-26 | **Plugin private data** | `plugins/host.ts` | `<plugin>/.data/store.json` | 数据在版本目录内、无边界校验 | **P1/P2** | **T055-03 处理** |
| W-27 | 外部编辑器 / 外部进程 | —— | 任意文件 | 本地文件锁无法约束不遵守协议的进程 | P2（系统边界） | 已写入风险登记，不假装已解决 |
| W-28 | 跨机器 / 网络文件系统 | —— | 任意文件 | 单机锁语义；SMB/NFS 上的 rename 原子性未验证 | P2（系统边界） | 同上 |

## C. 汇总

| 分类 | 数量 |
| --- | --- |
| 已闭合（COMPLETE） | 16 |
| PARTIAL | 1（W-14 update stage） |
| NOT_COVERED（含待 T055-02/03 处理） | 4（W-22/23/25/26，其中 W-22/23 列入 Phase 6） |
| BOUNDARY（本地锁无法覆盖，已登记） | 2（W-27/28） |
| 本阶段新增保护 | 6（W-06/09/10/13/16 + 锁语义修复） |

## D. 调用链结论

- CLI / API / 后台任务都通过 service 访问写入口（`cli/main.ts`、`api/server.ts`、`app.ts` 中**没有**直接 `writeFile`）；不存在绕过 service 的直写。
- 外层加锁 + 内层再次加锁的路径已验证可重入（`pack.apply → snapshot.capture`、`snapshot.restore → capture`），不会自死锁（`lock.test.ts` Case F + `write-path-closure.test.ts` GC 用例）。
- `withWriteGuard` 对高频写入口使用**有界等待**（waitMs 5s），低层维护操作保持快速失败（conflict），二者语义在测试中分别覆盖。
