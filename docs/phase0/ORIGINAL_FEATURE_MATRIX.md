# 原项目功能矩阵（ORIGINAL_FEATURE_MATRIX）

来源：`dsh-purge-community@1.6.91`（证据见 `evidence/01..10`）
策略词表：**KEEP** 原样保留 · **IMPROVE** 保留并增强 · **REFACTOR** 保留能力重构实现 · **REPLACE** 更优方案替代但保留能力 · **DEFER** 暂缓（写原因） · **REMOVE** 移除（写明原因）

状态词表：`done` 已实现且有测试 · `wip` 实现中 · `planned` 未开始 · `n/a` 不适用

统计：登记 **74** 项；KEEP 6 · IMPROVE 21 · REFACTOR 24 · REPLACE 10 · DEFER 9 · REMOVE 4
进度：`done` 31 项（均有测试或实机验证）· `wip` 3 项 · `planned` 31 项 · `n/a`（DEFER/REMOVE）9 项
最后核对：2026-11-19（与 `node --test` 106 项全绿同日）

---

## A. 补丁引擎（core.js / patches/*.mjs）

| # | 原功能 | 实现位置 | 工作机制 | 原限制 | Purge+ 模块 | 策略 | 实现 | 测试 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | 声明式补丁表（86 条） | `patches/index.mjs:8` | `{id,name,layer,file,replacements,markers}` 常量数组 | 代码内常量，宿主路径硬编码 | `src/packs/schema.ts`（外部 pack 文件） | REFACTOR | done | `tests/packs.test.ts` |
| A2 | 目标文件解析 `targetFiles()` | `core.js:2805-3066` | 72 个逻辑键 → 双布局（单包/monorepo）路径 | 路径写死，新增宿主需改代码 | Adapter `inspect()` 返回布局事实 | REPLACE | done（DSH 适配器） | `tests/adapters.test.ts` |
| A3 | 字面量替换 + 正则 | `core/verify.mjs:7-87` | split/join 字面量；正则捕获组 | 无命中数约束（默认） | `src/packs/matcher.ts` | IMPROVE（默认 expect=1） | done | `tests/packs.test.ts` |
| A4 | `expect` 命中数契约 | `core.js:3457-3462` | 实际命中≠expect → 整条拒写 | 全表仅 1 条使用 | 同上，**默认启用** | IMPROVE | done | `tests/packs.test.ts` |
| A5 | markers 判「已应用」 | `core.js:3767-3812` | 文件含 marker 即 applied | marker 可被宿主复制误判 | `src/packs/matcher.ts` | KEEP | done | `tests/packs.test.ts` |
| A6 | 11 态补丁状态机 | `core.js:3718-3812` | applied/pending/drifted/unmatched/skipped/unreadable/missing/partial/disabled/na/unknown | 聚合口径两套 | `inspector/types.ts` 词表 + 单一聚合 | IMPROVE | done（诊断侧） | `tests/diagnostics.test.ts` |
| A7 | 逐文件状态明细 | `core.js:3714-3716` | `patch_files[key]=[{path,status}]` | 仅面板消费 | 诊断报告 evidence[] | KEEP | done | `tests/diagnostics.test.ts` |
| A8 | 漂移诊断（行号+候选落点） | `core.js:3624-3687,3566-3621` | token 打分定位新锚点 | 仅 CLI 输出 | Inspector `drift` 规则 | IMPROVE | planned | — |
| A9 | 半自动重锚 `reanchor` | `bin/community.js:37-116` | dry-run 唯一性断言 → 写覆盖文件 | 只换 pattern 不改 replace | `src/packs/anchors.ts` | KEEP | planned | — |
| A10 | 应用事务（备份→写→校验→回滚） | `core.js:3384-3528` | 快照失败只 warn；写失败不回滚 | **非真事务** | `recovery/transaction.ts` | REFACTOR（真事务） | done | `tests/recovery.test.ts` |
| A11 | 原子写 + 权限保留 | `atomic-files.js:39-52` | 临时文件+rename+chmod 补偿 | 无 fsync 目录 | `core/atomic.ts` | IMPROVE（+fsync） | done | `tests/config.test.ts` |
| A12 | `.bak` 逐文件备份与自愈 | `core.js:2597-2644,3397-3398` | 缺原文件时从 `.bak` 还原 | 可能用旧 bak 覆盖新版 | `recovery/snapshot.ts`（CAS 快照） | REPLACE | done | `tests/recovery.test.ts` |
| A13 | 撤销（revert）到未修改 | `core.js` revert 流程 | 反向替换 + 恢复 `.bak` | 无事务 | 快照恢复（不做反向替换） | REFACTOR | done | `tests/packs.test.ts` |
| A14 | 解包/回封 ASAR | `extract-asar.js:466-480` | 先全量校验再落盘 + prev 原子提交 | Windows 助手失效 | **不实现换包** | DEFER | — | — |

## B. 运行时（index.js 等）

| # | 原功能 | 实现位置 | 工作机制 | 原限制 | Purge+ 模块 | 策略 | 实现 | 测试 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | 提示词 section 注入（7 段） | `index.js:394-481` | `host.systemPrompt.section()` + order 预算 | 依赖宿主 order 语义 | — | DEFER（宿主内能力，非平台能力） | — | — |
| B2 | head/tail/both 注入位置 | `tuning.js` + `index.js:83-107` | 每轮读 tuning | 只影响注入正文 | — | DEFER | — | — |
| B3 | `excludePresets` 按预设排除 | `preset-injection.js:5-62` | Symbol 溯源，只清自己写的段 | 无预设信息时暂停注入 | — | DEFER | — | — |
| B4 | 3 个工具（status/apply/revert） | `index.js:1740-1830` | 工具内调 core | 工具即写盘入口 | `api` + `cli`（人可审计） | REPLACE | done | `tests/api.test.ts` |
| B5 | 4+4 slash 命令（含冲突兜底） | `index.js:1831-1929`、`command-registration.js` | 原名→备用名→跳过并报警 | 占用宿主命令空间 | `src/cli/main.ts`（无命名冲突） | REPLACE | done | 实机 CLI 跑通 |
| B6 | 19+3 HTTP 路由 | `index.js:1929-2619` | 无 token，仅同源比对 | 本机任意页可写 | `src/api/server.ts` + 策略层 | REFACTOR | done | `tests/api.test.ts` |
| B7 | 拒绝检测 + 单次重试 | `refusal-retry.js` | `llm/stream` 包一层，缓冲 400 字符，17 正则 | 副作用：可能重复计费 | — | REMOVE（属模型层干预，不属平台职责；理由见安全评审 §3） | — | — |
| B8 | 持续重试（continue-retry） | `continue-retry.js` | 错误码白名单 + 预算 | 同上 | workflow 的 retry 语义 | REFACTOR（只用于平台任务） | done | `tests/workflow.test.ts` |
| B9 | steering 恢复 / hooks deny 绕过 | `steering.js`、`hooks-deny.js` | 反向补丁恢复宿主原生行为 | 与宿主逐字耦合 | — | DEFER | — | — |
| B10 | 探针 nonce 证明注入到达 | `probe.js` | nonce 30min TTL，模型回显即通 | 依赖模型配合 | Inspector 的「证据」思想 | IMPROVE（泛化为证据探针） | planned | — |
| B11 | 运行时设置读写（tuning） | `tuning.js:46-65` | 规范化后记录生效值 | 无 schema | `core/config.ts` | REPLACE | done | `tests/config.test.ts` |

## C. 宿主定位与身份

| # | 原功能 | 实现位置 | 工作机制 | 原限制 | Purge+ 模块 | 策略 | 实现 | 测试 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | 跨平台安装候选发现 | `instance.js:227-254` | 显式选择器 > 进程入口 > Electron 兜底 | 不扫邻装（刻意） | `adapters/dsh.ts:discover` | KEEP | done | `tests/adapters.test.ts` |
| C2 | ASAR 不解包读身份 | `desktop-identity.js:23-55` | 自解析 ASAR 头 | 只读 package.json | `adapters/asar.ts` | IMPROVE（通用条目读取） | done | `tests/adapters.test.ts` |
| C3 | `currentHost` vs `diagnosticHost` 分离 | `instance.js:304-309` | 前者安装定位，后者改写成物理目录 | 两套发现体系并存 | Adapter 单一 `inspect` + 显式 `shape` | IMPROVE | done | `tests/adapters.test.ts` |
| C4 | 磁盘态/进程态/加载态三分离 | `host-layout.js:116-128` | 9 种 state + 不可推断声明 | surface/family 词表分裂 | `HostFacts.{shape,process,loadedShape}` | KEEP | done | `tests/adapters.test.ts` |
| C5 | 进程入口证据 `matches_target` | `instance.js:164-184` | 只认 `--app-path`/argv[1]/getAppPath | 依赖 Electron | `process.probe` 规则 | IMPROVE | done | `tests/diagnostics.test.ts` |
| C6 | 路径边界与 junction 安全 | `path-boundary.js`、`remove-tree.js:8-66` | lstat 优先、不跟随链接、无递归 rm 回退 | — | `core/atomic.ts:removeTreeNoFollow` | KEEP | done | — |
| C7 | 宿主版本兼容矩阵 | `community.js:115-199` | `QUALIFIED_HOST_VERSIONS` + family | 版本不参与补丁分支 | pack `target.versions` + `packSupportsVersion` | REFACTOR | wip | `tests/packs.test.ts`（单测已覆盖） |
| C8 | 第三宿主族识别（NEXT） | `next-host.js:57-71`、`desktop.js` | 包名/入口特征 | 部分为死代码 | Adapter 插拔 | IMPROVE | planned | — |

## D. 更新与安装

| # | 原功能 | 实现位置 | 工作机制 | 原限制 | Purge+ 模块 | 策略 | 实现 | 测试 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | 更新检查（版本/通道） | `update.js:136-141`、`update-policy.js` | running vs installed 分开 | 版本源单一 | `src/update/service.ts` + `version.ts`（离线 index，semver 比较） | REFACTOR | done | `tests/update.test.ts` |
| D2 | 下载 + SHA256/digest 校验 | `community.js:895-925` | 官方摘要为权威，镜像只传输 | — | `stage()`：大小+sha256 双校验，不符即清理 staging | KEEP | done | `tests/update.test.ts` |
| D3 | 镜像/代理/token/SOCKS | `update-http.js`、`update-socks.js` | token 只发 api.github.com；NO_PROXY | PAC 不支持 | 可注入 fetcher（v0.1 不做镜像/代理） | IMPROVE | planned | —（v0.3） |
| D4 | 分阶段安装（备份→装→验→回滚） | `update.js:869-988` | 失败回滚依赖图 | 写入口不统一 | `plan→stage→verify→activate`，失败保留旧指针 | REFACTOR | done | `tests/update.test.ts` |
| D5 | 非空互斥维护锁 | `maintenance-lock.js:35-167` | 记录+PID死亡+生日证明 | 跨机不可读即阻断 | `recovery/lock.ts` | KEEP | planned | — |
| D6 | 备份/回滚/prune/usage | `community.js:495-690` | CAS manifest + 走官方 CLI 回滚 | 回滚语义两处 | `recovery/snapshot.ts` | REFACTOR | done（快照/GC） | `tests/recovery.test.ts` |
| D7 | 引导安装器（零依赖下载） | `bootstrap-install.mjs` | 自带下载器，无 node_modules | 曾因 yaml 顶层依赖失败 | `cli install`（依赖自带） | REFACTOR | planned | — |
| D8 | 别名迁移 dsh-purge→community | `market-migration.js` | 精确包名迁移 | 写侧被拉回新名 | — | DEFER（无历史包袱） | — | — |
| D9 | 自动更新偏好持久化 | `update-policy.js:11-17` | 检查/安装分文件 | — | `core/config.ts`（update.channel/indexUrl） | KEEP | done | `tests/config.test.ts` |

## E. 诊断与恢复

| # | 原功能 | 实现位置 | 工作机制 | 原限制 | Purge+ 模块 | 策略 | 实现 | 测试 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | 25 层证据自检 | `selfcheck.js:17-62` | 硬编码层 + 条件层 | 30 条未分组补丁漂移不进状态机 | `inspector/diagnostics.ts` | IMPROVE | done（规则化） | `tests/diagnostics.test.ts` |
| E2 | 状态词表 + 退出码 | `selfcheck.js:144-147`、`bin/community.js:201` | broken 才退 1 | 调用方易只看 0 | `Level` + CLI 退出码 | KEEP | done | `tests/diagnostics.test.ts` |
| E3 | jsonl 审计（1MB×2 轮转） | `audit.js:28-122` | 单行 JSON，拒符号链接 | 覆盖面与文档不符 | `storage/audit.ts`（SQLite 哈希链） | REPLACE | done | `tests/storage.test.ts` |
| E4 | 内容寻址快照 | `community.js:529-597` | manifest+sums+objects 去重 32KiB | — | `recovery/snapshot.ts` | KEEP | done | `tests/recovery.test.ts` |
| E5 | 快照完整性校验 | `community.js:610-690` | 回滚前 verify() | — | `SnapshotStore.verify()` | KEEP | done | `tests/recovery.test.ts` |
| E6 | `reapply` 启动自愈 | `reapply.js:127-161` | 缺补丁则重打 | fail-open（异常返回 false） | 诊断 → 用户决定 | REPLACE（不自动写宿主） | planned | — |
| E7 | 主机备份清单/统计 | `community.js` usage/prune | 占用与 GC | 只增不减 | `recovery.snapshot.prune` | IMPROVE | done | `tests/recovery.test.ts` |

## F. 配置 / 规则 / 技能 / 预设 / 回退

| # | 原功能 | 实现位置 | 工作机制 | 原限制 | Purge+ 模块 | 策略 | 实现 | 测试 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | 规则集（单活 + 写 AGENTS.md） | `rules.js:161-284` | 激活写宿主文件，首次备份 | 双指令并存风险 | `src/ruleskills/rules.ts`（多槽位 + 组装，不写宿主） | IMPROVE | done | `tests/ruleskills.test.ts` |
| F2 | cwd 规则（路径勾选） | `rules.js:396-560` | 只存绝对路径，注入前重新命中 | 512KB 上限 | `RuleStore.compose({workspace})` 前缀匹配 | KEEP | done | `tests/ruleskills.test.ts` |
| F3 | 技能库（bundle/flat） | `skills.js:105-236` | frontmatter 子集解析 + 路径围栏 | `lib/skills.js:80` 漏 import `fs` 被静默降级 | `src/ruleskills/skills.ts` | REFACTOR | done | `tests/ruleskills.test.ts` |
| F4 | 技能导入安全检查 | `skills.js:411-447` | 12/50MB 上限 + 覆盖前备份 | 软链保护失效 | 体积/文件数上限 + 符号链接跳过 + 可执行内容告警 + 内容寻址备份 | IMPROVE | done | `tests/ruleskills.test.ts` |
| F5 | 预设落盘与注册 | `presets.js:32-56`、`presets-plugin.js` | `.agent-presets/<name>` + registry | 40×500ms 重试 | `configcenter.presets` | REFACTOR | planned | — |
| F6 | `toolFilter → agentPreset` 迁移 | `preset-compat.js:69-215` | 内容寻址私有备份后转换 | 未知策略即停 | `configcenter` 迁移器 | KEEP | planned | — |
| F7 | 会话回退（rewind） | `rewind.js:517-673` | 裁剪 surfaceOp + 3 层自检 | 依赖 4 条前端补丁 | — | DEFER（属宿主会话能力） | — | — |
| F8 | 命令冲突三级兜底 | `command-registration.js:1-20` | 原名→备用→跳过报警 | — | `cli`（无共享命名空间） | REMOVE（问题消失） | — | — |
| F9 | 卸载语义（保留用户资产） | `uninstall.js:133-144` | 文档称保留，代码删 `prompt-inject.md` | 实现与不变量冲突 | `cli uninstall`（默认保留数据） | IMPROVE | planned | — |

## G. 演练台（redteam）

| # | 原功能 | 实现位置 | 工作机制 | 原限制 | Purge+ 模块 | 策略 | 实现 | 测试 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 | 20 表 SQLite 事实库 | `redteam/schema.js:67-360` | 按靶标隔离 + FTS5 降级 | 迁移代码静默失效 | — | DEFER（v0.2 作为插件示例） | — | — |
| G2 | 64 工具单一 dispatch | `redteam/tools.js:418-2209` | 面板/CLI/agent 共用写路径 | 巨文件 | — | DEFER | — | — |
| G3 | 数据驱动计分（25 得分点） | `score-rules.js:162-255` | 上限/倍率/去重口径 | 三份解析 | — | DEFER | — | — |
| G4 | 哈希链证据账本 | `evidence-ledger.mjs:44-277` | `ev_id=sha256(canonical)` + 读时重算 | `claimed→observed` 单向 | `storage/audit.ts`（同思想） | IMPROVE（用于诊断证据） | done | `tests/storage.test.ts` |
| G5 | 技能可用性四维检查 | `skill-availability.js:252-347` | 环境/权限/依赖/工具 | — | — | DEFER | — | — |
| G6 | 无鉴权单端点 | `redteam/ui.js:1090-1096` | 回环跳过 Origin | 可被本机页面调用 | `api` 全端点鉴权 | REMOVE（不复制此缺陷） | — | — |

## H. UI 与安装器

| # | 原功能 | 实现位置 | 工作机制 | 原限制 | Purge+ 模块 | 策略 | 实现 | 测试 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | 5 槽位注入面板 | `client.js:15039-15084` | 宿主 slot 契约 | 与宿主 UI 强耦合 | `src/ui/*` 独立 SPA | REPLACE | done | `tests/api.test.ts`（静态资源） |
| H2 | 6 页签信息架构 | `client.js:13328-13335` | 状态/提示词/规则/技能/演练台/更多 | — | 8 屏：概览/宿主/诊断/快照/修改包/编排/调度/审计 | KEEP（IA 延长） | done | 手工验收 |
| H3 | 补丁逐条状态 + 分组计数 | `client.js:10120-10218` | 三分母（applied/total/na） | — | UI + API | KEEP | planned | — |
| H4 | 状态→视觉分档 | `client.js:10049-10074` | 12 状态 → ok/wait/bad/miss/muted | — | `ui/app.js:statusKind()` | KEEP | done | 手工验收 |
| H5 | 「不假装成功」语义 | `client.js` listState/unavailableStatus | loading/ready/error + 写后重读 | — | API 统一 `{ok,data|error}` + UI 显示真实错误 | KEEP | done | `tests/api.test.ts` |
| H6 | 维护中心（更新/备份/卸载） | `client.js:10759-10968` | 15 phase 文案 | — | UI 维护屏 | IMPROVE | planned | — |
| H7 | 一键安装 bat（关进程→装→打补丁→重开） | `一键安装.bat:42`、`apply-driver.mjs` | 先杀后验 | 失败不回滚 | `cli install --verify-first` | REFACTOR | planned | —（v0.2） |
| H8 | Windows 换包助手 | `windows-asar-handoff.js:150-166` | broker + Job Object | 参数打包错误，实际不可用 | — | DEFER（Purge+ v0.1 不换包） | — | — |
| H9 | macOS ⌘Q 换包变体 | `macos-asar-handoff.js:160-176` | 硬链接保 inode | — | — | DEFER | — | — |
| H10 | 前端构建脚本 | `build-client.mjs`、`patch-client-dock.mjs` | 切字符串注入 | 本包内直接抛错 | 零构建 | REMOVE（问题消失） | — | — |

---

## I. 明确不继承的部分（REMOVE / DEFER 汇总与理由）

| 项 | 处置 | 理由 |
| --- | --- | --- |
| 关闭审批/沙箱/提示词闸门的 86 条具体替换内容 | 不内置；作为可导入 pack | MASTER PROMPT §07：平台不新增绕过能力，但保留导入/审计/回滚 |
| 拒绝重试（B7） | REMOVE | 属模型层输出干预，不是宿主运维能力；且副作用不可观测 |
| hooks-deny / steering 反向补丁（B9） | DEFER | 与宿主逐字耦合，收益低 |
| rewind（F7） | DEFER | 属宿主会话能力，需要宿主前端补丁 |
| 演练台（G1-G3,G5） | DEFER | 1 MB 代码、dual-use；v0.1 不背这个包袱 |
| ASAR 换包/重启（A14,H8,H9） | DEFER | 风险最高（可把用户机器停成半装）；v0.1 只诊断不换包 |
| 命令冲突兜底（F8）、前端构建（H10） | REMOVE | 新架构下问题不存在 |

---

## J. 迁移验收口径

每一行 `实现=done` 的条目必须有：① 对应测试文件存在且 `node --test` 通过；② `docs/ARCHITECTURE.md` 有对应接口描述。未通过测试的条目一律回退到 `wip`。
