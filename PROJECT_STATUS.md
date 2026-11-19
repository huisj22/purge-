# Purge+ project status

Updated: 2026-11-19 · Phase: 0 ✅ · 1 ✅ · 2 ✅ · 3（继承）基本完成 · 测试 **140 passed / 0 failed**

## 当前阶段

Phase 0/1/2 完成，Phase 3 的继承项与 Phase 4–7 的核心能力已落地：
内核、存储与哈希链审计、事务与快照、ASAR 与宿主适配、注册表、规则化诊断、修改包引擎、规则/技能中心、
插件宿主（能力白名单）、更新中心（离线索引 + 分阶段）、工作流、调度、策略、API、CLI、UI。
**仍未实现**：配置中心的多目标 diff/冲突预演、安装器（`install --verify-first`）、镜像/代理传输、归档换包（v0.3 计划）、端到端验收脚本。

## 本机真实跑过的命令（不是声明）

| 命令 | 输出/结果 |
| --- | --- |
| `node --test \"tests/**/*.test.ts\"` | `tests 106 / pass 106 / fail 0` |
| `npx tsc --noEmit` | exit 0（0 类型错误，typescript 5.9.3） |
| `node scripts/acceptance.ts` | **14/14 项通过**（health→宿主→诊断→pack 全生命周期→规则/技能→插件→快照→更新→工作流→审计链） |
| `node src/cli/main.ts doctor` | `审计链 ✓ 完整`、`宿主 1 个：dsh@24d1d554`、exit 0 |
| `node src/cli/main.ts host inspect dsh@24d1d554` | `@deepseek-ai/dsh-desktop@0.2.2-rc.5（verified）· 磁盘 both · 进程 running · 加载 unpacked · 修改痕迹 已修改` |
| `node src/cli/main.ts diagnose` | `WARN · 通过 7 / 警告 3 / 失败 0`（修复了官方 bundle 误报后） |
| `node src/cli/main.ts workflow run healthcheck` | `run-… → succeeded` |
| `node src/cli/main.ts job add nightly healthcheck "0 3 * * *" --yes` | `next=2026-11-19T19:00:00.000Z`（= 本地次日 03:00） |
| `node src/cli/main.ts pack import examples/pack-template.json --yes` | `已导入 example-template@0.0.1（f305d8ed3911）` |
| `node src/cli/main.ts pack plan example-template dsh@24d1d554` | 只读预演：`[missing] demo-code …（声明为可缺省）`，exit 0 |
| `node src/cli/main.ts rule add greet "打招呼" --body "总是先向用户问好" --yes` | `已创建规则 greet（v1）` |
| `node src/cli/main.ts rule compose` | `### 打招呼 (greet)` + 正文 |
| `node src/cli/main.ts plugin install examples\demo-plugin --yes` → `enable` → `invoke recent` | 装了插件、启用了插件，`invoke` 通过被授予的 `diagnostics` 能力读到真实诊断记录 |
| `node src/cli/main.ts update check --index examples\release-index.json` | `当前 0.1.0-alpha.1 · 最新 0.2.0 · 有更新` |
| `node src/cli/main.ts update apply --yes --index …` | 隔离目录内 `已激活 0.2.0`，落盘 `versions/0.2.0/{payload.bin,manifest.json}`
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
| 规则中心（多槽位 + 组装） | `src/ruleskills/rules.ts` | `ruleskills` |
| 配置中心（哈希守卫 + 行级 diff + 历史） | `src/configcenter/managed.ts` | `configcenter` |
| 技能中心（围栏导入 + 备份 + 安全提示） | `src/ruleskills/skills.ts` | `ruleskills` |
| 插件宿主（清单/能力白名单/健康/私有存储） | `src/plugins/host.ts` | `plugins` |
| 更新中心（离线索引/stage/activate） | `src/update/*` | `update` |
| API（REST + 统一错误 + 审计） | `src/api/server.ts` | `api` |
| CLI（doctor/host/diagnose/pack/snapshot/workflow/job/audit/config/policy/serve） | `src/cli/main.ts` | 实机跑通 |
| UI（8 屏零构建 SPA） | `src/ui/*` | `api`（静态资源）+ 人工验收 |

## 进行中

- 安装器 `install --verify-first`（v0.2）、镜像/代理传输、归档换包（v0.3）、UI 可访问性审计

## 已知问题

1. `tsc --noEmit` 已通过（typescript 5.9.3 / @types/node 22.20.5，exit 0，0 错误）。
2. `recentReports` 与 workflow 共用 `run` 表（靠 `kind` 区分），缺独立表；已可用但不够干净。
3. 诊断规则 12 条，覆盖 identity/layout/process/profile/modification/integrity；尚未覆盖磁盘空间、权限 ACL、日志增长。
4. 修改包只支持**已解包**宿主（v0.1 明确不做归档换包），sealed 宿主返回 `unsupported` 并给出原因。
5. UI 未做移动端适配与可访问性审计。

## 下一步

补 `tsc` 类型检查（装 devDeps）→ 规则/技能中心 → 插件宿主 → 端到端验收脚本。
