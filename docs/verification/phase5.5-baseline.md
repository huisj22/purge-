# Phase 5.5 基线审计（BASELINE）

审计时间：2026-11-19 · 执行者：Agent（未修改任何代码）

---

## 1. Git 状态（实测）

| 项 | 值 |
| --- | --- |
| 分支 | `phase5/verification` |
| HEAD | `77a5c1a7a7c3c36d9cb82b6046129c290f1b908e` |
| 工作树 | clean（`git status --porcelain` 无输出） |
| origin | `https://github.com/huisj22/purge-.git` |
| 上游 | `origin/phase5/verification`，`git rev-list --left-right --count` = `0 0`（完全同步） |
| 远端分支 | `main` → `e53cbef`；`phase5/verification` → `77a5c1a` |
| 本地 `main` | `7ad9591`（**与 origin/main 不同**；未推送、未修改） |
| 是否触碰 main | 否 |

**结论**：基线成立，可在此基础上创建 `phase5.5/security-closure`。

## 2. 测试与静态检查（实测）

| 项 | 结果 |
| --- | --- |
| 测试 | 261 tests / 56 suites / 0 fail / 0 skip |
| TypeScript | 0 错误 |
| ESLint | 0 错误 |
| Acceptance | 14/14 |

证据：`reports/phase5.5/baseline-tests.txt`

## 3. 当前 CI 矩阵

| 项 | 值 |
| --- | --- |
| workflow | `.github/workflows/ci.yml`（`CI`） |
| 触发 | `push`（main, phase5/**；忽略 docs/reports）、`pull_request`、`workflow_dispatch` |
| 矩阵 | `os: [windows-latest, ubuntu-latest, macos-latest]` × `node: ["24"]` = **3 组合** |
| 目标 | 6 组合（补 Node 22.18+） |
| artifact job | `ubuntu-latest`，`needs: verify` |

## 4. 写入口盘点（初步，代码实测）

搜索模式：`writeFile|atomicWriteFile|mkdir(|.rm(|unlink(|rename(|prepare("INSERT|DELETE|UPDATE)`

| 模块 | 文件 | 实际写入点 | 并发保护 | 原子 | 风险 |
| --- | --- | --- | --- | --- | --- |
| Config Center | `configcenter/managed.ts` | `#commitLocked` → 文件 + history/index | ✅ global→config | ✅ | 无审计事件（P3） |
| Self-Config | `core/config.ts` | `#updateLocked` → config.json | ✅ global→setting | ✅ | — |
| Rules | `ruleskills/rules.ts` | create/update/remove | ✅ global→rules | ✅ | — |
| Skills | `ruleskills/skills.ts` | import/remove | ✅ global→skills | ✅ | 备份 GC 未实现（P3） |
| Audit Append | `storage/audit.ts` | `append`（INSERT） | ✅ BEGIN IMMEDIATE | ✅ | — |
| **Audit Prune** | `storage/audit.ts` | **不存在** | — | — | **无保留策略，表无限增长（P2）** |
| Logs Prune | `storage/logs.ts` | `DELETE ... LIMIT` | ❌ | SQLite 语句级 | 无审计（P3） |
| Trace | `storage/trace.ts` | INSERT/UPDATE | ❌ | SQLite 语句级 | — |
| Snapshot capture/restore | `recovery/snapshot.ts` | 对象写 + 行插入 | ✅ global→snapshot | ✅ | — |
| **Snapshot prune** | `recovery/snapshot.ts` | 删除未引用对象 | ❌ **无锁** | ❌ | **与 capture 竞争可删掉"已写入对象、未插行"的内容 → 快照损坏（P1）** |
| Packs store | `packs/store.ts` | `importPack` → pack 文件 + index.json | ❌ **无锁** | ✅（单文件） | 两进程并发导入 → index 丢更新（P2） |
| Pack apply/revert | `packs/engine.ts` | 事务写 | ✅ global→pack | ✅ | — |
| Plugin install/remove | `plugins/host.ts` | 复制目录 + state | ✅ global→plugin | 部分 | — |
| **Plugin enable/disable** | `plugins/host.ts` | `#saveState` | ❌ **无锁** | ✅ | 并发 enable/disable 丢状态（P2） |
| **Plugin data** | `plugins/host.ts` | `<plugins>/<name>@<ver>/.data/store.json` | ❌ | ✅ | **数据在版本目录内：升级即丢数据；卸载即删用户数据（P1/P2）** |
| **Policy Store** | `security/policy-store.ts` | `#persist` | ❌ **无锁** | ✅（atomicWriteFile） | **无版本 CAS、无写后复读；并发可丢授予、可复活已撤销权限（P1）** |
| Update stage/activate | `update/service.ts` | 写 staging + 指针 | ✅ global→update（activate） | ✅ | — |
| **Update prune** | `update/service.ts` | 删除旧版本目录 | ❌ **无锁** | ❌ | 可能删掉唯一可回滚版本/正在使用的版本（P1） |
| Installer | `installer/installer.ts` | 目录切换 + 状态 | ✅ install 锁 | ✅ | — |
| Scheduler | `scheduler/scheduler.ts` | INSERT/DELETE job | ❌ | SQLite | 单机单写者假设（P3） |
| Workflow | `workflow/engine.ts` | run/step 状态 | ❌ | SQLite | 同上 |
| Diagnostics | `inspector/diagnostics.ts` | INSERT OR REPLACE run | ❌ | SQLite | 同上 |
| CLI/API | `cli/main.ts`、`api/server.ts` | 全部经 service | 继承 service | — | 需逐条确认无直写 |

## 5. 六个工作包的代码入口与初步风险

| 工作包 | 主要入口 | 初步风险 |
| --- | --- | --- |
| T055-01 写入口闭合 | `snapshot.prune`、`update.prune`、`packs/store.importPack`、`plugins.host.#saveState`、`logs.prune`、`audit.prune`(缺) | P1×2（快照 GC 竞争、更新 GC 误删）、P2×3 |
| T055-02 Policy Store | `security/policy-store.ts#persist`/`grant`/`revoke`/`load` | **P1**：无跨进程锁、无版本 CAS、无写后复读 |
| T055-03 Plugin Data | `plugins/host.ts` 数据目录、`worker-runtime.ts` `PURGE_PLUGIN_DATA` | **P1/P2**：数据在版本目录内、无边界校验、可写核心目录 |
| T055-04 Node 22 CI | `.github/workflows/ci.yml` | 无 P0/P1；无 Node 22 证据 |
| T055-05 Branch Protection | GitHub API / 仓库设置 | 权限未知，可能需要 BLOCKED |
| T055-06 独立验收 | 全部 | 依赖前五项 |

## 6. 预计修改文件

| 工作包 | 文件 |
| --- | --- |
| T055-01 | `src/recovery/snapshot.ts`、`src/update/service.ts`、`src/packs/store.ts`、`src/plugins/host.ts`、`src/storage/logs.ts`、`src/storage/audit.ts`、`src/app.ts`（接线）、新增 `tests/write-path-*.test.ts` |
| T055-02 | `src/security/policy-store.ts`、`src/app.ts`、`tests/policy-store-hardening.test.ts` |
| T055-03 | `src/plugins/host.ts`、`src/plugins/isolated-host.ts`、`src/plugins/worker-runtime.ts`、`src/core/paths.ts`(新增，如需要)、`tests/plugin-data-policy.test.ts` |
| T055-04 | `.github/workflows/ci.yml`、`tests/ci-lifecycle.test.ts`(新增) |
| T055-05 | 无代码（GitHub 设置）；文档 |
| T055-06 | 文档 + 可能的补测 |

## 7. 可能影响现有架构的地方

1. **Plugin 数据目录迁移**：现在 `<dataDir>/plugins/<name>@<version>/.data`，需迁到 `<dataDir>/plugin-data/<name>/`。涉及升级/卸载语义与向后兼容（旧数据需迁移或明确不迁移）。
2. **`PolicyStore` 增加 CAS**：`grant/revoke/setOwner` 需要 `expectedVersion` 参数 → 现有调用点（tests、app）需同步。
3. **`snapshot.prune` / `update.prune` 加锁**：会与 capture/activate 串行化，可能影响并发性能（可接受）。
4. **Audit Prune 新增**：涉及保留策略（按条数/天数），并需要"不可删空洞"的语义设计。
5. **Node 22 matrix**：可能暴露 Node 22 与 24 的行为差异（如 `node:sqlite` 实验性差异）。

## 8. 基线结论

- 基线可用，无未提交改动需要保护。
- 已识别 **4 个 P1**（快照 GC 竞争、更新 GC 误删、Policy 无并发控制、插件数据随版本目录消亡）与 **5 个 P2**。
- 按任务书要求，P1 必须在对应工作包内修复并复验后，才可继续依赖该边界的工作包。
