# Phase 5 任务台账（PHASE5_TASKS）

状态：`todo` / `doing` / `done` / `blocked` / `not_verified`

| ID | 任务 | 优先级 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| A-01 | 预检（git/结构/环境） | P0 | done | `PHASE5_PROGRESS.md` §基线 |
| A-02 | 基线复跑 | P0 | done | 197 tests / 45 suites / 0 fail；tsc 0；acceptance 14/14 |
| A-03 | 工程原则写入仓库 | P0 | done | `docs/ENGINEERING_RULES.md`（8 条） |
| A-04 | 计划与进度文件 | P1 | done | `docs/phase5/PHASE5_PLAN.md`、`PHASE5_PROGRESS.md`、本文件 |
| B-01 | 归档读写（tar.gz） | P0 | done | `src/installer/archive.ts` + 4 例 |
| B-02 | 前置检查（PASS/WARN/FAIL/UNKNOWN） | P0 | done | `preflight.ts` + 4 例 |
| B-03 | 安装状态机 + 回滚 | P0 | done | `installer.ts` + 5 例 |
| B-04 | 幂等 | P0 | done | 复装 NOOP（测试 + 实机） |
| B-05 | 后置验证（doctor） | P0 | done | 实机 `后置检查：通过` |
| B-06 | 打包 + 自校验 | P0 | done | `scripts/package.mjs`（109 文件 / sha256） |
| B-07 | 卸载（保留数据） | P1 | done | 2 例 |
| B-08 | 本地 CI | P0 | done | `scripts/ci.mjs` 8/8 |
| B-09 | GitHub Actions 配置 | P1 | blocked | 无 remote/凭据；见 `docs/phase5/GITHUB_CI_STATUS.md` |
| B-10 | Lint 落地 | P1 | done | eslint 9 + typescript-eslint，0 error |
| C-01 | 跨进程锁实现 | P0 | done | `src/core/lock.ts` |
| C-02 | 锁元数据/状态/层级 | P0 | done | 6 状态 + 5 层级 |
| C-03 | Stale 回收留痕 | P0 | done | Case C |
| C-04 | 写路径接入 | P0 | done | config/snapshot/plugin/update/pack/install |
| C-05 | Case A–G 子进程测试 | P0 | done | 11 例通过 |
| C-06 | 锁诊断（API/CLI） | P2 | done | `/api/locks`、`purgeplus locks` |
| C-07 | 规则/技能/自身配置加锁 | P2 | done（PARTIAL：prune/备份GC 未覆盖） | `tests/write-path-locks.test.ts` |
| D-01 | 恢复预演（planRestore） | P0 | done | 6 状态 |
| D-02 | 默认阻止 + force 授权 | P0 | done | 9 例 |
| D-03 | TOCTOU 复检 | P0 | done | 专项用例 |
| D-04 | 保护快照 + 覆盖哈希记录 | P0 | done | `force.overwritten` |
| E-01 | 角色/等级模型 | P0 | done | `src/security/policy-store.ts` |
| E-02 | owner-only 授予/撤销 | P0 | done | 10 例 |
| E-03 | TTL / 撤销 | P0 | done | 专项用例 |
| E-04 | 策略哈希完整性 | P0 | done | 篡改检测 |
| E-05 | 与风险层串联 | P0 | done | `PurgeApp.guarded` |
| E-06 | CLI/API 的策略管理端点 | P2 | todo | 当前只有库级能力 |
| F-01 | Worker 进程 + IPC schema | P0 | done | `worker-runtime.ts` |
| F-02 | Host 侧能力审批 | P0 | done | `isolated-host.ts` + 9 例 |
| F-03 | 超时/崩溃隔离/清理 | P0 | done | 专项用例 |
| F-04 | `plugins.isolation` 配置切换 | P1 | done | 默认 in-process，可切 process |
| F-05 | OS 沙箱 | P1 | blocked | 未实现（见 T036 审计 §5） |
| G-01 | 全量回归 | P0 | done | 255 tests / 55 suites / 0 fail |
| G-02 | 类型检查 / Lint | P0 | done | 0 / 0 |
| G-03 | 验收 | P0 | done | 14/14（第 7 步含冲突检测） |
| G-04 | 平台矩阵 | P1 | done | `PLATFORM_VERIFICATION_MATRIX.md` |
| G-05 | 剩余风险登记 | P1 | done | `REMAINING_RISK_REGISTER.md` |
| G-06 | 最终报告 | P0 | done | `PHASE5_FINAL_REPORT.md` |

## 收尾轮新增（2026-11-19）

| ID | 任务 | 状态 | 证据 |
| --- | --- | --- | --- |
| H-01 | 五批 Commit（按依赖顺序） | done | `527136d` lock → `fdc2a9f` installer → `10267db` recovery → `6ba28d9` policy → `544fc1a` plugin |
| I-01 | 隔离副本真实写入（apply/snapshot/restore/force/rollback/install/uninstall） | done（17/17） | `docs/phase5/ISOLATED_HOST_WRITE_VERIFICATION.md` |
| I-02 | 真实宿主前后哈希比对 | done（IDENTICAL 21789） | `reports/phase5/isolated-real-host-{before,after}.txt` |
| I-03 | 路径逃逸 / 符号链接 / junction 测试 | done | 同上 §6/§7 |
| J-01 | Rules/Skills/Self-Config 加锁 | done | `tests/write-path-locks.test.ts` |
| J-02 | Audit 并发（事务化 seq） | done（修复 UNIQUE 冲突） | 同上 |
| K-01 | 推送 `phase5/verification` | done | 直连/代理各一次成功；`origin` = huisj22/purge- |
| K-02 | GitHub Windows/Ubuntu/macOS CI | done（全绿） | run 44540146301 |
## 收尾轮 2（2026-11-19 22:1x）

| ID | 任务 | 状态 | 证据 |
| --- | --- | --- | --- |
| K-03 | 修复 `install` 生命周期钩子 | done | `1272ed4`；干净副本 `pnpm install` exit 0 |
| K-04 | 修复 ENOTDIR/ENOENT 差异 | done | `4d9800e`；Ubuntu/macOS 转绿 |
| K-05 | matrix 增加 macOS | done | `97b56b1`；三平台实跑通过 |
| K-06 | 推送触发分支（phase5/**） | done | 同上 |