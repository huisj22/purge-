# 恢复测试报告（RECOVERY_TEST_REPORT）

相关测试：
- `tests/recovery-conflict.test.ts`（9 例，P2-08 新增）
- `tests/recovery.test.ts`（10 例，快照/事务）
- `tests/phase4-fault-injection.test.ts` C3（4 例）
- `scripts/acceptance.ts` 第 7 步（端到端）

## 1. 冲突检测（9/9 通过）

| 用例 | 期望 | 实际 | 结果 |
| --- | --- | --- | --- |
| 快照后被修改 | 阻止，且**不改文件** | `conflict`，文件保持 `v1-user-edit` | ✅ |
| 未修改 | 允许，noop | `failed=[]`，内容不变 | ✅ |
| 文件被删除 | 允许（重建） | `DELETED` → 恢复出 `v0` | ✅ |
| 文件比快照新 | `NEWER` 且阻止 | `NEWER`，`blocked=true` | ✅ |
| force 无授权人 | 拒绝 | `policy_denied`，文件未变 | ✅ |
| force + 授权人 | 成功 + 记录 | `force.authorizedBy=alice`、`overwritten[0].fromHash` 正确、有 `preSnapshotId` | ✅ |
| plan 与 apply 之间被改（TOCTOU） | 复检后放弃 | `conflict: state changed between plan and apply`，文件保持外部改动 | ✅ |
| 快照内容损坏 | `CORRUPTED` + 阻止 | 未触碰目标文件 | ✅ |
| 快照后新增的文件（absent 条目） | 默认阻止删除，force 后删除 | 两种情况都符合预期 | ✅ |

## 2. 事务性与回滚（沿用 Phase 4 + 复核）

| 用例 | 结果 |
| --- | --- |
| 单文件失败 → 整体回滚到恢复前 | `rolledBack=true`，a.txt 回到 A1 ✅ |
| 并发恢复同一快照 | 串行化，两个都成功 ✅ |
| 恢复幂等（连续两次） | 最终状态一致 ✅ |
| 快照对象损坏 | 恢复失败且不动目标 ✅ |
| 保护快照（pre-restore） | 每次恢复前生成，id 返回 ✅ |

## 3. 端到端（acceptance 第 7 步）

```
plan → blocked(1)
未授权 restore → HTTP 409
force restore（authorizedBy=acceptance-bot）→ 成功
preSnapshotId 存在
文件内容回到快照值
```
→ `✓ 7 snapshot restore`

## 4. 未覆盖

| 项 | 状态 |
| --- | --- |
| 恢复过程中磁盘写满 | BLOCKED |
| 恢复过程中进程被 SIGKILL | 用 `onBeforeApply` 注入模拟，非真实 kill |
| 目录树结构变化（新增子目录） | 未测 |
| 大量文件（>1000）时的性能 | 未测 |

## 5. 结论

恢复从"尽力而为"升级为"**默认阻止冲突 + 强制需授权 + 预演 + 复检 + 回滚**"，9 个专项用例 + 端到端验证支撑。
仍不能声称"恢复绝对安全"：外部编辑器、ENOSPC、真实崩溃都未验证。
