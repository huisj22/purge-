# Purge+ · PRODUCT SPEC

版本：v0.1 · 2026-11-19 · 状态：设计与实现同步

---

## 1. 定位

**Purge+ 是 Agent 宿主的运维控制台。** 它回答四个问题：

1. 我这台机器上有哪些 Agent 宿主？装在哪个布局里？当前是不是「磁盘上改了、进程还没加载」？
2. 它们健康吗？哪里坏了、证据是什么、根因可能是什么、修之前能不能预览？
3. 我给它们打的修改/配置，能不能回溯、能不能一键回滚、有没有被别的更新覆盖？
4. 我让 Agent 干的活（诊断/巡检/维护/批量配置），跑到哪了、失败了为什么、下次什么时候跑？

**不是**：又一个 AI 聊天壳；也不是「把安全网关全部拆掉」的开关合集。

---

## 2. 用户与场景

| 用户 | 场景 | Purge+ 提供 |
| --- | --- | --- |
| 单机重度用户（装了很多插件/改过宿主） | 宿主更新后一切失效，不知道哪条补丁没了 | 体检 + 漂移诊断 + 一条命令重锚/回滚 |
| 小团队维护者（给同事代装） | 装完不知道成没成，出问题只能重装 | 事务式安装、逐层证据、可回滚快照 |
| 安全/合规关注者 | 不知道某个修改包动了什么 | 包导入前风险评分 + 全量审计链 + 一键还原 |
| 自动化玩家 | 想让 Agent 定时巡检/批量处理 | 工作流 + 调度 + 观测 |

---

## 3. 功能体系（12 个模块 / 3 个用户旅程）

```
旅程 A 体检与修复     旅程 B 修改与治理        旅程 C 自动化与观测
  discover             pack import (risk)        workflow run
  inspect              plan (diff preview)        schedule
  diagnose             apply (transaction)        trace / timeline
  findings             verify                     metrics / dashboard
  fix preview          audit chain                failure analysis
  backup / restore     revert                     report export
```

| # | 模块 | 用户可见能力 | 关键不变量 |
| --- | --- | --- | --- |
| 1 | Core Engine | 服务生命周期、事件、错误边界 | 半启动即回滚 |
| 2 | Agent Registry | 宿主发现/识别/能力登记 | 磁盘态 / 进程态 / 加载态三者分离 |
| 3 | Adapter System | 多宿主接入 | 核心不依赖具体宿主 |
| 4 | Inspector | 体检、根因、修复预览 | 无证据 = unknown |
| 5 | Configuration Center | 读/改/历史/差异/冲突 | 外部改动检测，拒绝覆盖 |
| 6 | Rule & Skill Center | 规则技能 CRUD、导入校验 | 导入前静态安全检查 |
| 7 | Workflow Engine | DAG 编排、并行、重试、恢复 | 状态可持久化、可恢复 |
| 8 | Scheduler | 定时/周期/触发 | 不重叠执行、重启不丢 |
| 9 | Observability | trace/时间线/指标/失败分析 | 数据来自真实执行 |
| 10 | Recovery Center | 快照/回滚/完整性校验 | 回滚必须回读验证 |
| 11 | Security Center | 风险评分、策略、审计链 | AI 不能绕过确定性策略 |
| 12 | Plugin System | 安装/启停/权限/健康 | 越权即拒绝 |

辅以：Update & Maintenance Center（第 13）、AI Assistant（第 14，仅建议+证据分级）、UI/CLI（第 15）。

---

## 4. 核心工作流

```
DISCOVER → ANALYZE → DIAGNOSE → PLAN → REVIEW → EXECUTE → VERIFY → REPORT → (RECOVER)
```
每一步都有状态、有产物、可中止。`VERIFY` 必须回读真实产物（文件哈希 / 数据库记录 / HTTP 响应体），不能只看退出码。

---

## 5. 与原项目的能力对应（摘要，明细见 ORIGINAL_FEATURE_MATRIX.md）

| 原能力 | Purge+ 处理 | 策略 |
| --- | --- | --- |
| 86 条宿主锚点补丁引擎 | 泛化为 Modification Pack Engine（pack 即数据） | REFACTOR |
| 漂移诊断 + 半自动重锚（reanchor） | 保留并类型化，纳入诊断报告 | IMPROVE |
| 自检 25 层 / 状态词表 | 保留词表，收敛为 11 态 | IMPROVE |
| 快照/回滚/内容寻址对象库 | 保留，接入事务协议 | REFACTOR |
| 审计 jsonl | 升级为 SQLite 哈希链 | REPLACE |
| CLI 20+ 命令 | 保留必要子集，统一退出码 | REFACTOR |
| Web 面板（662KB 单文件） | 重写为零构建 SPA + REST | REPLACE |
| 更新器（GitHub/mirror/proxy/SHA256） | 离线优先的分阶段安装器 | REFACTOR |
| 红队演练台（~1MB，SQLite 证据账本） | 证据账本思想用于诊断证据；演练台本身 | DEFER |
| 关闭审批/沙箱/提示词闸门的具体补丁内容 | 作为**可导入 pack**，平台提供风险评分/审计/回滚 | 内容不升级，能力保留 |

---

## 6. 非目标（明确不做）

- 不做「让 AI 无条件执行高风险操作」的开关集合（MASTER PROMPT §07）。
- 不替代宿主自身的对话/工具执行能力。
- 不做云端多租户 SaaS。
- 不在未验证的情况下宣称某项功能「已完成」。

---

## 7. 验收标准（v0.1）

1. `pnpm install && pnpm test` 全绿（真实测试，非占位）。
2. `purgeplus doctor` 在本机输出真实体检结果，含审计链校验。
3. `purgeplus host list` 能发现本机真实 DeepSeek Harness 安装并给出磁盘态/进程态。
4. `purgeplus serve` 起服务后，UI 首页显示真实数据，体检/快照/工作流/调度四个屏幕可操作。
5. 破坏性操作在策略层被拦截或要求确认，且写入审计链。
6. 任意一次 apply 都能被 revert 回到 apply 前哈希。
