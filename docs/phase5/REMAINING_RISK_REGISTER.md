# 剩余风险登记（REMAINING_RISK_REGISTER，Phase 5 结束时）

状态词：`FIXED` / `MITIGATED` / `OPEN` / `ACCEPTED` / `BLOCKED` / `NOT_VERIFIED`

---

## P0（数据丢失 / 无法启动 / 安全边界失效）

| ID | 问题 | 状态 | 说明 |
| --- | --- | --- | --- |
| — | 无 | — | Phase 4 的 P0-01（API 无鉴权 + CSRF）已修复；Phase 5 未发现新的 P0 |

## P1（核心功能失效 / 恢复失败 / 状态严重不一致）

| ID | 问题 | 状态 | 说明 |
| --- | --- | --- | --- |
| P1-05 | 恢复静默覆盖较新改动 | **FIXED** | 冲突检测默认阻止 + force 需授权 + 保护快照 |
| P1-06 | 跨进程写无互斥 | **FIXED**（核心路径） | 配置/快照/插件/更新/安装已加锁；规则/技能/自身配置未接入（P2-13） |
| P1-07 | 执行主体可自我提权 | **FIXED** | 角色分离 + owner-only 授予 + 策略哈希 |

## P2（部分功能 / 需要计划修复）

| ID | 问题 | 状态 | 影响 | 计划 |
| --- | --- | --- | --- | --- |
| P2-13 | 规则/技能/自身配置写入未加锁 | **FIXED（主要入口）**；prune/备份 GC 仍 OPEN | 主要丢失更新风险已消除 | 剩余项下一阶段处理 |
| P2-14 | 插件能力白名单是服务级，非方法级 | OPEN | 声明 `snapshots` 即可调用 `restore` | 能力声明改为 `service.method` 集合 |
| P2-15 | 策略文件写入未加锁、无签名 | OPEN | 并发改策略可能互相覆盖；有文件权限者可连同 hash 一起改 | 接入写锁 + 可选签名 |
| P2-16 | 审计库与数据目录对插件可写 | OPEN（需 OS 沙箱） | 恶意插件可篡改审计/数据 | 子进程独立用户 + 目录权限 |
| P2-17 | 安装器未在 Linux/macOS 验证 | **FIXED** | CI 三平台全绿（run 44540146301） | — |
| P2-18 | GitHub Actions 从未运行 | **FIXED** | 三次运行，最终三平台全绿 | — |

## P3（体验 / 局部优化）

| ID | 问题 | 状态 |
| --- | --- | --- |
| P3-26 | IPC 回包无关联校验（HMAC/salt） | ACCEPTED（低风险） |
| P3-27 | 插件可直接修改数据目录文件 | OPEN（依赖 OS 权限） |
| P3-28 | 锁无心跳续期（长任务 >24h 会被视为"可能仍在运行"） | ACCEPTED（安全方向） |
| P3-29 | 恢复的时间戳判定受 mtime 影响 | ACCEPTED（hash 仍是主判据） |
| P3-30 | `runNow` 与调度的语义差异未在 UI 说明 | OPEN |
| P3-31 | metrics 无分组索引 | OPEN（Phase 4 遗留） |
| P3-32 | 技能依赖可达性未实现 | OPEN（Phase 4 遗留） |
| P3-33 | 工作流步骤无幂等键 | OPEN（Phase 4 遗留） |

## 明确 BLOCKED（无法在本环境验证）

| 项 | 原因 | 未来如何验证 |
| --- | --- | --- |
| 磁盘写满（ENOSPC） | 无法安全制造 | 独立分区/容器 quota |
| 真实 SIGKILL 中断安装/恢复 | 会污染当前会话 | 独立进程 + 受控 kill 脚本 |
| 真实宿主写入（pack apply / restore） | 安全规则禁止 | 复制 `resources/` 到临时目录做 L4→接近 L5 |
| OS 级沙箱 | 未实现 | seccomp / AppContainer / sandbox-exec |
| 跨平台行为 | 无环境 | GitHub Actions 矩阵 |

## 接受的残留风险（明确接受，不是遗忘）

1. **本机单用户信任模型**：actor 是声明值，本机操作者默认可执行 L0–L3。多用户/远程不适用。
2. **审计可被本机高权限进程篡改**：哈希链能发现篡改，不能阻止。
3. **插件仍有完整用户权限**：进程隔离只解决崩溃与 IPC 越权，不解决文件/网络。
4. **恢复依赖 mtime 判断"更新"**：外部工具回拨 mtime 会退化为 MODIFIED（仍阻止，不会放行）。

## 统计

| 等级 | 已修 | 未修 | 阻塞/未验证 |
| --- | --- | --- | --- |
| P0 | 1（Phase 4 遗留） | 0 | 0 |
| P1 | 3 | 0 | 0 |
| P2 | 0 | 4（P2-13..16） | 2（P2-17/18） |
| P3 | 0 | 5（P3-27/30/31/32/33） | 0（ACCEPTED 5 项） |

## 收尾轮新增/变更（2026-11-19）

| ID | 问题 | 状态 | 说明 |
| --- | --- | --- | --- |
| — | Audit 多进程并发 `UNIQUE constraint failed: audit.seq` | **FIXED** | 改为 `BEGIN IMMEDIATE` 内分配 seq |
| — | 隔离副本写入验证缺失 | **FIXED** | 17/17，真实宿主哈希未变 |
| P2-19 | GitHub CI 未运行（无 remote） | BLOCKED | 需用户提供仓库与凭据 |
| P2-20 | workflow 无 macOS job | **FIXED** | matrix 已加 macos-latest 并实跑通过 |
| P3-34 | T-037 未覆盖 `prune`/备份 GC | OPEN | 与 capture 并发窗口小 |
| P3-35 | 隔离验证依赖 robocopy（Windows 专用） | ACCEPTED | 脚本层面的平台限制，不影响产品 |
## 收尾轮 2（GitHub CI 打通）新增

| ID | 问题 | 状态 | 说明 |
| --- | --- | --- | --- |
| — | `install` 脚本被 pnpm 当生命周期钩子 → 三平台安装即失败 | **FIXED** | 重命名 `install:app`（`1272ed4`） |
| — | POSIX `ENOTDIR` 与 Windows `ENOENT` 语义差异导致回滚误判失败 | **FIXED** | absent 删除同时接受两种错误码（`4d9800e`） |
| P2-21 | Node 22 运行时未在 CI 验证（matrix 仅 24） | OPEN | engines 已修正 >=22.18；如需覆盖可加 matrix 条目 |
| P2-22 | 分支保护/必需检查未配置 | OPEN | 需仓库管理员在 GitHub 设置 |
| P3-36 | CI 经本地代理推送到 HTTP/2 会 408 | ACCEPTED | 使用 HTTP/1.1 直连或代理均可绕开；非产品缺陷 |