# GitHub CI 状态（GITHUB_CI_STATUS）

仓库：`https://github.com/huisj22/purge-` · 分支 `phase5/verification`（未触碰 `main`）
最后更新：2026-11-19 22:1x（本地时间）

---

## 1. 最终结果

| Run | Commit | 结果 | Windows | Ubuntu | macOS | artifact |
| --- | --- | --- | --- | --- | --- | --- |
| [44538278925](https://github.com/huisj22/purge-/actions/runs/44538278925) | `97b56b1` | ❌ failure | ❌ | ❌ | ❌ | skipped |
| [44538840162](https://github.com/huisj22/purge-/actions/runs/44538840162) | `1272ed4` | ❌ failure | ✅ | ❌ | ❌ | skipped |
| [44540146301](https://github.com/huisj22/purge-/actions/runs/44540146301) | `4d9800e` | ✅ **success** | ✅ | ✅ | ✅ | ✅ |

**平台验证标记**

| 标记 | 状态 |
| --- | --- |
| `LOCAL_WINDOWS_11_VERIFIED` | ✅ TRUE（261 tests / tsc / lint / acceptance 14-14 / 本地 CI 8-8 / 隔离写入 17-17） |
| `GITHUB_WINDOWS_RUNNER_VERIFIED` | ✅ TRUE（run 44540146301，73s，verify job 全绿） |
| `GITHUB_UBUNTU_RUNNER_VERIFIED` | ✅ TRUE（同一 run） |
| `GITHUB_MACOS_RUNNER_VERIFIED` | ✅ TRUE（同一 run；matrix 新增 macos-latest） |

## 2. 三次运行解决的**真实缺陷**（CI 的价值，不是形式主义）

### 2.1 第一轮：`install` 脚本被当作生命周期钩子

所有平台在 "Install dependencies" 步骤失败（9–28s）。

根因：`package.json` 里有 `"install": "node scripts/install.mjs"`。npm/pnpm 把 `install` 当生命周期钩子，在依赖安装后**自动执行**；该脚本要求 `--install-dir`，于是退出码 2。
本地之所以没暴露：我一直用 `pnpm add`/直接 `node` 跑命令，从未在干净目录执行裸 `pnpm install`。

修复（`1272ed4`）：`install` → `install:app`。在干净副本里复现验证 `pnpm install` 退出码 0。

### 2.2 第二轮：`ENOTDIR` 跨平台差异

Windows 通过，Ubuntu/macOS 在两个恢复回滚用例上失败：

```
✖ restoring a snapshot whose parent path became a file reports failure and rolls back
  AssertionError: false !== true   (rolledBack)
✖ rolls back to the pre-restore state when one target cannot be restored
```

根因：当目标路径的父路径变成普通文件时，`fs.rm(target)` 在 POSIX 抛 `ENOTDIR`，在 Windows 抛 `ENOENT`。`force:true` 只忽略 `ENOENT`，于是 POSIX 上"确保不存在"被记成失败，回滚结果变成 `rolledBack=false`。

修复（`4d9800e`）：`absent` 条目删除时同时把 `ENOTDIR` 视为"该路径不可能存在"，即需求已满足。
语义上正确，且让三平台结果一致。

## 3. 过程记录（不做"绿色至上"的粉饰）

| 动作 | 结果 |
| --- | --- |
| `git remote -v`（初始） | 空 |
| `git push` 直连（无 proxy） | 首次成功；后续 5 次连接超时（网络波动） |
| `git push` 经 `127.0.0.1:7897` + `HTTP/1.1` | 成功（HTTP/2 经该代理会 408） |
| 推送 `main` | **未执行**（只推验证分支） |
| 探针候选 URL | `purge.git` 不存在；`purge-` 存在（真实名含尾部连字符） |

## 4. Workflow 安全性

- 触发：`push`（main / phase5/**）、`pull_request`、`workflow_dispatch`
- 步骤仅：checkout → pnpm → install → lint → typecheck → test → acceptance → package+install smoke
- **无** secrets 引用、**无** deploy/release/publish、**无**宿主修改
- artifact job 仅上传 tar.gz 包

## 5. 仍未验证

| 项 | 状态 |
| --- | --- |
| Node 22 运行时 | NOT_VERIFIED（matrix 仅 24；`engines` 已修正为 >=22.18） |
| 真实宿主机写入（Windows/macOS/Linux 上的 DSH 实例） | BLOCKED（按安全规则禁止） |
| Actions 缓存命中率/长跑稳定性 | 未评估（仅 3 次运行） |
| 分支保护 / 强制检查 | 未配置（需仓库管理员） |
