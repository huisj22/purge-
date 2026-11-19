# T-035 安装器审计（T035_INSTALLER_AUDIT）

审计日期：2026-11-19 · 基线 `06b1701`

## 基线状态（Phase 5 之前）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 安装程序 | ❌ 不存在 | `scripts/install.*` 无；`src/installer` 无 |
| 打包机制 | ❌ 不存在 | 无 `dist/`、无 tar/zip 生成 |
| 构建脚本 | ⚠️ 无构建（TS 源码直跑），但无打包 | `package.json` scripts 无 build/package |
| 版本管理 | ✅ 存在 | `package.json` version = 0.1.0-alpha.1 |
| 安装目录管理 | ❌ 不存在 | 只能手动 clone |
| 卸载机制 | ❌ 不存在 | — |
| 升级机制 | ❌ 不存在 | — |
| 安装失败处理 | ❌ 不存在 | — |
| 安装后验证 | ❌ 不存在 | — |
| CI | ❌ 不存在 | 无 `.github/` |
| 平台矩阵 | ❌ 不存在 | — |
| 依赖完整性检查 | ⚠️ 部分 | lockfile 存在（pnpm-lock.yaml） |
| 安装日志 | ❌ 不存在 | — |

**结论**：Phase 4 交付链路为 M1（仅"源码可运行"），不满足"可安装、可升级、可卸载"。

## 本轮实现（T-035）

| 能力 | 实现 | 证据等级 |
| --- | --- | --- |
| 前置检查 | `src/installer/preflight.ts`：platform / node / 目录可写 / 磁盘探测 / 既有安装 / 未完成安装 / 运行中实例（锁推断） | TEST_CONFIRMED（4 例） |
| 归档读写 | `src/installer/archive.ts`：自研 ustar + gzip，双向拒绝 `/`、`..`、超限、截断 | TEST_CONFIRMED（3 例） |
| 打包 | `scripts/package.mjs`：MANIFEST（逐文件 sha256）+ SHA256SUMS + 自校验 | VERIFIED（真实产出 109 文件 / 4.8MB / sha256 打印） |
| 包校验 | `verifyPackage()`：逐条哈希 + 清单对齐 | TEST_CONFIRMED（篡改检测） |
| 安装状态机 | `Installer.install()`：12 个 phase + 失败回滚 + 回滚结果验证 | TEST_CONFIRMED（成功/回滚/回滚失败/中断） |
| 幂等 | 源与目标文件集哈希一致 → NOOP，不产生备份 | TEST_CONFIRMED + VERIFIED（真实复装） |
| 后置验证 | 真实拉起安装后的 CLI 执行 `doctor`，要求 exit 0 且输出含"审计链" | VERIFIED（真实安装日志） |
| 卸载 | 默认保留数据目录，`--purge-data` 才删 | TEST_CONFIRMED |
| 跨进程安装锁 | 同一父目录只允许一个安装器 | CODE_CONFIRMED（FileLock）；未做双安装器实机竞争测试 |
| 本地 CI | `scripts/ci.mjs`：lint → typecheck → tests → acceptance → package → install → 幂等复装 → doctor | VERIFIED（8/8 通过） |
| GitHub Actions | `.github/workflows/ci.yml`：windows/ubuntu × node 22/24 + package job | NOT_VERIFIED（未实际运行） |

## 平台矩阵

| 平台 | 安装 | 打包 | 本地 CI |
| --- | --- | --- | --- |
| Windows 11 x64 | ✅ 真实执行 | ✅ | ✅ 8/8 |
| Linux | NOT_VERIFIED | NOT_VERIFIED | NOT_VERIFIED（仅 CI 文件） |
| macOS | NOT_VERIFIED | NOT_VERIFIED | NOT_VERIFIED |

## 仍存在的缺口

1. **GitHub Actions 未运行**：文件存在但从未在 GitHub 上执行 → `NOT_VERIFIED`。
2. **磁盘空间检查不精确**：Node 标准库无跨平台可用空间 API，当前用"写 2MB 探测"代替，精确值返回 `UNKNOWN`（按原则一保留 unknown，不假装 PASS）。
3. **无签名**：包只校验 sha256（防损坏，不防伪造）。
4. **无系统级注册**：不创建快捷方式/服务/开机启动，属有意选择（避免不可逆系统改动）。
5. **双安装器竞争**：代码有锁，但没有专门的"两个安装器同时跑"实机测试。
