# B5 · Config Center 审计

范围：`src/configcenter/managed.ts`（读/差异/提交/历史）
方法：代码直读 + 探针 C/K + 并发探针

## 已确认事实

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 读取带内容哈希 | 正确（sha256 of bytes） | `tests/configcenter.test.ts` |
| 文件不存在返回 `exists:false` 而非抛错 | 正确 | 同上 |
| 行级 diff（LCS）不写盘 | 正确（测试断言磁盘未变） | 同上 |
| 提交前 hash 守卫（外部修改） | 正确：单一客户端场景能识别外部改动并 `conflict` | 同上 + `tests/api.test.ts` |
| 写后回读校验 | 正确（`integrity_failed`） | CODE_CONFIRMED |
| 历史（内容寻址 + index.json） | 正确（可按 id 取回、可 diff） | 同上 |
| 大文件保护 | 有：LCS 超过 4,000,000 组合时退化为前后缀匹配（避免 O(n·m) 爆炸） | CODE_CONFIRMED |
| 空文件 | 可处理（hash of empty） | CODE_CONFIRMED |

## 发现的问题

### P2-02 · 并发提交不安全（既非串行，也不是明确的 conflict） — VERIFIED

`commit()` 的「读 hash → 比较 → 写 → 回读」之间没有锁。两个客户端读到同一 hash 后同时提交：

探针 C（`probes/c-config-lost-update.ts`）：

```
fulfilled: 1
rejected : 1  → code=integrity_failed
             "post-write verification failed for ...\target.json"
finalContent: {"v":"A"}      ← 后写者覆盖先写者
PROBE_RESULT=guarded（仅因回读发现被别人覆盖）
```

问题有两层：
1. **语义错误**：并发竞争被报成 `integrity_failed`（数据完整性问题），而实际是并发冲突，应为 `conflict`。用户按提示会去查磁盘损坏，方向错了。
2. **历史索引 RMW 竞争**：`#record()` 读 `index.json` → push → 写回，两步之间无锁。两个并发提交会丢掉其中一条历史（静默的数据丢失），且不会报错。
3. **时间窗口内可能双成功**：如果两次写入内容相同（或第一次回读发生在第二次写之前），两个客户端都会收到成功，但历史只留一条。

### P3-13 · 提交与历史记录不是原子的 — CODE_CONFIRMED

`commit()` 先写目标文件，再 `#record()`。若记录阶段失败（磁盘满/权限），调用方收到异常，但**文件已经被改**，且没有任何历史可回滚。这与「变更必须可追溯」的不变量冲突。

### 无文件锁

全仓库没有跨进程文件锁（原项目有 `maintenance-lock`，Purge+ 未继承）。多个 Purge+ 进程同时操作同一文件时，上述竞争会跨进程发生。

## 并发矩阵

| 场景 | 当前行为 | 是否可接受 |
| --- | --- | --- |
| 单客户端顺序提交 | 正确（hash 守卫生效） | ✅ |
| 两客户端并发提交不同内容 | 一个成功、一个 `integrity_failed`，历史丢一条 | ❌ P2-02 |
| 提交与外部编辑器同时写 | 谁后写谁赢；守卫只能发现"提交前"的变化 | ⚠️ 部分 |
| 提交期间进程被 kill | 目标文件可能已改、历史未写 | ❌ P3-13 |

## 结论

单机单进程的正常路径是可靠的（hash 守卫是这个模块的亮点，探针与测试都能证明外部改动**不会**被静默覆盖）。但并发与"写成功但记录失败"两条路径需要修复。
