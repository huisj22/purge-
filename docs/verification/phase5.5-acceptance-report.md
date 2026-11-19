# Phase 5.5 独立验收报告（ACCEPTANCE）

日期：2026-11-19 · 分支 `phase5.5/security-closure` · 仓库 `huisj22/purge-`
判定：**PARTIAL**（见 §10）

---

## 1. 基线

| 项 | 值 |
| --- | --- |
| 基线 HEAD | `77a5c1a`（phase5/verification，与 origin 同步） |
| 基线测试 | 261 tests / 56 suites / 0 fail |
| 基线 CI | 3 组合（3 OS × Node 24）全绿 |
| 工作树 | clean |
| main | 未修改、未推送 |

## 2. Level 1 静态验证

| 检查 | 结果 |
| --- | --- |
| TypeScript (`tsc --noEmit`) | ✅ 0 错误 |
| ESLint（src/tests/scripts） | ✅ 0 error |
| 敏感信息扫描（`ghp_`/`BEGIN PRIVATE`/`password=`） | ✅ 无命中 |
| 生命周期钩子检查（`scripts/check-install-lifecycle.ts`） | ✅ 通过 |
| 打包排除检查（.pnpm/dist/coverage/reports） | ✅ 有测试 |
| workflow 无 secrets / 无 deploy | ✅ 有测试断言 |

## 3. Level 2 单元 / 集成

| 套件 | 数量 |
| --- | --- |
| 总测试 | **298 tests / 68 suites / 0 fail / 0 skip** |
| 其中 Phase 5.5 新增 | 38（write-path-closure 8、policy-store-hardening 11、plugin-data-policy 9、ci-workflow 8、installer exclusions 1、T055-01 内其它 1） |

## 4. Level 3 多进程验证

| 场景 | 实现 | 结果 |
| --- | --- | --- |
| 锁竞争 A–G | 真实子进程 | ✅ 11 例 |
| 快照 GC vs capture | 子进程持续 capture + 父进程反复 prune | ✅ 无损坏（prune 冲突时被拒） |
| Pack 并发导入 | 3 进程 × 6 导入 | ✅ 18 条无丢失 |
| Policy 并发授予 | 3 进程 × 5 授予（CAS 重试） | ✅ 15 条全部落地 |
| Audit 并发 append + prune | 2 进程 × 10 append + 父进程裁剪 | ✅ 链完整、无空洞 |
| 插件 enable 等待 | 外部持 global 2s | ✅ 等锁释放后才写 |

## 5. Level 4 故障注入

| 注入 | 结果 |
| --- | --- |
| 锁损坏（owner.json 非法） | ✅ RECOVERY_REQUIRED，不夺取 |
| 锁目录瞬时缺失 | ✅ BUSY 重试（3s 宽限），不再误报 |
| 锁释放 rename EPERM（Windows） | ✅ 回退删除 |
| Policy rename 失败 | ✅ 旧文件字节不变 |
| Policy 临时文件残留 | ✅ 读取忽略 |
| Policy hash 篡改 | ✅ integrity_failed |
| Policy JSON 损坏 | ✅ schema_invalid |
| Policy 审计失败 | ✅ 回滚 + 报错 |
| Policy 审计 + 回滚双失败 | ✅ `policy.json.recovery-required` |
| 插件符号链接 / junction | ✅ 拒绝 |
| 插件跨目录 / 核心目录 | ✅ 拒绝，核心文件未变 |
| 归档路径穿越 / 超长 / 非 gzip | ✅ 拒绝 |
| 安装后置检查失败 | ✅ 回滚到旧版本 |
| 恢复冲突 / TOCTOU | ✅ 阻止、复检 |

## 6. 隔离写入验证（真实宿主安全）

- 隔离副本：robocopy 全量复制真实宿主 `resources`（21,788 文件 / 473MB）
- 执行：pack apply → snapshot → 冲突阻止 → force restore → rollback → install → uninstall
- 结果：**17/17 通过**（`reports/phase5.5/isolated-write-verify.txt`）
- 真实宿主：**21,789 条哈希与 Phase 5 基线逐条一致**（`reports/phase5.5/real-host-after.txt`）
- 结论：**REAL_HOST_UNCHANGED**；未对真实宿主执行任何写操作

## 7. Level 5 跨平台验证（GitHub Actions 实跑）

Run `44548004385`（commit `9acc317`）：

| OS | Node 22 | Node 24 |
| --- | --- | --- |
| windows-latest | ✅ success | ✅ success |
| ubuntu-latest | ✅ success | ✅ success |
| macos-latest | ✅ success | ✅ success |
| build artifact | — | ✅ success |

`LOCAL_WINDOWS_11_VERIFIED` ✅ · `GITHUB_WINDOWS_RUNNER_VERIFIED` ✅ · `GITHUB_UBUNTU_RUNNER_VERIFIED` ✅ · `GITHUB_MACOS_RUNNER_VERIFIED` ✅

## 8. CI 过程中修复的真实缺陷

| # | 缺陷 | 证据 | 修复 |
| --- | --- | --- | --- |
| 1 | `PNPM_HOME` 指到工作区 → 打包扫到 `.pnpm` store → "archive path too long" | run 44547362523（ubuntu/macos 失败） | 移除该 env；打包排除 `.pnpm` 等目录 + 回归测试 |
| 2 | Node 22 的 `node:sqlite` 需要 flag | 设计检查 | `NODE_OPTIONS=--experimental-sqlite`（矩阵级，子进程继承） |
| 3 | 打包无工具目录防御 | 同 #1 | `EXCLUDED_DIRS` 扩充 + 测试 |

## 9. 必检异常状态行为

| 状态 | 触发方式 | 行为 | 验证 |
| --- | --- | --- | --- |
| LOCK_CORRUPTED | owner.json 非法 | `RECOVERY_REQUIRED`，写入被拒 | ✅ |
| RECOVERY_REQUIRED（Policy） | 审计+回滚双失败 | 标记文件 + 抛错 | ✅ |
| POLICY_HASH_MISMATCH | 文件被改 | `integrity_failed`，拒绝加载 | ✅ |
| POLICY_VERSION_CONFLICT | 旧 version 提交 | `conflict` + expected/actual | ✅ |
| BACKUP_UNKNOWN | 无法识别的版本目录 | 保留（不删） | ✅ |
| BACKUP_CORRUPTED | 快照对象缺失 | `CORRUPTED` + 恢复阻止 | ✅ |
| PLUGIN_DATA_ACCESS_DENIED | 越界路径 | `policy_denied` + 审计 | ✅ |
| WRITE_CONFLICT | 并发写 | `conflict` / 有界等待 | ✅ |
| AUDIT_WRITE_FAILED | 审计抛错 | 策略回滚 | ✅ |

## 10. 判定：PARTIAL

已完成并有证据：
- 写入口闭合（除明确登记的系统边界）
- Policy Store 并发/完整性/审计回滚
- 插件数据边界（应用层）
- 6 组合跨平台 CI 全绿
- 分支保护真实配置并复读验证
- 隔离写入 17/17，真实宿主未变

未完成（因此不是 COMPLETE）：
1. **OS 级沙箱未实现** → 插件仍可用 `node:fs` 越界（R-P2-1），不能宣称"可安全运行任意不受信任插件"。
2. Scheduler / Workflow 的多进程 lease 未实现（R-P2-6/7）。
3. Rules/Skills/Self-Config 变更未写审计事件（R-P3-2）。
4. 跨机器 / 网络文件系统未验证（R-P2-9）。
5. Policy 变更无 CLI/API 端点（R-P2-5）。

## 11. Phase 6 进入条件评估

| 条件 | 状态 |
| --- | --- |
| P2-13 关键写入口闭合 | ✅（系统边界另记） |
| Policy 并发与完整性验证 | ✅ |
| Plugin 应用层边界验证 | ✅ |
| Node 22 + 24 三平台 CI | ✅ 6/6 |
| 必需检查配置并验证 | ✅ |
| 多进程 + 故障注入 | ✅ |
| 隔离写入验证 | ✅ |
| 无未解决 P0/P1 | ✅（7 项 P1 全 FIXED） |
| P2 有明确处置结论 | ⚠️ 6 项 OPEN（均有处置计划但未完成） |
| 报告与代码一致 | ✅ |

**结论：尚不能进入 Phase 6**，差在 P2 的 6 项 OPEN（主要是 OS 沙箱与 scheduler/workflow lease）。
