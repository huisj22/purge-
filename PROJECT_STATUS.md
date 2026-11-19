# Purge+ project status

Updated: 2026-11-19 · Phase: 0 ✅ · 1 ✅ · 2 ✅ · 3（继承）进行中 · 测试 **106 passed / 0 failed**

## 当前阶段

Phase 0（原项目研究）、Phase 1（设计）、Phase 2（核心框架）完成，Phase 3/4 的核心部分已落地：
内核、存储与哈希链审计、事务与快照、ASAR 与宿主适配、宿主注册表、规则化诊断、修改包引擎、工作流、调度、策略、API、CLI、UI。
**尚未实现**：配置中心的多目标 diff/冲突、规则与技能中心、插件宿主、更新中心、安装器（见 TASKS.md）。

## 本机真实跑过的命令（不是声明）

| 命令 | 输出/结果 |
| --- | --- |
| `node --test "tests/**/*.test.ts"` | `tests 106 / pass 106 / fail 0` |
| `node src/cli/main.ts doctor` | `审计链 ✓ 完整`、`宿主 1 个：dsh@24d1d554`、exit 0 |
| `node src/cli/main.ts host inspect dsh@24d1d554` | `@deepseek-ai/dsh-desktop@0.2.2-rc.5（verified）· 磁盘 both · 进程 running · 加载 unpacked · 修改痕迹 已修改` |
| `node src/cli/main.ts diagnose` | `WARN · 通过 7 / 警告 3 / 失败 0`（修复了官方 bundle 误报后） |
| `node src/cli/main.ts workflow run healthcheck` | `run-… → succeeded` |
| `node src/cli/main.ts job add nightly healthcheck "0 3 * * *" --yes` | `next=2026-11-19T19:00:00.000Z`（= 本地次日 03:00） |
| `node src/cli/main.ts pack import examples/pack-template.json --yes` | `已导入 example-template@0.0.1（f305d8ed3911）` |
| `node src/cli/main.ts pack plan example-template dsh@24d1d554` | 只读预演：`[missing] demo-code …（声明为可缺省）`，exit 0 |
| `node src/cli/main.ts serve` + curl | `/api/health` ok · `/` 1310 B · `/app.js` 26800 B · `/api/overview` 读到真实宿主与审计校验 |
| ASAR 头读取 | 209 MB 归档 65 ms 读出 `package.json` |

## 已完成模块（含证据）

| 模块 | 文件 | 测试 |
| --- | --- | --- |
| Kernel / EventBus / Logger / Schema / Config / 原子写 | `src/core/*` | `core-kernel` `config` |
| SQLite（v2 迁移）/ 审计哈希链 / Trace / Metric | `src/storage/*` | `storage` |
| 快照 CAS / 事务（写入即校验） | `src/recovery/*` | `recovery` |
| ASAR 只读 / DSH 适配器 | `src/adapters/*` | `adapters` |
| 宿主注册表 | `src/registry/registry.ts` | `diagnostics` |
| 诊断（12 条规则 → Findings → 落库） | `src/inspector/*` | `diagnostics` |
| 修改包（schema/matcher/engine/store） | `src/packs/*` | `packs` `api` |
| 工作流（DAG/并行/重试/超时/取消/恢复） | `src/workflow/*` | `workflow` |
| 调度（interval + cron-lite + 互斥 + 持久化） | `src/scheduler/*` | `scheduler` |
| 策略（风险评分/allow-confirm-deny/AI 不降级） | `src/security/policy.ts` | `policy` |
| API（REST + 统一错误 + 审计） | `src/api/server.ts` | `api` |
| CLI（doctor/host/diagnose/pack/snapshot/workflow/job/audit/config/policy/serve） | `src/cli/main.ts` | 实机跑通 |
| UI（8 屏零构建 SPA） | `src/ui/*` | `api`（静态资源）+ 人工验收 |

## 进行中

- 规则/技能中心、配置中心多目标 diff、插件宿主、更新中心（T-018/019/020）

## 已知问题

1. **未做类型检查**：`tsc --noEmit` 需要先 `pnpm i` 安装 devDependencies，本会话未联网安装；当前仅由 Node type stripping 保证语法与运行正确。
2. `recentReports` 与 workflow 共用 `run` 表（靠 `kind` 区分），缺独立表；已可用但不够干净。
3. 诊断规则 12 条，覆盖 identity/layout/process/profile/modification/integrity；尚未覆盖磁盘空间、权限 ACL、日志增长。
4. 修改包只支持**已解包**宿主（v0.1 明确不做归档换包），sealed 宿主返回 `unsupported` 并给出原因。
5. UI 未做移动端适配与可访问性审计。

## 下一步

补 `tsc` 类型检查（装 devDeps）→ 规则/技能中心 → 插件宿主 → 端到端验收脚本。
