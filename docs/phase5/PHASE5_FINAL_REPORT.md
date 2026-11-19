# Phase 5 最终报告（PHASE5_FINAL_REPORT）

日期：2026-11-19 · 基线 `06b1701` · 分支 `main` · 未提交（按任务书 §10，未获授权不 Commit）

---

## A. Phase 5 是否真正完成？

**PARTIAL**。

- 五个任务（T-035 / T-037 / P2-08 / P2-10 / T-036）都已实现并通过测试；
- 但存在**明确未验证项**：Linux/macOS 实机、GitHub Actions 实跑、OS 级沙箱、双安装器竞争、真实 SIGKILL；
- 另有 4 项 P2 与 5 项 P3 未修（见 `REMAINING_RISK_REGISTER.md`）。

不写成 COMPLETE，是因为按原则五：测试通过 ≠ 真实可靠。

## B. T-035 Installer / CI

| 问题 | 回答 |
| --- | --- |
| Installer 是否完成？ | ✅ 完成（前置检查、状态机 12 相、幂等、后置验证、失败回滚、卸载保留数据） |
| CI 是否完成？ | 部分：本地 CI（`scripts/ci.mjs`）8/8 通过；GitHub Actions 文件已写但**未运行** |
| 支持哪些平台？ | 代码支持 win32/linux/darwin；**只有 Windows 11 x64 实机验证** |
| 哪些平台真实验证？ | 仅 Windows 11 |
| 安装失败可否恢复？ | ✅ 可（`ROLLBACK_COMPLETED` + 内容恢复，有测试）；回滚失败会明确报 `ROLLBACK_FAILED` |
| 重复安装是否测过？ | ✅ 幂等（无新备份、无重复状态；测试 + 实机各一次） |

## C. T-037 跨进程锁

| 问题 | 回答 |
| --- | --- |
| 是否真正跨进程？ | ✅ 是。原子原语 = 临时目录写元数据 + `rename` 占位；11 例真实子进程测试 |
| 哪些操作受保护？ | config.commit / snapshot.capture / snapshot.restore / plugin.install / plugin.remove / update.activate / pack.apply / installer.install |
| 是否有未保护入口？ | 有：规则/技能/自身配置写入、审计追加、`prune`（P2-13） |
| 真实子进程测试？ | ✅ Case A–G + 真实写路径 4 项 |
| 死锁风险？ | 层级固定 + 同进程重入 + 排队；Case F 实测无死锁。**未做**随机压测 |
| Stale 是否安全？ | ✅ 不盲目删除：先改名留痕（`reclaimed.json`），再占位；24h 以上不自动回收 |

## D. T-036 插件隔离

| 问题 | 回答 |
| --- | --- |
| 是否独立进程？ | ✅ `fork` + IPC；测试断言 pid 不同 |
| IPC 是否验证？ | ✅ schema 版本 / 类型白名单 / 1MB 上限 / id 关联；两端都校验 |
| Timeout 是否有效？ | ✅ 单次调用超时会 kill 子进程（300ms 注入 → TIMEOUT） |
| Crash 是否隔离？ | ✅ `process.exit(7)` → CRASHED，主进程存活 |
| OS Sandbox？ | ❌ 未实现 |
| 仍无限制的能力？ | 文件系统、网络、环境变量、子进程、CPU/内存 |

## E. Recovery

| 问题 | 回答 |
| --- | --- |
| 能检测当前数据变化？ | ✅ 逐文件 UNCHANGED/MODIFIED/NEWER/DELETED/UNKNOWN/CORRUPTED |
| 阻止冲突恢复？ | ✅ 默认 block，HTTP 409，文件不动 |
| 有 Force Restore？ | ✅ |
| Force 是否需授权？ | ✅ `authorizedBy` 必填，否则 `policy_denied` |
| 恢复前备份？ | ✅ 自动 pre-restore 快照，id 返回 |
| 是否 Verify？ | ✅ 写后回读哈希 + TOCTOU 复检 |
| 回滚可靠？ | 失败会回滚并验证；回滚失败明确报 `rolledBack=false` + 明细 |

## F. Policy

| 问题 | 回答 |
| --- | --- |
| Executor 能否自提权？ | ❌ 不能（`policy_denied`，有测试） |
| AI 能否自批准？ | ❌ 不能；且 L3+ 一律拒绝 |
| Plugin 能否自批准？ | ❌ 不能（无 PolicyStore 通道；能力由 Host 审批） |
| Policy 完整性？ | 版本 + 哈希；篡改 → `integrity_failed`，不降级 |
| 审计完整？ | 每次 grant/revoke 写审计链；**策略文件本身仍可被有权限者连同 hash 一起改**（P2-15） |

## G. 测试数字

| 项目 | 结果 |
| --- | --- |
| Baseline Tests | 197 / 45 suites / 0 fail（Phase 5 复跑确认） |
| Final Tests | **255 / 55 suites / 0 fail / 0 skip / 0 todo** |
| Suites | 55 |
| Failures | 0 |
| Skipped | 0 |
| TypeScript | `tsc --noEmit` 0 错误 |
| Lint | eslint 0 error（Phase 5 新建） |
| Build | 无构建（TS 直跑）；打包 `scripts/package.mjs` 通过 |
| Acceptance | 14/14（第 7 步已含冲突检测：plan→409→force） |
| Security | 安全相关用例 32（入口 5 + 策略 13 + 层级 10 + 插件 4） |
| Fault Injection | 68 例（Phase 4 的 29 + 新增 39）全部通过 |
| Cross-process | 11 例真实子进程 |
| Installer | 19 例 + 实机全链路 + 本地 CI 8/8 |

新增测试分布：installer 19、lock 11、recovery-conflict 9、policy-hierarchy 10、plugin-isolation 9 = **+58**（197 → 255）。

## H. Remaining Risk

详见 `docs/phase5/REMAINING_RISK_REGISTER.md`。摘要：

| 等级 | 已修 | 未修 | 阻塞/未验证 |
| --- | --- | --- | --- |
| P0 | 0（Phase 4 已清零） | 0 | 0 |
| P1 | 3（P1-05/06/07） | 0 | 0 |
| P2 | — | 4（规则/技能加锁、能力方法级、策略锁、插件可写数据目录） | 2（跨平台、GitHub CI） |
| P3 | — | 5 | 5 项 ACCEPTED |

## I. 成熟度（按证据）

| 模块 | 等级 | 依据 |
| --- | --- | --- |
| Core（kernel/config/logger/atomic/lock） | **M3** | 生命周期/配置一致性/原子写/跨进程锁均有故障注入 |
| Registry | M2 | 缓存/单飞/未知 id 测试；无并发压测 |
| Adapter（ASAR/DSH） | M4（只读） | 真实宿主识别与诊断；写入未验 |
| Inspector | M3 / M4 只读 | 规则三态 + 实机修正 |
| Config Center | M3 | 哈希守卫 + 并发串行化 + 跨进程锁 |
| Rules / Skills | M2 | 围栏与边界测试；未接跨进程锁 |
| Workflow | M3 | 并行/重试/超时/取消/恢复 |
| Scheduler | M3 | cron 边界 + 失败续跑 |
| Observability | M2 | trace/metrics/logs/traceId；无长跑数据 |
| Recovery | **M3+** | 冲突检测 + 事务 + 回滚验证；ENOSPC/崩溃未验 |
| Security（policy） | **M3** | 风险层 + 权限层 + 策略完整性 |
| Plugin | **M3（进程隔离）** | 独立进程 + IPC 校验 + 超时 + 崩溃隔离；非 OS 沙箱 |
| Update | M3 | 分阶段 + 摘要校验 + 备份 + prune |
| **Installer** | **M3（Windows）** | 状态机 + 幂等 + 回滚 + 后置验证；跨平台未验 |
| **CI** | **M1** | 本地 CI 真实运行；GitHub Actions 未跑 |
| UI | M2 | 13 屏真实数据；无浏览器自动化 |
| CLI | M3 | 退出码/确认/新命令实机 |
| API | M3 | 统一封装 + 鉴权 + 状态码 |

**整体：M2.5 → M3（单机 Windows 子集）**。交付链路从 M1 提升到 M3，但跨平台仍空白。

## J. 结论

**Phase 5 = PARTIAL（高完成度）**：五个任务的实现与测试都真实完成，核心不变量（Plan/Apply/Verify 分离、Unknown 不伪装、Capability≠Sandbox、Backup≠Safe Recovery、跨进程互斥、权限不自授）已落到代码与测试里；但跨平台、真实 CI、OS 沙箱与若干并发入口仍未验证/未接入，不得对外宣称"生产就绪"。

---

# 附：Phase 5 收尾轮（2026-11-19 晚）

授权范围：五批 Commit、隔离副本写入验证、P2-13、GitHub 推送与 CI。

## 1. 五批 Commit（按依赖顺序，均已单独验证可编译 + 测试通过）

| 顺序 | Hash | 内容 | 独立 worktree 验证 |
| --- | --- | --- | --- |
| 1 | `527136d` | T-037 跨进程锁 + 接线（含 host/worker 文件，原因见该 commit message） | tsc 0；34 tests 通过 |
| 2 | `fdc2a9f` | T-035 安装器 + 打包 + CI + lint | tsc 0；19 tests 通过 |
| 3 | `10267db` | P2-08 恢复冲突 + force 授权（api/cli/acceptance） | tsc 0；28 tests 通过 |
| 4 | `6ba28d9` | P2-10 权限层级 + app 集成 | tsc 0；37 tests 通过 |
| 5 | `544fc1a` | T-036 插件进程隔离 + 报告 | 全量 255 tests |
| 收尾 | `7ad9591` | 锁测试报告 + lint 修复 | — |

> 偏差说明（按要求声明，未破坏结构）：`snapshot.ts` / `api/server.ts` / `cli/main.ts` / `host.ts` 各自承载两个任务的内容；按"最早需要它的 commit"归属，后续 commit 在 message 中注明。

## 2. 隔离副本真实写入验证

**17/17 通过**（`docs/phase5/ISOLATED_HOST_WRITE_VERIFICATION.md`）：
副本与真实宿主 `app/` 树哈希一致（21788 文件 / 473MB）；pack apply → 快照 → 冲突阻止 → force 恢复 → 回滚全部只写副本；junction 不被跟随；安装/卸载在隔离目录完成。
**真实宿主 21,789 条记录前后逐条一致，asar SHA256 未变。**

## 3. P2-13 写入口锁

Rules / Skills / Self-Config 已接入 `withWriteGuard`；Audit 改为 `BEGIN IMMEDIATE` 事务化（修复了真实的 `UNIQUE constraint failed: audit.seq` 并发缺陷）。
6 个测试（真实子进程 + 3 进程并发审计）全部通过。
**仍为 PARTIAL**：`prune`、备份 GC、外部写入未覆盖。

## 4. GitHub 推送与 CI

**BLOCKED**：本机 `git remote -v` 为空，`git push` exit 128（无 remote、无凭据）。
本地已创建分支 `phase5/verification`（指向 `7ad9591`）。
Workflow 经 YAML 解析器验证有效、无 secrets、无部署步骤。
平台状态：`LOCAL_WINDOWS_11_VERIFIED` ✅；`GITHUB_WINDOWS/UBUNTU/MACOS_RUNNER_VERIFIED` 全部 **NOT_VERIFIED**（workflow 亦无 macOS job）。

## 5. 最新数字

| 项 | 值 |
| --- | --- |
| Tests | **261 / 56 suites / 0 fail / 0 skip** |
| TypeScript | 0 错误 |
| ESLint | 0 error |
| Acceptance | 14/14 |
| 本地 CI | 8/8 |
| 隔离写入 | 17/17 |
| 真实宿主哈希 | 未变（21789 条） |
| Commit | 6 个（5 任务 + 1 收尾） |

## 6. 结论

Phase 5 仍为 **PARTIAL**：五个任务的实现与验证完成，隔离写入首次得到真实证据；但 GitHub CI 与 macOS/Linux 平台验证被环境阻塞，T-037 对全部写入口的覆盖仍不完整。
---

# 附二：GitHub CI 打通（2026-11-19 22:1x）

| 项 | 结果 |
| --- | --- |
| 仓库 | `https://github.com/huisj22/purge-`（真实名含尾部连字符；用户给出的 URL 带中文标注） |
| 分支 | `phase5/verification`（`main` 未被触碰） |
| 推送次数 | 4 次（1 次直连成功；5 次直连超时；代理 HTTP/1.1 成功） |
| CI 运行 | 3 次：`44538278925` ❌ / `44538840162` ❌ / **`44540146301` ✅** |
| 最终结果 | Windows + Ubuntu + macOS 三平台 verify job **全部 success**，artifact job success |

**CI 发现并修复的两个真实缺陷**

1. `"install"` 脚本被 pnpm 当作生命周期钩子自动执行 → 三平台依赖安装即失败（改名 `install:app`，`1272ed4`）。
2. `ENOTDIR`（POSIX）与 `ENOENT`（Windows）语义差异 → 恢复回滚在 Linux/macOS 误判失败（`4d9800e`）。

这两个缺陷在本地 Windows 上都不会暴露，证明多平台矩阵有实际价值。

**平台标记更新**：`GITHUB_WINDOWS_RUNNER_VERIFIED` / `GITHUB_UBUNTU_RUNNER_VERIFIED` / `GITHUB_MACOS_RUNNER_VERIFIED` 全部 = TRUE。

**仍未验证**：Node 22 运行时（matrix 仅 24）、真实宿主写入（BLOCKED）、分支保护配置。