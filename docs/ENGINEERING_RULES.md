# Purge+ 工程原则（永久约束）

> 本文件是项目的工程底线，任何阶段、任何 Agent 都不得绕过。
> 违反其中任何一条的"完成"，按未完成处理。

---

## 原则一：Unknown 不得伪装成 Healthy

状态无法确认时，必须保留 `UNKNOWN`，不得自动标记为正常/安全/成功。

落地要求：
- 诊断、健康检查、安装校验、锁状态、插件状态、恢复结果都必须有 `unknown` 取值。
- `unknown` 不计入通过率，不触发"全绿"。
- 任何把 `unknown` 折算成 `ok` 的代码路径都视为缺陷。

反面案例（Phase 4 已修）：用文件 mtime 推断"宿主被修改"，把干净解包宿主判成 high/fail。

## 原则二：Plan / Apply / Verify 必须分离

- **PLAN**：只读，产出计划与差异，不改磁盘。
- **APPLY**：执行写入，可回滚。
- **VERIFY**：回读真实产物（哈希/记录/接口），与期望比对。

只有 VERIFY 通过才能报告成功。禁止"生成计划即完成""写入即成功""HTTP 200 即成功""函数返回即恢复成功"。

## 原则三：Capability 不等于 Sandbox

能力白名单只约束**接口**，不约束进程权限。

- 插件在宿主进程内运行 → 只能称 `CAPABILITY_RESTRICTED`，不得称沙箱。
- 只有进程分离且 OS 级限制生效时，才可称 `PROCESS_ISOLATED` / `OS_SANDBOXED`。
- 任何文档/UI 文案不得暗示"插件已被隔离"，除非有对应的进程与 OS 级证据。

## 原则四：Backup 不等于 Safe Recovery

- 恢复前必须比较"快照 vs 当前"，冲突默认阻止。
- 恢复必须事务化：PRECHECK → CONFLICT → BACKUP → RESTORE → VERIFY → COMMIT，失败回滚并验证回滚结果。
- 回滚失败必须进入 `RECOVERY_REQUIRED`，不得报告成功。
- 强制恢复需要授权、需要预先备份、需要完整审计。

## 原则五：测试通过不等于真实可靠

必须区分证据等级，报告中逐项标注：

`UNIT_TESTED` · `INTEGRATION_TESTED` · `FAULT_INJECTION_TESTED` · `PLATFORM_VERIFIED` · `REAL_HOST_VERIFIED` · `NOT_VERIFIED` · `BLOCKED`

- 单元测试通过不得推出"系统可靠"。
- 模拟宿主（假 fixture）通过不得写成"真实宿主验证"。
- 未在目标平台运行过的能力，一律 `NOT_VERIFIED`。

## 原则六：写操作必须有跨进程互斥

- 进程内 Promise/Map 锁只能保证单进程一致。
- 涉及共享状态的写操作必须持有跨进程锁（原子目录创建 + 元数据 + 存活判定）。
- 锁状态不确定（损坏/无法读取）→ 默认阻止写，而不是放行。

## 原则七：权限不能被执行主体自我修改

- Policy Owner 与 Executor 分离；Executor（含 CLI/UI/Workflow/Plugin/AI）不得修改策略、不得自我授权、不得把 deny 变 allow。
- 策略文件必须有版本与哈希，修改需 owner 授权并写审计。
- AI 可以"请求/建议"，不可以"批准"。

## 原则八：交付链路必须可重复、可验证

- 安装必须有状态机、前置检查、后置验证、失败回滚。
- 安装幂等：重复安装不产生重复状态。
- CI 必须真实运行；不能运行的部分标记 `NOT_VERIFIED`，不得写"已支持"。

---

## 违反原则的判定

| 行为 | 判定 |
| --- | --- |
| 用 catch 忽略错误并返回成功 | 缺陷（P1 起） |
| 把 unknown 显示为 ok | 缺陷（P1 起） |
| 只跑 plan 就报告完成 | 缺陷 |
| 声称"隔离"但无进程/OS 证据 | 文档缺陷 + 安全风险 |
| 恢复覆盖未知更新且无提示 | 缺陷（P1） |
| 跨进程写无锁 | 缺陷（P1） |
