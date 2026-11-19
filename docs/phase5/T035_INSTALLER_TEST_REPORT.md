# T-035 安装器与 CI 测试报告

执行环境：Windows 11 (10.0.26200) · Node v24.1.0 · 2026-11-19
命令：`node --test tests/installer.test.ts` · `node scripts/ci.mjs` · `node scripts/package.mjs`

## 1. 单元/集成测试（19 例，全部通过）

| 组 | 用例 | 断言要点 | 结果 |
| --- | --- | --- | --- |
| archive | round-trip | 内容/模式往返一致 | ✅ |
| archive | 写侧拒绝 `/`、`..`、`x/../y` | 三条路径全部抛错 | ✅ |
| archive | 读侧拒绝被篡改头部的 `../evil.txt` | `escapes root` | ✅ |
| archive | 非 gzip 输入 | `not a gzip` | ✅ |
| package | 生成 + 校验 | 版本/文件数一致 | ✅ |
| package | 篡改检测 | `hash mismatch` | ✅ |
| preflight | 可写空目录 | PASS | ✅ |
| preflight | 父路径是文件 | `install_dir_writable=FAIL` 且 `blocked=true` | ✅ |
| preflight | 未提供数据目录 | `running_process=UNKNOWN`（不是 PASS） | ✅ |
| preflight | 父目录有 FAILED 状态文件 | `unfinished_install=WARN` | ✅ |
| 状态机 | 全新安装 | `COMPLETED`，文件落地 | ✅ |
| 状态机 | 幂等复装 | `idempotent=true`，无新增备份 | ✅ |
| 状态机 | 后置检查失败 | `ROLLBACK_COMPLETED`，旧版本内容恢复 | ✅ |
| 状态机 | 回滚失败（注入删除备份） | 抛错 + 状态 `ROLLBACK_FAILED` + error 有内容 | ✅ |
| 状态机 | 目标被其他产品占用 | 前置检查阻断，状态 `FAILED` | ✅ |
| 状态机 | 安装中被打断 | `ROLLBACK_COMPLETED`，无半安装目录、无 staging 残留 | ✅ |
| 状态机 | 损坏包 | 校验阶段拒绝，未创建安装目录 | ✅ |
| 状态机 | 重装不动用户数据 | config.json 内容不变 | ✅ |
| 状态机 | 卸载保留数据 | `keptData` + 文件仍在 | ✅ |
| hashTree | 忽略 node_modules / 状态文件 | 只返回 `a.txt` | ✅ |

## 2. 真实链路（VERIFIED）

```
node scripts/package.mjs --out <tmp>/purge-plus.tar.gz
→ 包：…\purge-plus.tar.gz  版本 0.1.0-alpha.1  文件数 109  大小 4815.8 KB
  SHA256 c1b4ea0c…  自校验：通过

node scripts/install.mjs --install-dir <tmp>/app --package <pkg>
→ 包校验通过：purge-plus@0.1.0-alpha.1 · 109 文件
  安装完成 … 后置检查：通过 — doctor exit 0 且包含审计链输出

node scripts/install.mjs --install-dir <tmp>/app --package <pkg>   # 第二次
→ 已是最新：purge-plus@0.1.0-alpha.1（幂等，未做改动）

node <tmp>/app/src/cli/main.ts doctor --data-dir <tmp>/data
→ Purge+ 0.1.0-alpha.1 · node v24.1.0 · win32-x64 … 审计链 ✓ 完整
```

## 3. 本地 CI（8/8）

```
✓ lint (2433ms)
✓ typecheck (1473ms)
✓ test (unit+integration+fault) (24649ms)
✓ acceptance (857ms)
✓ package (375ms)
✓ install (fresh) (712ms)
✓ install (idempotent) (513ms)
✓ installed cli doctor (267ms)
```

## 4. 未验证 / 阻塞

| 项 | 状态 | 原因 |
| --- | --- | --- |
| GitHub Actions 实际运行 | NOT_VERIFIED | 本机无法执行 GitHub runner；`.github/workflows/ci.yml` 已就绪 |
| Linux / macOS 安装 | NOT_VERIFIED | 无环境 |
| 两个安装器同时运行 | NOT_VERIFIED | 代码有 `install` 锁，未做双进程实机竞争 |
| 磁盘写满（ENOSPC） | BLOCKED | 无法安全制造 |
| 子进程被杀（kill -9 安装中） | NOT_VERIFIED | 用 `onPhase` 注入异常模拟，非真实 SIGKILL |

## 5. 结论

安装器达到 **M3（可靠性经故障注入验证）** 的 Windows 子集：
前置检查、状态机、幂等、后置验证、失败回滚、回滚失败可识别，全部有测试；
但跨平台与真实 CI 仍未验证。
