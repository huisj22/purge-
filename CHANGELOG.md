# CHANGELOG

本项目遵循「阶段 + 语义化」的混合记录方式：每个阶段记录实际交付、证据与未完成项。

## [Phase 5.5] — 2026-11-19 — Security Closure & Engineering Hardening

### Added

- `src/plugins/data-policy.ts`：插件数据边界（插件 ID 校验、相对路径规范化、符号链接/Junction 拒绝、realpath 祖先校验、1MB 上限）
- `ctx.data.read/write/list/remove`（in-process 与 worker 双路径，均经宿主校验）
- `PolicyStore` 写后复读、版本 CAS（`expectedVersion`）、`parseAndVerify()`、`status()`
- `AuditLog.prune({ keepLast, actor, reason })` + `audit_checkpoint` 表（schema v5）+ `lastCheckpoint()`
- `scripts/check-install-lifecycle.ts`：CI 生命周期钩子回归守卫
- `docs/security/write-path-inventory.md`（28 条写入口）
- `docs/security/policy-store-security.md`、`docs/security/plugin-data-policy.md`、`docs/security/phase5.5-risk-register.md`
- `docs/verification/phase5.5-baseline.md`、`docs/verification/phase5.5-acceptance-report.md`

### Changed

- `snapshot.prune`：加 global→snapshot 锁；非哈希名文件一律保留
- `update.prune`：加锁；保护 active/最新；最少保留 2 个；未知目录保留；返回 `protected[]`
- `packs/store.importPack`：加 global→packs 锁（waitMs 5s）
- `plugins/host.enable/disable`：加 global→plugin 锁（waitMs 5s）
- 插件数据目录从 `<program>/.data` 迁移到 `<dataDir>/plugin-data/<id>/`；旧数据自动迁移一次
- `PluginHost.remove(name, { purgeData })`：默认保留数据；删除数据时写审计
- Policy 变更事件统一为 `policy_set` / `policy_grant` / `policy_revoke`（含 fromVersion/toVersion/hash）
- 锁释放：先改名后删除；Windows EPERM 回退删除；元数据缺失在 3s 宽限期内按 BUSY 处理
- CI 矩阵 3 OS × {22, 24} = 6 组合；Node 22 使用 `NODE_OPTIONS=--experimental-sqlite`

### Fixed

- 快照 GC 与 capture 竞争可删除"已写对象、未插行"的内容（P1）
- 更新 GC 可删除活跃/最新/唯一可回滚版本（P1）
- Policy 并发授予丢失、旧写入者复活已撤销权限（P1）
- Policy 审计失败被吞（P1）
- Policy 读取使用旧缓存导致撤销不生效（P1）
- 插件升级/卸载丢失用户数据（P1）
- 锁释放窗口被误判为 RECOVERY_REQUIRED（P1）
- CI 打包扫入 `.pnpm` store 导致 "archive path too long"（CI 真实失败）

### Security notes

- 边界明确：`PROCESS_ISOLATED + CAPABILITY_RESTRICTED + HOST_MEDIATED_DATA_ACCESS`，**不是** OS 沙箱
- 真实宿主写入仍然禁止；所有写验证在隔离副本进行，真实宿主哈希前后一致

### Tests

261 → **298 tests / 68 suites**（+38）

---

## [Phase 5] — 2026-11-19 — Reliability, Security Boundary, Recovery & Delivery

### Added
- 跨进程锁 `src/core/lock.ts`（原子原语、6 状态、5 层级、stale 回收留痕）
- 安装器（tar.gz + MANIFEST/SHA256SUMS + 12 相状态机 + 回滚 + 幂等 + 后置 doctor 验证）
- 本地 CI（`scripts/ci.mjs`）、eslint 9 配置、GitHub Actions
- 恢复冲突检测（`planRestore`、force 授权、TOCTOU 复检、保护快照）
- 权限层级（owner/executor/advisor/auditor × L0–L4、TTL、策略哈希）
- 插件进程隔离（`fork` worker、IPC 校验、超时杀进程、崩溃隔离）
- 审计序号事务化（修复多进程 `UNIQUE(audit.seq)` 冲突）
- 规则/技能/自身配置写入加锁

### Tests
197 → 261

---

## [Phase 4] — 独立验收与 32 项修复（197 tests）
## [Phase 3] — 可观测性（trace/metrics/logs/traceId）
## [Phase 2] — 恢复、事务、更新、修改包、工作流、调度
## [Phase 1] — 核心内核、配置、适配器、CLI/API/UI
## [Phase 0] — 原始项目分析
