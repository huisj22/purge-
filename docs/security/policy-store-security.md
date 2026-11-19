# Policy Store 安全审计与加固（T055-02）

文件：`src/security/policy-store.ts` · 测试：`tests/policy-store-hardening.test.ts`（11 例）
结论：**VERIFIED（应用层）** · 残余风险见 §7

---

## 1. 审计发现（加固前）

| # | 问题 | 等级 | 证据 |
| --- | --- | --- | --- |
| 1 | `#persist` 无跨进程锁：两个进程同时 grant → 后者覆盖前者（丢授予） | **P1** | 代码审计；并发测试复现（加固后通过） |
| 2 | 无版本 CAS：旧写入者可覆盖新策略，可**复活已撤销的权限** | **P1** | 设计缺陷；`revoke` 与 `grant` 竞争 |
| 3 | 无写后复读：`atomicWriteFile` 成功即返回，磁盘内容未校验 | P2 | 代码审计 |
| 4 | 无 fsync：崩溃后 rename 可能未落盘 | P2 | 代码审计 |
| 5 | 审计失败被吞：`#emit` 抛错时策略已落盘但无审计记录 | **P1** | 代码审计 |
| 6 | 读取路径长期使用缓存：其它进程改策略后本进程仍用旧授权判断 | **P1** | 代码审计；`refresh` 测试复现 |
| 7 | 无法区分"文件缺失"与"文件损坏" | P3 | — |

## 2. 加固后的机制

| 机制 | 实现 |
| --- | --- |
| **跨进程锁** | 所有写路径经 `withWriteGuard(dataDir, { resource: "policy", scope: "config", waitMs })`（global → policy） |
| **原子 + 持久写** | 写入 `<file>.tmp-<pid>-<rand>` → `handle.sync()` → `rename` → 目录 fsync（POSIX 生效，Windows 尽力而为） |
| **版本 CAS** | `grant/revoke/setOwner(..., { expectedVersion })`；不匹配 → `conflict`（含 expected/actual） |
| **版本单调** | `#mutate` 断言 `next.version === current.version + 1`，任何回退直接 `internal` |
| **Hash 完整性** | `policyHash()` 覆盖 `schema/version/owner/updatedAt/updatedBy/grants[]`（含 id/subject/role/maxLevel/actions/expiresAt/grantedBy/grantedAt/reason） |
| **写后复读** | 重新读盘 → `parseAndVerify` → 比对 hash + version；不一致 → 回滚旧内容并抛 `integrity_failed` |
| **审计** | 每次变更发一个事件（`policy_set` / `policy_grant` / `policy_revoke`），含 `fromVersion/toVersion/hash/grants` |
| **审计失败处理** | 回滚到旧内容；回滚成功 → `internal: policy audit failed; change reverted`；回滚失败 → 写 `<file>.recovery-required` 标记 + `integrity_failed`（`state: RECOVERY_REQUIRED`） |
| **读取新鲜度** | `state()` 比对文件 `mtime`，变化即重新 `load()`（schema/hash 重新校验），不再用旧缓存授权 |
| **错误分类** | 缺失 → 引导文档；JSON 非法/字段缺失 → `schema_invalid`；hash 不符 → `integrity_failed` |

## 3. 故障注入结果（11 例全通过）

| 用例 | 期望 | 实际 |
| --- | --- | --- |
| 过期 `expectedVersion` | `conflict`，不生效 | ✅ |
| 旧写入者复活已撤销授权 | `conflict` | ✅ |
| 3 进程 × 5 次并发授予 | 15 条全部落地、hash 自洽 | ✅ |
| rename 失败 | 旧策略文件字节不变 | ✅ |
| 进程中断留下临时文件 | 读取忽略临时文件，正式文件有效 | ✅ |
| hash 篡改 | `integrity_failed` | ✅ |
| JSON 损坏 | `schema_invalid` | ✅ |
| 审计失败 | 回滚，抛 `audit failed; change reverted`，磁盘内容与变更前一致 | ✅ |
| 审计 + 回滚同时失败 | 留下 `policy.json.recovery-required`，抛错 | ✅ |
| TTL 到期 + 并发读取 | allow → deny | ✅ |
| 其它进程修改后本进程判定 | 重读文件后 deny（不用旧缓存） | ✅ |
| 5 次连续变更 | 每次磁盘内容 == 内存文档（hash/version/grants 一致） | ✅ |

## 4. 并发结果（真实子进程）

3 个进程各 5 次 `grant`，全部使用 `expectedVersion` + 冲突重试：
- 退出码全 0；最终 `grants.length === 15`；`policyHash(doc) === doc.hash`。
- 说明"读-校验-写"在锁内完成，且 CAS 让冲突可见而不是静默覆盖。

## 5. 未授权写入路径检查

| 路径 | 结论 |
| --- | --- |
| `app.guarded` → `policyStore.evaluate` | 只读 |
| CLI / API | 无直接改写策略文件的代码（`grep` 无 `policy.json` 写入） |
| 插件 / Worker | 无 PolicyStore 引用；能力白名单不含 policy 服务 |
| 后台任务 | 不写策略 |

唯一写入口：`PolicyStore` 的 `grant/revoke/setOwner`（及首次 bootstrap）。bootstrap 也走 `#persistDurable`（加固后）。

## 6. 审计内容与脱敏

事件 detail 仅含：`action / actor / fromVersion / toVersion / hash / grants(数量)`。**不包含** 授权对象名单、理由文本等可能敏感的内容；完整策略内容通过文件版本 + hash 追溯。

## 7. 残余风险（明确登记）

| ID | 问题 | 等级 | 说明 |
| --- | --- | --- | --- |
| R-1 | 有文件权限者可同时改策略与 hash | P2 | 哈希只能发现"只改一处"的篡改；防篡改需签名或 OS 权限 |
| R-2 | actor 是声明值，无密码学身份 | P2 | 本机单用户模型下可接受；远程/多用户不成立 |
| R-3 | 目录 fsync 在 Windows 上无保证 | P3 | 崩溃后可能丢失最后一次 rename（文件仍是完整的旧或新版本） |
| R-4 | `recovery-required` 标记无自动修复 | P2 | 有意设计：人工确认后删除标记；CLI 未提供修复命令 |
| R-5 | 策略变更未提供 CLI/API 管理端点 | P2 | 目前仅库级能力（E-06 未完成） |
| R-6 | 未做跨机器/网络文件系统验证 | P2 | 单机语义 |
