# Phase 5 计划（PHASE5_PLAN）

目标：在 Phase 4 的可靠性基础上，补齐**交付链路、跨进程一致性、恢复冲突检测、权限分级、插件进程隔离**。
不做：新功能扩张、UI 美化、架构重写。

基线：`06b1701`（Phase 4 收尾），197 tests / 45 suites / 0 fail，tsc 0，acceptance 14/14（Phase 5 已复跑确认）。

---

## 任务与出口条件

| 任务 | 内容 | 出口条件（可验证） | 阶段 |
| --- | --- | --- | --- |
| T-035 | 安装器 + 打包 + CI + 前置检查 + 安装状态机 + 失败回滚 + 幂等 + 后置验证 | 真实在临时目录跑通全流程；失败可回滚；重复安装幂等；CI 文件存在且本地等价脚本通过 | B |
| T-037 | 跨进程维护锁（原子目录 + 元数据 + stale 策略 + 层级 + 覆盖写入口） | 7 个子进程用例（A–G）真实通过 | C |
| P2-08 | 恢复冲突检测（UNCHANGED/MODIFIED/DELETED/UNKNOWN）+ 默认阻止 + 强制恢复需授权 + 事务化 | 冲突注入测试全通过；rollback 失败可识别 | D |
| P2-10 | 权限分级（Owner/Executor/Advisor/Auditor）+ 授权 TTL + 策略完整性 | 自我提权/自我批准/篡改策略全部被拒 | E |
| T-036 | 插件独立进程 + IPC schema + Host 侧权限 + 超时 + 崩溃隔离 | 崩溃/超时/越权/非法消息全部被隔离且核心存活 | F |
| G | 全量回归 + 平台矩阵 + 剩余风险登记 | 数字可复现；未验证项显式列出 | G |

## 证据等级约定

每个任务报告必须标注：`UNIT_TESTED` / `INTEGRATION_TESTED` / `FAULT_INJECTION_TESTED` / `PLATFORM_VERIFIED` / `NOT_VERIFIED` / `BLOCKED`。

## 平台约束（预先声明）

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows 11 x64 | 可运行 | 本机唯一可用环境 |
| Linux | NOT_VERIFIED | 无环境；CI 文件将覆盖但未执行 |
| macOS | NOT_VERIFIED | 无环境 |
| OS 级沙箱（seccomp/AppContainer/job object 内存限制） | 未实现 | 本轮只做进程隔离 + 代码层限制，明确标注 |

## 顺序依赖

Stage A（文档/原则/基线）→ B（安装）→ C（锁）→ D（恢复冲突）→ E（权限）→ F（插件隔离）→ G（回归）。

每阶段结束必须更新 `PHASE5_PROGRESS.md`，并在 `reports/phase5/` 留下证据文件。

## 不做的事（显式）

- 不引入重依赖（跨进程锁用 `fs.mkdir` 原子语义，不装 `proper-lockfile`）。
- 不实现宿主归档换包/自动重启。
- 不改动 Phase 4 已确立的安全策略默认值（只增加层级与授权）。
- 不为了让测试变绿而放宽断言。
