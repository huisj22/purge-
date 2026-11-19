# Purge+ · MASTER_PLAN

> 本文件是 Purge+ 的**唯一权威计划**。任何 agent 会话启动后先读本文件，再读 `PROJECT_STATUS.md`、`TASKS.md`。
> 最后更新：2026-11-19 · 阶段：Phase 0 完成 / Phase 1 完成 / Phase 2 进行中

---

## 1. 项目一句话

Purge+ 是一个**宿主无关（host-agnostic）的 Agent 运维平台**：发现宿主编排进程与安装布局、诊断其健康度、以事务方式管理其配置与修改包（modification pack）、编排多 Agent 任务、并留下可回溯的观测与审计。

原项目 `dsh-purge` 的核心资产是**「对第三方宿主源码做可回滚文本修改」的工程能力**（86 条锚点补丁、漂移诊断、半自动重锚、快照回滚）。Purge+ 继承并泛化这套工程能力，同时补齐原项目缺失的产品层：配置中心、规则/技能中心、任务编排、调度、可观测性、安全治理、插件体系、更新维护、UI。

---

## 2. 继承与边界（不可协商）

| 项 | 规则 |
| --- | --- |
| 原功能 | 逐条登记在 `ORIGINAL_FEATURE_MATRIX.md`，六选一策略（KEEP/IMPROVE/REFACTOR/REPLACE/DEFER/REMOVE），不得静默删除 |
| 安全边界 | 按 MASTER PROMPT §07：Purge+ **不新增**任何绕过审批/沙箱/模型安全机制的能力；原项目已有的此类能力以「数据包（pack）」形式**可导入、可审计、可回滚**，并纳入风险评分与审计 |
| 真实性 | 禁止空函数、假测试、虚报通过、仅有 UI 无功能；未实现即标 `pending`，未测即标 `untested` |
| 验证口径 | 「命令返回 0」不等于成功；必须验证目标产物（哈希/状态/回读） |

---

## 3. 技术基线（已在本机实测）

| 项 | 选择 | 实测证据 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 22.5（本机 v24.1.0） | `node -v` |
| 语言 | TypeScript，**源码直跑**（Node 原生 type stripping，无打包步骤） | `node a.ts` → `ts-strip-ok 1` |
| 类型检查 | `tsc --noEmit`（devDependency） | 见 `package.json` scripts |
| 存储 | `node:sqlite`（内置，无原生编译） | `sqlite-ok [ { a: 42 } ]` |
| 包管理 | pnpm 10（本机 10.11.1） | `pnpm -v` |
| 测试 | `node --test`（内置 test runner） | 全部测试用 `.test.ts` |
| UI | 零构建静态 SPA（原生 DOM + CSS），由 API 同源托管 | 无打包器，刷新即生效 |
| 版本管理 | git（本机 2.54.0），阶段提交，不 push | `git status` |

选型理由：原项目最大结构性负担是「662KB 单文件前端 + 177KB 单文件核心 + 无类型约束 + 自带打包脚本」。Purge+ 直接绕开这三件事：无打包、类型化、模块化。

---

## 4. 目录结构（约定，落地后不得随意漂移）

```
D:\Purge+
  docs/                      设计与阶段交付物
    MASTER_PLAN.md           ← 本文件
    PRODUCT_SPEC.md
    ARCHITECTURE.md
    ROADMAP.md
    phase0/                  Phase 0 三份分析
    adr/                     架构决策记录
  src/
    core/                    引擎：事件、服务注册、配置、日志、错误、生命周期
    storage/                 SQLite 访问层（audit/trace/task/metric）
    adapters/                宿主/存储/运行时适配器
    inspector/               探测、证据、诊断规则
    configcenter/            配置中心（版本、diff、快照、冲突）
    ruleskills/              规则与技能注册中心
    workflow/                工作流引擎（DAG）
    scheduler/               调度器（interval + cron-lite）
    observability/           trace / timeline / metrics
    recovery/                事务、快照、内容寻址对象库
    security/                策略、风险评分、审计链
    plugins/                 插件宿主与清单
    update/                  更新检查与分阶段安装
    api/                     HTTP API
    cli/                     命令行
    ui/                      静态前端
  tests/                     node --test
  TASKS.md  PROJECT_STATUS.md
```

---

## 5. 阶段定义与出口条件（DoD）

| 阶段 | 内容 | 出口条件（必须可验证） |
| --- | --- | --- |
| P0 | 原项目研究 | 三份分析文档齐备，功能矩阵逐条有证据 |
| P1 | 产品与架构设计 | PRODUCT_SPEC / ARCHITECTURE / ROADMAP 完成且与代码一致 |
| P2 | 核心框架 | core/storage/config/log/recovery/security 跑通，`pnpm test` 全绿 |
| P3 | 原功能继承 | 矩阵中 KEEP/IMPROVE/REFACTOR/REPLACE 项均有对应实现 + 测试 |
| P4 | Agent 管理 | registry/adapter/inspector/configcenter 可用，能诊断本机真实 DSH |
| P5 | 任务自动化 | workflow + scheduler + queue，含重试/超时/取消/恢复测试 |
| P6 | 安全与恢复 | 策略引擎 + 审计链 + 事务回滚，破坏性操作需策略校验 |
| P7 | 可观测性 | trace/timeline/metrics/dashboard 有真实数据 |
| P8 | UI | 全部主要屏幕连真实 API |
| P9 | 全面测试 | unit/integration/e2e/回归 |
| P10 | 交付 | 安装、升级、文档、CI |

---

## 6. Agent 自主开发机制（每次会话照做）

1. 读 `docs/MASTER_PLAN.md` → 2. 读 `PROJECT_STATUS.md` → 3. 读 `TASKS.md` → 4. `git status` → 5. 跑一次 `pnpm test` 确认当前真实状态 → 6. 取最高优先级未完成任务 → 7. 实际改代码 → 8. 跑测试 → 9. 修 → 10. 更新文档与状态 → 11. 提交 → 12. 继续下一项。

**禁止**：只输出计划不改代码；把未测当已测；用 TODO 堆砌代替实现。

---

## 7. 风险清单（滚动维护）

| ID | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | 宿主（DSH）版本升级导致锚点漂移 | 修改包失效 | 漂移诊断 + 重锚 + `expect` 命中数契约 + drift 计入 broken 而非绿 |
| R2 | 破坏性操作留下半完成状态 | 用户机器损坏 | 事务：快照→改→校验→提交/回滚；禁止「CLI 0 即成功」 |
| R3 | 跨平台文件语义（junction、大小写、锁） | 递归删除越界 | 不跟随链接的删除、路径边界校验、锁目录互斥 |
| R4 | 安全治理被自动化绕过 | 平台自身成为风险源 | 策略层在确定性代码里，AI 建议不得直接触发高风险动作 |
| R5 | 范围膨胀 | 交付不了可运行产品 | 每个阶段 DoD 收口，未实现标 pending |
| R6 | 无类型 + 巨型单文件复现原项目债 | 维护成本 | 类型化、模块化、单文件 < 500 行的软约束 |
