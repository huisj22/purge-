# Phase 5 进度（PHASE5_PROGRESS）

> 本文件是 Phase 5 的唯一进度来源。每完成一个阶段必须更新。

## 当前状态

| 阶段 | 内容 | 状态 | 证据 |
| --- | --- | --- | --- |
| A | 预检 / 基线 / 计划 / 工程原则 | ✅ 完成 | `BASELINE`（本文件 §基线）、`docs/phase5/PHASE5_PLAN.md`、`docs/ENGINEERING_RULES.md` |
| B | T-035 安装器 + 打包 + CI | ✅ 完成（Linux/macOS CI 未运行 = NOT_VERIFIED） | `src/installer/*`、`scripts/{install,package,ci}.mjs`、`.github/workflows/ci.yml`、`tests/installer.test.ts` |
| C | T-037 跨进程锁 | ✅ 完成 | `src/core/lock.ts`、`tests/lock.test.ts`（11 例）、`docs/phase5/T037_LOCK_AUDIT.md` |
| D | P2-08 恢复冲突检测 | ✅ 完成 | `snapshot.planRestore` + force 授权、`tests/recovery-conflict.test.ts`（9 例） |
| E | P2-10 权限分级 | ✅ 完成（CLI/API 管理端点未做） | `src/security/policy-store.ts`、`tests/policy-hierarchy.test.ts`（10 例） |
| F | T-036 插件进程隔离 | ✅ 完成（PROCESS_ISOLATED，非 OS 沙箱） | `src/plugins/{isolated-host,worker-runtime}.ts`、`tests/plugin-isolation.test.ts`（9 例） |
| G | 全量回归 + 平台矩阵 | ✅ 完成（261 tests） | `reports/phase5/final-tests.txt`、`docs/phase5/PLATFORM_VERIFICATION_MATRIX.md` |
| H | 五批 Commit | ✅ 完成 | `527136d` / `fdc2a9f` / `10267db` / `6ba28d9` / `544fc1a`（+`7ad9591` 收尾） |
| I | 隔离副本真实写入验证 | ✅ 完成（17/17） | `docs/phase5/ISOLATED_HOST_WRITE_VERIFICATION.md`；真实宿主 21789 条哈希未变 |
| J | P2-13 写入口锁 | ✅ PARTIAL→补齐主要入口 | `docs/phase5/P2-13_WRITE_PATH_LOCK_AUDIT.md`、`tests/write-path-locks.test.ts`（6 例） |
| K | GitHub 推送 + CI 矩阵 | ❌ BLOCKED | `docs/phase5/GITHUB_CI_STATUS.md`（无 remote/凭据，exit 128） |

## 基线（Stage A 实测）

| 项 | 值 |
| --- | --- |
| Branch / Commit | `main` / `06b1701`（与任务书一致） |
| Worktree | clean |
| Tests | 197 tests / 45 suites / 0 fail / 0 skip |
| TypeScript | `tsc --noEmit` 0 错误 |
| Acceptance | 14/14 |
| Lint | Phase 5 新增（Phase 4 无 linter）：eslint 9 + typescript-eslint，已修 3 个真实 error |
| Build | 无构建步骤（TS 源码直跑）；打包 = `scripts/package.mjs` 产 tar.gz |

## 阶段记录

### Stage A（2026-11-19）

1. 任务编号：A
2. 实际修改文件：`docs/ENGINEERING_RULES.md`、`docs/phase5/PHASE5_PLAN.md`、`PHASE5_PROGRESS.md`、`PHASE5_TASKS.md`
3. 修改内容：确立 8 条永久工程原则；给出阶段计划与平台约束
4. 新增测试：无（文档阶段）
5. 测试结果：基线复跑通过（197/45/0）
6. 未解决问题：无
7. 当前风险：Phase 4 声明"clean"已核实为真
8. 下一步：T-035

### Stage B（2026-11-19）

1. 任务编号：B / T-035
2. 实际修改文件：
   - 新增 `src/installer/{archive,preflight,installer}.ts`
   - 新增 `scripts/{install,package,ci}.mjs`
   - 新增 `.github/workflows/ci.yml`、`eslint.config.mjs`
   - 新增 `tests/installer.test.ts`
   - 修改 `package.json`（lint/ci/package/install/preflight 脚本）
   - 修改 `src/ui/app.js`（修 lint error：无用表达式、未用变量）
   - 修改 `src/api/server.ts`、`src/cli/main.ts`、`src/ruleskills/frontmatter.ts`、`src/app.ts`（lint 清理）
3. 修改内容：
   - 自研 tar.gz 读写（拒绝 `/`、`..`、超限、截断；不依赖外部包）
   - 打包：MANIFEST.json（逐文件 sha256）+ SHA256SUMS，打包后自校验
   - 前置检查：platform/node/目录可写/磁盘探测/既有安装/未完成安装/运行中实例 → PASS/WARN/FAIL/UNKNOWN
   - 安装状态机：PREFLIGHT→VALIDATING→PREPARING→BACKUP→STAGE→VERIFY→INSTALL→POSTCHECK→COMMIT；失败走 ROLLBACK，回滚失败进 ROLLBACK_FAILED
   - 幂等：源与目标文件集哈希一致 → NOOP
   - 后置验证：真实拉起安装后的 CLI 跑 doctor（要求 exit 0 且含"审计链"）
   - 本地 CI：lint → typecheck → tests → acceptance → package → install → 幂等复装 → 安装后 doctor
4. 新增测试：`tests/installer.test.ts` 19 例（归档/包/前置/状态机/回滚/回滚失败/中断/损坏包/数据保留/哈希忽略）
5. 测试结果：19/19 通过；本地 CI 8/8 通过；全量 216 tests 全绿（见 Stage G 复核）
6. 未解决问题：GitHub Actions 矩阵（windows/ubuntu × node 22/24）未实际运行 → NOT_VERIFIED
7. 当前风险：安装器未在 Linux/macOS 上执行过；文件权限/大小写在那些平台行为未验证
8. 下一步：T-037

### Stage C–G（2026-11-19）

| 阶段 | 修改文件 | 新增测试 | 结果 | 未解决 |
| --- | --- | --- | --- | --- |
| C T-037 | `src/core/lock.ts`、`configcenter/managed.ts`、`recovery/snapshot.ts`、`plugins/host.ts`、`update/service.ts`、`packs/engine.ts`、`installer/installer.ts`、`api/server.ts`、`cli/main.ts` | `tests/lock.test.ts`（11） | 11/11 | 规则/技能/自身配置未接锁（P2-13） |
| D P2-08 | `recovery/snapshot.ts`（planRestore/force/TOCTOU）、`api/server.ts`、`cli/main.ts`、`packs/engine.ts`、`recovery/transaction.ts` | `tests/recovery-conflict.test.ts`（9） | 9/9 | ENOSPC/真实崩溃未验 |
| E P2-10 | `src/security/policy-store.ts`、`app.ts`（guarded 串联） | `tests/policy-hierarchy.test.ts`（10） | 10/10 | 策略写入未加锁（P2-15）、无 CLI/API 管理端点 |
| F T-036 | `src/plugins/{worker-runtime,isolated-host,host}.ts`、`core/config.ts`、`app.ts` | `tests/plugin-isolation.test.ts`（9） | 9/9 | OS 沙箱未实现（BLOCKED）；能力为服务级（P2-14） |
| G | `scripts/acceptance.ts`（第 7 步改为 plan→409→force） | — | 255 tests / tsc 0 / lint 0 / acceptance 14/14 / 本地 CI 8/8 | GitHub Actions 未运行 |

**最终数字（收尾轮）**：261 tests / 56 suites / 0 fail / 0 skip；`tsc --noEmit` 0 错误；eslint 0 error；acceptance 14/14；本地 CI 8/8；隔离副本写入 17/17；真实宿主哈希未变。
**Git**：分支 `main`，HEAD 仍为 `06b1701`，40 个文件有未提交修改（按任务书未自动 Commit）。