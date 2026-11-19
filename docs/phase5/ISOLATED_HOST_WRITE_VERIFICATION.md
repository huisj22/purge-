# 隔离副本真实写入验证（ISOLATED_HOST_WRITE_VERIFICATION）

执行时间：2026-11-19 · 平台：Windows 11 x64 · Node v24.1.0
脚本：`scripts/phase5/isolated-write-verify.ts`（证据：`reports/phase5/isolated-write-run.txt`）

---

## 1. 隔离目录与真实宿主

| 项 | 路径 |
| --- | --- |
| 真实宿主（只读） | `C:\Users\chenw\AppData\Local\Programs\DeepSeek Harness\resources` |
| 隔离副本（可写） | `%TEMP%\p5-iso-<random>`（每次新建，验证后删除） |
| 副本内容 | `app/`（21,788 文件 / 473,331,076 B）+ `app.asar`（209,083,008 B） |
| 副本生成方式 | `robocopy <real> <iso> /E`（源只读，不修改） |

**副本保真证明**（脚本 step 1d）：对 `ISO/app` 与 `REAL/app` 分别计算"相对路径 + sha256"的树哈希，两者一致：

```
files=21788  bytes=473331076  digest=9df920452cc2fb7e…
✓ 1d 副本与真实宿主 app/ 树哈希一致（保真）
```

## 2. 真实宿主哈希（测试前 / 测试后）

| 时点 | 记录数 | app.asar SHA256 |
| --- | --- | --- |
| 测试前 | 21,790 行（21,788 文件 + asar + 头注释） | `5ec8acd9e72b93b6680c953c1be44a729fd3a5170e472e8025690a1713d20f69` |
| 测试后 | 同上 | 同上 |

比对结果：**IDENTICAL（21,789 条记录逐条一致，0 差异）**。
原始清单：`reports/phase5/isolated-real-host-before.txt` / `-after.txt`。

## 3. 每个操作的实际解析路径

| 操作 | 实际路径 | 是否在 ISO 内 |
| --- | --- | --- |
| Adapter 候选发现 | `<ISO>` | ✅ |
| Adapter 取证 unpacked | `<ISO>\app` | ✅ |
| Pack 规则目标 | `<ISO>\app\dsh\node_modules\@deepseek-ai\dsh-user-approval\lib\types\index.js` | ✅ |
| Pack apply 写入 | 同上（transaction 前对每个 target 做 realpath 断言） | ✅ |
| 快照 capture | 同上 | ✅ |
| 快照 restore（force） | 同上 | ✅ |
| Pack revert | 同上 | ✅ |
| 安装目录 | `<ISO>\_purgeplus\installed-app` | ✅ |
| 快照/事务库 | `<ISO>\_purgeplus\purgeplus.db` | ✅ |

脚本内置硬断言：任何 target 在 `realpath` 后不在 ISO 内、或落入 REAL，立即抛 `ESCAPE DETECTED` 并中止。

## 4. 写入文件清单

| 文件 | 操作 | 结果 |
| --- | --- | --- |
| `<ISO>\app\dsh\node_modules\@deepseek-ai\dsh-user-approval\lib\types\index.js` | pack apply（追加 `// [purge-plus-iso]`） | ✅ 仅此 1 个文件被改 |
| 同上 | 快照恢复（force） | ✅ 回到 apply 后内容 |
| 同上 | pack revert（事务回滚） | ✅ 回到原始内容 |
| `<ISO>\_purgeplus\installed-app\**` | 安装（约 109 文件） | ✅ 全部在 ISO 内 |
| `<ISO>\_purgeplus\purgeplus.db`、`objects/*`、`snapshots` | 快照/事务元数据 | ✅ |

真实宿主：**0 个文件被写入**（见 §2 哈希一致）。

## 5. 回滚结果

| 场景 | 结果 |
| --- | --- |
| 未授权恢复（有冲突） | 被拒（HTTP/异常），文件保持"被篡改"状态，**未被覆盖** |
| force 恢复 | 成功，`preSnapshotId` 已生成，`overwritten=[{fromHash,toHash}]` 记录完整 |
| pack revert（事务回滚） | 成功，内容回到原始字节 |

## 6. 路径逃逸测试

| 用例 | 期望 | 实际 |
| --- | --- | --- |
| pack 规则 `path: "../app.asar"` | 校验阶段拒绝 | ✅ `validatePack` 抛 `policy_denied`（`escaping base root`） |
| 事务 target 越界 | 立即中止 | ✅ 脚本断言（未被触发，因为规则先被拒） |
| `absent` 条目删除越界路径 | 不适用（快照只含 ISO 内路径） | — |

## 7. 符号链接 / Junction 测试

在 `<ISO>\app\_iso-link-test` 内创建指向**真实宿主**的链接（本机普通用户无法创建 symlink，实际创建的是 **junction**）：

```
link=junction
✓ 7a 快照不会跟随符号链接/junction — captured=0
✓ 7b 删除链接目录后真实宿主 package.json 仍存在
```

结论：快照（`#capturePath` 用 `lstat` 并跳过链接）与删除（`removeTreeNoFollow`）都不会跟随链接进入真实宿主。

## 8. Adapter 是否存在"自动回退到真实宿主"的逻辑？

代码审计（`src/adapters/dsh.ts`）：

- `discover()` 只遍历 `extraRoots` 与（可选）平台默认路径；测试中 `includeDefaults: false` 且 `extraRoots=[ISO]` → 仅 1 个候选（step 1a 断言）。
- `inspect()` 只使用 `candidate.resourcesDir`，不搜索其它安装。
- 唯一的"真实路径"来源是 `#resolveHome()`：`dshHome` 显式传入时为 ISO 内目录；缺省时才读 `DSH_HOME`/`~/.dsh` —— **只读**（读取 profile 列表），不会写入。
- 没有 "fallback to real host" 分支（无 try/catch 回退、无全局搜索）。

结论：**不存在自动回退到真实宿主的写入路径**。`~/.dsh` 的读取属预期行为（诊断需要），且不落盘。

## 9. 安装 / 卸载（隔离目录）

```
✓ 8a 隔离目录安装成功 — version=0.1.0-alpha.1 idempotent=false
✓ 8b 卸载保留数据目录 — removed=1
```

## 10. 最终结论

| 判定 | 结果 |
| --- | --- |
| 隔离边界是否被证明 | ✅ 是（realpath 断言 + 副本树哈希 + 链接测试 + 真实宿主前后哈希一致） |
| 真实宿主是否被修改 | ❌ 否（21,789 条记录逐条一致） |
| 是否执行真实写入 | ✅ 是，但**只发生在隔离副本** |
| 覆盖了哪些写操作 | pack apply / snapshot capture / restore（含 force）/ rollback / install / uninstall |
| 未覆盖 | 真实宿主的写操作（按安全规则禁止）；归档换包；真实进程重启 |

**证据等级**：`PLATFORM_VERIFIED`（Windows 11）+ `ISOLATED_WRITE_VERIFIED`（副本上的真实写入）。
仍**不是** `REAL_HOST_WRITE_VERIFIED`——按任务书要求，对真实宿主的写操作在本轮被明确禁止。
