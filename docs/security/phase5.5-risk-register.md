# Phase 5.5 风险登记（RISK REGISTER）

更新时间：2026-11-19 · 对应分支 `phase5.5/security-closure`

等级：P0 严重破坏/权限失控 · P1 高风险 · P2 重要缺陷 · P3 一般
状态：FIXED / MITIGATED / OPEN / ACCEPTED / BLOCKED / NOT_VERIFIED

---

## P0

| ID | 问题 | 状态 |
| --- | --- | --- |
| — | 无 | — |

## P1

| ID | 问题 | 影响 | 缓解 | 状态 |
| --- | --- | --- | --- | --- |
| R-P1-1 | `snapshot.prune` 与 capture 竞争：删除"已写对象、未插行"的内容 → 快照永久损坏 | 恢复失败/数据丢失 | 共用 global→snapshot 锁；UNKNOWN（非哈希名）一律保留；并发测试（真实子进程） | **FIXED** |
| R-P1-2 | `update.prune` 可能删除活跃版本 / 最新版本 / 唯一可回滚版本 | 升级不可回滚 | global→update 锁；保护 active + 最新；最少保留 2 个；未知目录保留 | **FIXED** |
| R-P1-3 | Policy Store 无跨进程锁 + 无版本 CAS：并发授予丢失、旧写入者**复活已撤销权限** | 权限扩大 | global→policy 锁 + `expectedVersion` CAS + 版本单调断言 | **FIXED** |
| R-P1-4 | Policy 审计失败被吞：策略已落盘但无审计 | 不可追溯的提权 | 审计失败 → 回滚文件；回滚失败 → `recovery-required` 标记 + 抛错 | **FIXED** |
| R-P1-5 | Policy 读取使用旧缓存：其它进程撤销后本进程仍放行 | 权限扩大 | `state()` 按 mtime 失效缓存，重新校验 hash | **FIXED** |
| R-P1-6 | 插件数据位于版本目录内：升级即丢数据、卸载即删用户数据 | 数据丢失 | 数据目录独立为 `plugin-data/<id>/`；升级复用；卸载默认保留；`purgeData` 才删 | **FIXED** |
| R-P1-7 | 锁释放窗口（目录在、元数据缺失）被误判 RECOVERY_REQUIRED；Windows rename EPERM 使释放失败 | 写入被阻塞 | 释放改为"改名→删除"，Windows 回退删除；缺失元数据在 3s 宽限期内按 BUSY 重试 | **FIXED** |

## P2

| ID | 问题 | 影响 | 缓解 | 状态 |
| --- | --- | --- | --- | --- |
| R-P2-1 | 插件可用 `node:fs` 绕过 `ctx.data` 直接访问任意路径 | 越权读/写 | 应用层边界 + 拒绝审计；**需要 OS 沙箱根治** | **OPEN**（接受，见下） |
| R-P2-2 | 插件数据无磁盘配额 | 写满磁盘 | 单次写 1MB 上限；无总量限制 | OPEN |
| R-P2-3 | Policy 可被有文件权限者连同 hash 一起改 | 策略篡改 | 哈希只能发现单点篡改；需签名/OS 权限 | OPEN |
| R-P2-4 | Policy `recovery-required` 标记无自动修复命令 | 需人工 | 文档说明；标记文件内容含操作与 hash | OPEN |
| R-P2-5 | Policy 变更无 CLI/API 管理端点 | 可用性 | 库级 API 可用；端点列入下一阶段 | OPEN |
| R-P2-6 | Scheduler 多进程 tick 无 lease，可能重复执行 | 任务重复 | SQLite 单写者 + 无锁 | OPEN（Phase 6） |
| R-P2-7 | Workflow 并发 resume 可能重复写状态 | 状态不一致 | 同上 | OPEN（Phase 6） |
| R-P2-8 | 外部编辑器 / 外部进程直接改文件不受锁约束 | 数据覆盖 | 哈希守卫 + 恢复冲突检测 + TOCTOU 复检 | ACCEPTED（系统边界） |
| R-P2-9 | 跨机器 / 网络文件系统未验证（rename 原子性） | 未知 | 单机语义；CI 仅本机文件系统 | NOT_VERIFIED |
| R-P2-10 | Audit Prune 的保留策略需人工设定（默认 1000 条） | 磁盘/追溯平衡 | `keepLast` 参数 + checkpoint 锚点 | ACCEPTED |
| R-P2-11 | 分支保护开启 `enforce_admins=true`，锁死时需管理员手动关闭 | 运维 | 文档记录关闭路径 | ACCEPTED |

## P3

| ID | 问题 | 状态 |
| --- | --- | --- |
| R-P3-1 | Logs / Trace / Metric 写入无跨进程锁（热路径，有意不加） | ACCEPTED |
| R-P3-2 | Rules / Skills / Self-Config 变更未写审计事件 | OPEN |
| R-P3-3 | Update stage 无锁（staging 名唯一，冲突风险低） | ACCEPTED |
| R-P3-4 | Audit Prune 不保留被删记录内容（只留锚点 hash） | ACCEPTED（有意） |
| R-P3-5 | 目录 fsync 在 Windows 无保证 | ACCEPTED |
| R-P3-6 | 插件旧 `.data` 迁移只覆盖 `store.json` | ACCEPTED |
| R-P3-7 | 卸载后插件数据无 TTL 清理 | ACCEPTED |

## 逐条"是否需要人工介入"

| 状态 | 自动恢复 | 人工 |
| --- | --- | --- |
| 锁 STALE | ✅ 回收留痕 | 否 |
| 锁 RECOVERY_REQUIRED | ❌ | 是（确认后删锁目录） |
| Policy hash 不符 | ❌ 拒绝加载 | 是（核对或从备份恢复） |
| Policy recovery-required | ❌ | 是 |
| 恢复冲突 | ✅ 阻止，不动文件 | 否（用户决定 force） |
| Snapshot GC 与 capture 竞争 | ✅ 锁串行 | 否 |
| 插件数据拒绝 | ✅ 返回错误 + 审计 | 否 |
| 打包路径超长 | ❌ 报错 | 是（排除目录已内置） |

## 统计

| 等级 | FIXED | OPEN | ACCEPTED / NOT_VERIFIED |
| --- | --- | --- | --- |
| P0 | 0 | 0 | 0 |
| P1 | 7 | 0 | 0 |
| P2 | 0 | 6 | 5 |
| P3 | 0 | 1 | 6 |
