# B13 · Update Center 审计

范围：`src/update/{version,service}.ts`

## 已确认事实

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| semver 比较（含 prerelease、数字段 < 字母段） | 正确 | `tests/update.test.ts` |
| 非法版本被拒 | 正确 | 同上 |
| 索引校验（schema/version/artifacts/sha256 格式/文件名） | 正确 | 同上 |
| check 与 install 分离（check 只写状态，不激活） | 正确 | 同上 |
| 通道过滤 | 正确 | 同上 |
| stage：大小 + sha256 双校验，失败清理 staging | 正确 | 同上 |
| activate：staging → versions/<v>，记录 previous 指针 | 正确 | 同上 |
| 未知版本 → `not_found` 并列出已知版本 | 正确 | 同上 |

## 发现的问题

### P2-07 · HTTP 抓取无超时 + 同版本重复激活无备份 — CODE_CONFIRMED

1. `#fetch()` 对 `http(s)` 直接 `await fetch(source)`，没有 `AbortSignal.timeout`。索引里给一个不响应的 URL，`stage()` 会挂到 TCP 超时（可能数分钟），且没有取消手段（API 请求会一直挂着）。
2. `activate()` 对已存在的目标目录执行 `removeTreeNoFollow(targetDir)` 后 `rename`。若用户对**同一版本**重新激活（或索引被篡改后重放），旧目录被直接删除，**没有备份**——与"更新必须可回滚"的目标不一致。

### P3-10 · 旧版本永不清理 + 索引不校验来源协议 — CODE_CONFIRMED

- `versions/<v>` 只增不减，没有 `prune`。
- `validateIndex()` 不校验 `artifact.source` 的协议（`file:`/`http:`/`https:`），也没有对 `file:` 之外的来源做任何限制。当前设计=离线优先，可接受，但应显式拒绝未知协议（避免 `file://` 之外的意外行为）。

### 依赖与版本冲突

没有依赖图概念（Purge+ 自身是零依赖运行时）。`plan()` 只比较自身版本，不检查与已装插件的兼容性。属能力缺口（P3-22），不是缺陷。

### 中断更新

| 阶段 | 中断后果 | 评价 |
| --- | --- | --- |
| fetch 中 | 无落盘，staging 未创建 | ✅ 安全 |
| stage 写文件途中 | staging 目录残留（未清理，因为异常路径只在 catch 里清理） | ⚠️ 残留磁盘 |
| activate rename 前 | 旧版本不受影响 | ✅ |
| activate rename 后（指针写入前） | 新目录已就位但 state 未更新 → 下次 activate 会再次 remove+rename | ⚠️ 无数据丢失但状态不一致 |

"更新失败后系统能否启动"：**能**。`activate` 不触碰正在运行的代码（只写 `update/versions/` 与 `state.json`），且 `app.ts` 不依赖 update 状态启动。这一点已被探针与验收脚本间接证明（update 失败后 API 仍可用）。

## 结论

分阶段 + 双校验是本模块的亮点，与上一代工具"下载即安装"相比是实质改进。待修：超时（P2-07a）、同版本覆盖无备份（P2-07b）、旧版本清理与协议校验（P3-10）。
