# Purge+ project status

Updated: 2026-11-19 · Phase: 0 ✅ 1 ✅ 2 ✅(进行中收尾) · 测试：65 passed / 0 failed

## 当前阶段

Phase 2（核心框架）已完成，Phase 3/4（继承 + Agent 管理）部分完成：内核、存储与审计、恢复事务、宿主适配、诊断、工作流、调度均已实现并通过测试。
**进行中**：安全策略测试 → API → CLI → UI → 修改包引擎。

## 已运行的真实命令（不是声明）

| 命令 | 结果 |
| --- | --- |
| `node --test "tests/**/*.test.ts"` | 65 tests / 65 pass / 0 fail |
| `node _research/probe-dsh.ts` | 本机发现 1 个真实 DSH：`@deepseek-ai/dsh-desktop@0.2.2-rc.5`，shape=both，running=true(pids 已修正)，识别出旧 dsh-purge@1.6.91 痕迹 |
| ASAR 头读取 | 209 MB 归档 65 ms 读出 `package.json`（name/version/main） |

## 已完成（有测试证据）

| 模块 | 文件 | 测试 |
| --- | --- | --- |
| Kernel / EventBus / Logger / Schema / Config | `src/core/*` | `tests/core-kernel.test.ts` `tests/config.test.ts` |
| SQLite 存储 / 审计哈希链 / Trace / Metric | `src/storage/*` | `tests/storage.test.ts` |
| 快照 CAS / 事务 | `src/recovery/*` | `tests/recovery.test.ts` |
| ASAR 读取 / DSH 适配器 | `src/adapters/*` | `tests/adapters.test.ts` |
| 注册表 | `src/registry/registry.ts` | `tests/diagnostics.test.ts`（registry 段） |
| 诊断规则与报告 | `src/inspector/*` | `tests/diagnostics.test.ts` |
| 工作流引擎 | `src/workflow/engine.ts` | `tests/workflow.test.ts` |
| 调度器 / cron-lite | `src/scheduler/*` | `tests/scheduler.test.ts` |

## 进行中

- 安全策略（`src/security/policy.ts` 已实现，测试待补）
- 组合根 / API / CLI / UI

## 待完成（按优先级）

1. 策略层测试 + 接入一切变更动作
2. 组合根 `src/app.ts`（服务装配、数据目录、生命周期）
3. REST API + 统一错误 + 策略 + 审计
4. CLI 子命令（doctor/host/diagnose/pack/workflow/job/snapshot/audit/serve）
5. 静态 UI（概览/宿主/诊断/快照/工作流/调度/审计）
6. 修改包引擎（schema/plan/apply/revert + 风险分级）
7. 端到端验证（本机真实 DSH 只读 + 假宿主写路径）
8. README / 安装说明 / 提交

## 已知问题 / 质量备注

- `src/inspector/diagnostics.ts` 的 `recentReports` 依赖 `run` 表；诊断报告与 workflow 共用该表，靠 `kind` 区分（已实现，待补测试）。
- 进程探测在 Windows 用 `tasklist`、类 Unix 用 `pgrep`；两者失败都返回 `unknown`，不会被当成「未运行」。
- 修改包引擎尚未实现，因此矩阵中 A1/A3/A4/A8/A9/A13 仍为 `wip/planned`。

## 下一步（一句话）

补策略测试 → 装配 `src/app.ts` → 打通 `purgeplus doctor` 与 `purgeplus serve`，让 UI 显示真实数据。
