# Phase 4 · BASELINE（基准记录）

记录时间：2026-11-19T12:2x UTC（本机 Asia/Shanghai 20:2x）
执行者：Phase 4 独立验收（不信任任何自报告）

---

## 1. 基准点

| 项 | 值 | 证据类型 |
| --- | --- | --- |
| 分支 | `main` | VERIFIED（`git rev-parse --abbrev-ref HEAD`） |
| HEAD | `8457ab7ab1ac445bfd9b451039fa2bf2efa3fb3b` | VERIFIED |
| 提交标题 | `observability: persisted structured logs + observability screen (150 tests)` | VERIFIED |
| 工作树 | 干净（`git status --porcelain` 无输出） | VERIFIED |
| 项目版本 | `0.1.0-alpha.1`（`src/app.ts` APP_VERSION） | CODE_CONFIRMED |
| 未提交修改 | 无 | VERIFIED |
| 未跟踪文件 | 无 | VERIFIED |

## 2. 环境

| 项 | 值 |
| --- | --- |
| OS | Microsoft Windows 11 Pro，NT 10.0.26200 |
| Node | v24.1.0 |
| npm | 11.3.0 |
| 包管理 | pnpm 10.11.1（`devDependencies` 仅 `typescript@5.9.3`、`@types/node@22.20.5`） |
| 语言运行方式 | TypeScript 源码由 Node 原生 type stripping 直跑，无构建步骤 |
| 数据库 | `node:sqlite`（内置） |

## 3. 结构

| 项 | 数量 |
| --- | --- |
| `src/**/*.ts` | 38 |
| `tests/**/*.ts` | 17 |
| UI 文件 | 3（`index.html` / `app.js` / `styles.css`） |
| 测试入口 | `npm test` → `node --test "tests/**/*.test.ts"` |
| 验收入口 | `node scripts/acceptance.ts` |

`package.json` scripts：`test` / `test:one` / `typecheck` / `acceptance` / `doctor` / `serve` / `cli`。
`tsconfig.json`：`strict`、`noUncheckedIndexedAccess`、`allowImportingTsExtensions`、`noEmit`。

## 4. 原始测试结果（未做任何修改）

命令：`node --test "tests/**/*.test.ts"`（原始输出保存在 `evidence/baseline-tests.txt`）

```
tests 150 / suites 29 / pass 150 / fail 0 / cancelled 0 / skipped 0 / todo 0
duration_ms ≈ 1405
exit code 0
```

**结论：开发者自报的 150 tests / 29 suites / 150 pass / 0 failed 属实（VERIFIED）。**

## 5. 原始类型检查

命令：`npx tsc --noEmit` → 输出为空，exit 0（`evidence/baseline-tsc.txt`）。
**结论：TypeScript 0 error 属实（VERIFIED）。**

## 6. 原始验收脚本

命令：`node scripts/acceptance.ts`（`evidence/baseline-acceptance.txt`）

```
✓ 1 health … ✓ 10 audit chain — checked=14
结果：14/14 项通过
exit code 0
```

**结论：Acceptance 14/14 属实（VERIFIED）。但该脚本由项目自身编写，属于 Level 4（模拟宿主），不能等同于真实环境验证。**

## 7. 宿主环境

| 项 | 值 | 证据 |
| --- | --- | --- |
| 真实 DSH 安装 | `C:\Users\chenw\AppData\Local\Programs\DeepSeek Harness\resources`（`app.asar` 209,083,008 B + 已解包 `app/`） | VERIFIED（只读测绘 + Phase 0/3 记录） |
| 宿主版本 | `@deepseek-ai/dsh-desktop@0.2.2-rc.5` | VERIFIED（ASAR 头 + 解包 package.json） |
| 真实宿主上已有第三方修改 | `dsh-purge@1.6.91` 痕迹（`~/.dsh/dsh-purge/applied.json`） | VERIFIED（Phase 3 诊断输出） |
| 运行中进程 | 有（tasklist 命中，pid 曾观测到 24692 等） | VERIFIED（本会话早期） |

**注意**：真实宿主已处于「被第三方修改」状态。Phase 4 不对其做任何写操作。

## 8. 已知问题（基线时即存在，来自本轮审计）

详见 `ISSUE_REGISTER.md`。基线时**尚未修复**的 P0/P1：

- P0-01 API 无鉴权 + 接受跨源 `text/plain` 写入
- P1-01 Kernel `start()` 失败后永久锁死
- P1-02 Inspector 对「干净解包宿主」误报 fail
- P1-03 Restore 非事务，部分失败留下混合状态
- P1-04 插件能力白名单被表述为隔离，实际无沙箱

## 9. 当前无法验证的项目（BLOCKED / NOT_VERIFIED）

| 项 | 状态 | 原因 | 未来如何验证 |
| --- | --- | --- | --- |
| 真实宿主写入路径（pack apply 到真实 DSH） | BLOCKED | 安全规则禁止对真实宿主做破坏性写；宿主已有第三方修改，基线不可控 | 在隔离副本（复制 resources 到临时目录）中做 Level 4 验证 |
| 归档换包 / 重启流程 | BLOCKED | v0.1 未实现该功能（ROADMAP 明确延后） | 功能实现后再验 |
| 长期稳定性（>24h 运行） | NOT_VERIFIED | 本次验收时长不足 | 长跑 + 内存/句柄采样 |
| 跨平台（macOS/Linux） | NOT_VERIFIED | 当前仅 Windows 环境 | CI 矩阵或多平台机器 |
| 进程崩溃中断恢复（kill -9） | BLOCKED（部分） | 无法安全地对正在运行的服务进程做崩溃注入（会污染当前会话）；改用「模拟中断」测试 | 独立进程 + 受控 kill 脚本 |
| UI 真实浏览器渲染/可访问性 | NOT_VERIFIED | 本次未接入浏览器自动化 | Chrome DevTools MCP 或 Playwright |

## 10. 基线结论

- 开发者自报的三项数字（150 tests、tsc 0、acceptance 14/14）**全部复现属实**。
- 但「测试全绿」不等于「系统可靠」：本轮已在 8 个模块中确认 5 项 P0/P1 缺陷（见 `ISSUE_REGISTER.md`），其中 3 项在现有测试中**没有覆盖**。
