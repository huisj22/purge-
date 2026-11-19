# 平台验证矩阵（PLATFORM_VERIFICATION_MATRIX）

验证时间：2026-11-19 · 唯一可用环境：Windows 11 (10.0.26200) x64 · Node v24.1.0

| 能力 | Windows 11 | Linux | macOS | 说明 |
| --- | --- | --- | --- | --- |
| 单元/集成测试（255） | ✅ 实跑通过 | ⚠️ 未运行（CI 配置覆盖） | ⚠️ 未运行 | 纯 Node 逻辑，跨平台差异主要在文件系统 |
| TypeScript / Lint | ✅ 实跑 0 错误 | ⚠️ 未运行 | ⚠️ 未运行 | 与平台无关 |
| Acceptance（模拟宿主） | ✅ 14/14 | ⚠️ 未运行 | ⚠️ 未运行 | — |
| 打包（tar.gz + MANIFEST） | ✅ 实跑 109 文件 | ⚠️ 未运行 | ⚠️ 未运行 | 实现为纯 JS，未用系统 tar |
| 安装（全新/幂等/卸载） | ✅ 实跑 | ⚠️ 未运行 | ⚠️ 未运行 | 依赖 `rename` 语义（Windows 已实测 EPERM 分支） |
| 安装失败回滚 | ✅ 实跑 | ⚠️ 未运行 | ⚠️ 未运行 | — |
| 后置健康检查（doctor） | ✅ 实跑 | ⚠️ 未运行 | ⚠️ 未运行 | — |
| 跨进程锁 | ✅ 11 例子进程实跑 | ⚠️ 未运行（rename 语义 CODE_CONFIRMED） | ⚠️ 未运行 | Windows 的 `EPERM` 与 POSIX `ENOTEMPTY` 都已纳入判定 |
| 恢复冲突检测 | ✅ 9 例 | ⚠️ 未运行 | ⚠️ 未运行 | 依赖 mtime 语义（Windows 已测） |
| 插件进程隔离 | ✅ 9 例真实 fork | ⚠️ 未运行 | ⚠️ 未运行 | 依赖 `child_process.fork` 与 IPC，跨平台 API |
| 权限层级/策略完整性 | ✅ 10 例 | ⚠️ 未运行 | ⚠️ 未运行 | 纯逻辑 |
| 真实宿主只读验证 | ✅ Level 5（DSH 0.2.2-rc.5） | ❌ 无宿主 | ❌ 无宿主 | 仅本机 Windows |
| 真实宿主写入验证 | ❌ BLOCKED（安全规则） | ❌ | ❌ | 需要在隔离副本上做 |
| GitHub Actions 实跑 | ❌ 未运行 | ❌ | ❌ | 本机无法执行 GitHub runner |
| OS 级沙箱 | ❌ 未实现 | ❌ | ❌ | 仅进程隔离 |

图例：✅ 实跑通过 · ⚠️ 未运行（配置存在但未执行）· ❌ 未实现/阻塞

## 结论

**只有 Windows 11 的验证是 PLATFORM_VERIFIED。** Linux/macOS 一律 `NOT_VERIFIED`，不得在报告中写成"支持"。

## 收尾轮更新（2026-11-19）

| 能力 | Windows 11 本机 | 隔离副本（Windows） | GitHub Windows | GitHub Ubuntu | GitHub macOS |
| --- | --- | --- | --- | --- | --- |
| 全量测试（261） | ✅ | — | NOT_VERIFIED | NOT_VERIFIED | NOT_VERIFIED（无 job） |
| 安装/卸载 | ✅ | ✅ | NOT_VERIFIED | NOT_VERIFIED | NOT_VERIFIED |
| pack apply / snapshot / restore / rollback | ✅（副本） | ✅ 17/17 | NOT_VERIFIED | NOT_VERIFIED | NOT_VERIFIED |
| 真实宿主写入 | ❌ BLOCKED（安全规则） | — | — | — | — |

标记：`LOCAL_WINDOWS_11_VERIFIED` = TRUE；`GITHUB_WINDOWS_RUNNER_VERIFIED` / `GITHUB_UBUNTU_RUNNER_VERIFIED` / `GITHUB_MACOS_RUNNER_VERIFIED` = **NOT_VERIFIED**（推送被 BLOCKED，见 `GITHUB_CI_STATUS.md`）。