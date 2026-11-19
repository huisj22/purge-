# P2-13 写入口跨进程锁审计（P2-13_WRITE_PATH_LOCK_AUDIT）

范围：Rules / Skills / Purge+ 自身配置 / Audit Append
证据：`tests/write-path-locks.test.ts`（6 例，全部通过，10.2s，使用真实子进程）

---

## 1. 逐入口结论

| 写入口 | 实际写入点 | 是否经跨进程锁 | 绕过入口 | 并发风险 | 需要独立锁 | 事务保护 |
| --- | --- | --- | --- | --- | --- | --- |
| Rules | `RuleStore.#persist` → `<dataDir>/rules/<id>.json` | ✅ 是（global → `rules`，scope=config） | 直接改文件（外部编辑器）不受锁约束 | 已消除（进程内 + 跨进程） | 是（独立 `rules` 资源） | 原子写（temp+rename） |
| Skills | `SkillLibrary.#importLocked` → `<dataDir>/skills/<name>/**` | ✅ 是（global → `skills`） | 同上 | 已消除 | 是（独立 `skills`） | 导入为"staging → 校验 → rename"，失败清理 |
| 自身配置 | `ConfigStore.#updateLocked` → `<dataDir>/config.json` | ✅ 是（global → `setting`） | 同上 | 已消除 | 是（避免与 managed config 混淆） | 先写盘后改内存（Phase 4 已修） |
| Audit Append | `AuditLog.append` → SQLite `audit` 表 | ⚠️ **不加业务锁**（有意） | 直接用 sqlite3 改库（外部分析工具） | 已通过事务 + 重试消除 | 否（会与业务锁互相等待） | ✅ `BEGIN IMMEDIATE` 事务 |

## 2. 关键实现

### 2.1 Rules / Skills / Self-Config
- 统一走 `withWriteGuard(dataDir, { resource, scope:"config", operation })`：先 `global`（维护级），再具体资源。
- 与 Phase 5 的 lock 层级一致（global 10 → config 30），不会与其他写路径形成环路。
- 同进程内可重入：`app.guarded` 里若已持锁，规则写入不会自锁。

### 2.2 Audit Append（为什么**不**加业务锁）

审计在几乎每个变更操作里被调用；若它也抢 `global`，会出现：

```
业务操作持有 global → 写审计时需要 global → 同进程可重入（OK）
跨进程：A 持 global 写审计，B 持 global 写审计 → 串行，但 B 的业务锁等待会变成全局排队
```

因此改为**数据库层**保证：
1. `BEGIN IMMEDIATE`（立即拿写锁）→ 读 last(seq,hash) → 计算 → INSERT → COMMIT。
2. seq 在事务内分配，杜绝"两个进程算出同一个 seq"（这是修复前真实存在的缺陷）。
3. 遇 `SQLITE_BUSY` 同步自旋重试（最多 100 次 × ~5ms），超出即抛出（不吞错）。

## 3. 测试证据（6/6）

| 用例 | 注入 | 期望 | 实际 |
| --- | --- | --- | --- |
| 规则写入 | 子进程持 `global` 2.5s | `conflict`；释放后写入成功 | ✅ |
| 技能导入 | 子进程持 `global` | `conflict`；释放后导入成功 | ✅ |
| 技能删除 | 子进程持 `global` | `conflict`；释放后删除成功 | ✅ |
| 自身配置 | 子进程持 `global` | `conflict`，且**内存态不变**；释放后生效 | ✅ |
| 审计并发 | 3 个子进程 × 20 次 append 同一 DB | 60 条、链完整 | ✅（修复后；修复前 `UNIQUE constraint failed: audit.seq`） |
| 部分写入 | DB 关闭后 append | 抛错且不留半条；重开后链完整 | ✅ |
| 环形 detail（附加） | `detail.self = detail` | 脱敏后正常写入，不崩 | ✅ |

## 4. 修复记录

| # | 问题 | 现象 | 修复 |
| --- | --- | --- | --- |
| 1 | `append` 在事务外分配 seq | 多进程并发 `UNIQUE constraint failed: audit.seq`，写进程退出码 1 | `BEGIN IMMEDIATE` 内分配 seq + 计算 hash + 插入 |
| 2 | 只处理 `SQLITE_BUSY`，未处理约束冲突 | 约束错误被当作普通错误抛出，调用方看到 `internal` | 事务化后从根上避免；BUSY 仍保留有界重试 |
| 3 | Rules/Skills/Config 无跨进程锁 | 两进程并发写可丢更新 | 接入 `withWriteGuard` |

## 5. 仍未覆盖（诚实清单 → PARTIAL 依据）

| 入口 | 状态 | 风险 |
| --- | --- | --- |
| `SkillLibrary.remove` 的备份目录清理 | 已加锁，但备份 GC 未加锁 | 低（备份只增不减） |
| `SnapshotStore.prune` | 未加锁 | 与 capture 并发可能误删刚写入对象（窗口小） |
| 外部编辑器/进程直接改文件 | 不可能加锁 | 依赖 hash 守卫与冲突检测 |
| 跨机器（网络文件系统） | 不支持 | 单机语义 |
| 审计表被外部工具直接修改 | 不加锁 | 哈希链可发现，不可阻止 |

## 6. 结论

- **P2-13 判定：PARTIAL → 已补齐主要写入口（Rules / Skills / Self-Config），Audit Append 采用事务化方案并修复了真实的并发缺陷。**
- T-037 **仍是"核心写路径已完成"**，不应描述为"所有写操作已覆盖"：
  未覆盖 `prune`、备份 GC、以及一切外部写入。
