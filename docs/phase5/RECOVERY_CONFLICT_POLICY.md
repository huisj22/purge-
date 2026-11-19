# 恢复冲突策略（RECOVERY_CONFLICT_POLICY，P2-08）

## 1. 问题

Phase 4 的 `restore()` 会无条件用快照内容覆盖当前文件。若用户在拍照之后修改了文件，恢复会**静默丢弃**这些修改。快照完好 ≠ 恢复安全。

## 2. 状态定义

| 状态 | 含义 | 默认策略 |
| --- | --- | --- |
| `UNCHANGED` | 当前内容哈希 == 快照哈希 | 允许（noop） |
| `DELETED` | 快照有文件、当前不存在 | 允许（恢复即重建） |
| `MODIFIED` | 当前存在但哈希不同，且 mtime ≤ 快照时间 | **阻止** |
| `NEWER` | 当前存在且 mtime > 快照创建时间（更晚的修改） | **阻止** |
| `CORRUPTED` | 快照自身内容不可用（对象缺失/哈希不符/内联损坏） | **阻止** |
| `UNKNOWN` | 无法读取当前文件或无法判定 | **阻止** |

`absent` 条目（快照时不存在）：当前存在 → 判 `MODIFIED`、动作 `delete`（默认阻止，因为恢复会删掉新文件）。

## 3. 协议

```
planRestore(snapId)              只读，逐文件给状态 + 计数 + blocked
      ↓
restore(snapId, {policy})        policy=block（默认）/ force
      ↓
  有冲突且 block → 抛 conflict（detail 带完整 plan）
      ↓
  拍 pre-restore 保护快照
      ↓
  TOCTOU 复检（onBeforeApply 之后再 plan 一次）
      ↓
  逐条应用 → 失败回滚 → 验证回滚结果
```

## 4. 强制恢复（force）的硬性要求

| 要求 | 实现 |
| --- | --- |
| 必须显式指定 | `policy: "force"` |
| 必须给出授权人 | `authorizedBy`（空 → `policy_denied`） |
| 必须记录理由 | `reason`（可选但记录） |
| 必须先备份 | 自动 `pre-restore` 快照，id 返回 |
| 必须记录覆盖哈希 | 返回 `force.overwritten[{path, fromHash, toHash}]` |
| AI/Workflow/Plugin 不得自行强制 | 入口层：API/CLI 是 human origin；AI 走 `advisor` 角色，L3 被拒（见 POLICY_HIERARCHY） |

## 5. 调用方约定

| 调用方 | 策略 |
| --- | --- |
| CLI `snapshot restore` | 默认 block；`--force --by <who> [--reason]` 才覆盖 |
| API `POST /api/snapshots/:id/restore` | 默认 block；`{force:true, authorizedBy, reason}` |
| `Transaction.rollback` | force + `authorizedBy: transaction:<actor>`（回滚自身变更） |
| `PackEngine.revert` | force + `authorizedBy: pack-engine`（撤销自己的 apply） |
| 新增 `GET /api/snapshots/:id/plan` / CLI `snapshot plan` | 只读预演 |

## 6. 已知限制

1. **时间戳不可靠**：`NEWER` 依赖 mtime；如果外部工具把 mtime 改回旧值，只能退化为 `MODIFIED`（仍然阻止）。
2. **目录级恢复**：当前只处理文件与 absent，不处理整个目录树的增删（目录按条目展开）。
3. **跨进程**：恢复已加 global 锁，另一个进程的写会被阻塞；但**外部编辑器**不受锁约束，只能靠 TOCTOU 复检缩小窗口（不是消除）。
4. **回滚失败**：仍可能发生（例如父目录被占成文件），此时返回 `rolledBack=false` + `rollbackFailed`，需要人工介入，系统不会报告成功。
