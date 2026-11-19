# 原项目分析：dsh-purge-community 1.6.91

分析对象：`dsh-purge-一键安装包` 内 `dsh-purge-install-kit/pkg/plugin-copy/dsh-purge-community`（570 个文件 / 7.7 MB，其中 lib 988 KB、client.js 662 KB）
分析方式：逐文件阅读 + `node` 载入 `ALL_PATCHES` 实测 + 本机真实宿主只读测绘
证据：本目录 `evidence/01..10`，全部结论带 `文件:行号`

---

## 1. 一句话结论

它把一个 Cordis 插件做到了能力上限：**86 条声明式宿主源码补丁 + 25 层证据自检 + 漂移诊断与半自动重锚 + 内容寻址快照回滚 + 带哈希链的审计**，工程质量在同类工具里属上游水平；但它把全部复杂度押在「宿主源码逐字锚点」和「单机 Electron 换包」两件事上，于是长出 1 MB 的补偿代码、662 KB 无法重建的前端、以及一套只有作者能维护的元数据语言。

---

## 2. 实际架构

```
宿主 DSH（Electron / CLI）
 ├─ app.asar 或 resources/app（解包后）
 └─ @deepseek-ai/dsh-* 若干包（被补丁改写的目标）
        ▲
        │ 86 条 pattern→replace（写磁盘，重启后生效）
        │
插件 dsh-purge-community（一个 Cordis 插件，7 个 bundle 条目）
 ├─ lib/core.js 177K       补丁引擎：patch 表 / targetFiles / apply / status / drift
 ├─ lib/index.js 123K      运行时：提示词 section、工具、命令、HTTP、流钩子
 ├─ lib/identity.js 42K    人格身份手术（与宿主无关，命名误导）
 ├─ lib/instance.js 20K+   宿主定位（currentHost / diagnosticHost / normalizeHostBase）
 ├─ lib/update*.js ~120K   更新器：镜像/代理/token/SHA256/锁/回滚
 ├─ lib/redteam/* 1.07M    演练台：SQLite 事实库 + 64 工具 + 计分 + 技能适配
 ├─ lib/rules|skills|rewind  规则、技能、会话回退
 ├─ client.js 662K         前端面板单文件（含 540 行内联 CSS）
 └─ docs/ 45 篇维护记录 + 61 份发行说明
```

**技术栈**：Node ≥18（演练台需 ≥22.5 用 `node:sqlite`）、ESM、Cordis 4 插件框架、Electron ASAR、pnpm、零构建前端（切字符串注入）、`yaml` 唯一运行时依赖。

**五种生效层（关键心智模型）**

| 层 | 提供者 | 生效时机 | 可验证性 |
| --- | --- | --- | --- |
| 宿主补丁 86 条 | 写宿主源码 | 退出重开宿主 | selfcheck 逐层计数 |
| 提示词注入 | 运行时每步重贴 | 下一轮对话 | probe nonce 回显 |
| 破甲强化段 | 运行时尾部 section | 下一轮对话 | boost 开关 |
| 权限配置 | profile `cordis.patch.yml` | 新会话 | 权限节点字面量 |
| agent 预设 | `.agent-presets/unrestricted` | 新会话下拉 | registry resolve |

---

## 3. 核心数据流

**应用补丁（写）**
```
applyPatches(aiBase)
 → Maintenance.backup("before-host-patches")          快照（失败只 warn）
 → restoreMissingOriginalsFromBak / refreshStaleBaks  从 .bak 自愈
 → targetFiles(aiBase)                                72 个逻辑键 → 路径
 → 逐条 patch：loadText → applyReplacementsToText
      ├ expect 命中数不符 → 整条拒写（hit_mismatch）
      ├ markers 已在 → already
      └ changed → saveText（原子写，保留权限）
 → logAudit("apply", {applied, already, failed, snapshot})
```
`lib/core.js:3384-3528`

**状态判定（读）**
```
readPatchReport → 逐文件 filePatchOutcome ∈ {applied,pending,drifted,skipped,unmatched}
 → 聚合：unreadable>pending>partial>applied>drifted>missing>disabled>na
lib/core.js:3718-3812
```

**漂移诊断**
```
patchDrift → 对未到位补丁逐 anchor 找 pattern
 → 未命中：记录 file/index/旧首行 + locateAnchor() 用 token 打分给候选片段
lib/core.js:3624-3687, 3566-3621
```

**自检（25 层）**
```
selfCheck(aiBase, home) → layers[] 每层 {state ∈ ok|pending|inferred|unknown|broken|not_needed|na}
 → 聚合 broken > unknown > pending > ok；仅 broken 退 1
lib/selfcheck.js:17-62,144-147,214-220
```

---

## 4. 功能清单（按子系统，明细见 ORIGINAL_FEATURE_MATRIX.md）

| 子系统 | 规模 | 真实能力 |
| --- | --- | --- |
| 补丁引擎 | core.js 177K + patches/*.mjs 170K | 86 条补丁（提示词 27/代码 47/工具 9/兼容 3），217 条替换，56 条多文件；11 态状态机；漂移诊断；本地重锚 |
| 运行时 | index.js 123K + 12 个辅助模块 | 7 个提示词 section（order −100000…10150）、3 工具、4+4 命令、19+3 HTTP 路由、拒绝重试、持续重试、steering 恢复、hooks deny 绕过 |
| 宿主定位 | instance/identity/desktop/layout ~150K | 跨平台候选、ASAR 不解包读身份、磁盘态/进程态/加载态三分离、junction 安全遍历 |
| 更新安装 | update* ~120K + community.js 42K | 检查→下载→SHA256/digest 校验→备份→官方 CLI 安装→身份验证→失败回滚；镜像/代理/token/SOCKS；非空互斥锁 |
| 诊断恢复 | selfcheck/anchors/audit/atomic/remove-tree | 25 层自检、重锚覆盖、jsonl 审计（1MB×2 轮转）、原子写+权限保留、不跟随链接删除、CAS 快照 |
| 配置/规则/技能/预设 | rules 18K + skills 28K + preset* 20K + rewind 22K | 规则单活写宿主 AGENTS.md、cwd 规则隔离、技能 frontmatter 校验与导入围栏、预设注册与 toolFilter 迁移、会话回退 |
| 演练台 | 1.07 MB | 20 表 SQLite 事实库、64 工具、25 得分点、哈希链证据账本、技能可用性适配 |
| UI | 662K 单文件 | 5 槽位注入、6 页签 IA、逐条补丁状态、维护中心、换包 15 种 phase 文案 |
| 安装器/换包 | 4 个 .bat + apply-driver + 平台 handoff | 关宿主→装插件→解包→打补丁→换包→重开；9 phase 状态机 + 4 工件 |

---

## 5. 优势（值得继承的东西）

1. **`expect` 命中数契约**：唯一能防「宿主复制了相似代码段，补丁连带改错」的机制，却只在 #93 用过一条。
2. **逐文件状态明细 `patch_files`**：`applied|pending|drifted|unmatched|skipped|unreadable|missing`，比单一布尔值信息量高一个量级。
3. **「无证据 = unknown」的价值观**：`inferred/unknown` 单独成态，只有确认故障才 broken（`selfcheck.js:144-147`）。
4. **磁盘态 ≠ 加载态**：`host-layout.js:116-128` 用 9 种 state + 每态一句不可推断声明守住这条线。
5. **内容寻址备份 + 回读校验**：`manifest{schema,complete,sums,blobs}` + `objects/<sha256>` + `DEDUPE_MIN=32KiB`。
6. **非空互斥锁**：靠「原子发布记录 + PID 死亡 + 进程生日」证明归属，绝不按 age 删（`maintenance-lock.js:35-43`）。
7. **ASAR 不解包直读身份**：`desktop-identity.js:23-55`，比「看文件在不在」强得多。
8. **维护文档纪律**：61 份发行说明保留未通过项（Defender 阻断连写 5 版），上游对齐账本逐条记录「一致/加强/不取」。

---

## 6. 短板（按严重度）

| # | 问题 | 证据 | 后果 |
| --- | --- | --- | --- |
| S1 | **不是真事务**：单文件写失败只记 `write_error`，已写文件不回滚，写后无复读校验 | `core.js:3477-3491` | 一次 apply 可留下半打补丁状态 |
| S2 | **软通过面积过大**：apply 侧聚合无 `partial`，47 条 optional + `skipped` 都算 ready | `core/verify.mjs:89-99,197-204` | 面板假绿 |
| S3 | **锚点是宿主源码逐字副本**，`expect` 全表仅 1 条，`host_version` 不参与分支 | `core.js:3513-3519` | 宿主每个 rc 都要重锚，6 条补丁在 0.2.2-rc.1 仍未修 |
| S4 | **前端不可重建**：`packages/purge-panel` 不在发行包，`npm run build:client` 全失效 | `package.json:43,45-47` + evidence/08 | 改一个文案要手改 662 KB 产物 |
| S5 | **Windows 换包助手参数打包错误**：整串参数用单引号传给 WMI/Start-Process | `windows-asar-handoff.js:150,161,166`；本机双引擎复现 | 面板侧 Windows 密封换包 100% 失败 |
| S6 | **安装器先杀后验**：先 `taskkill /F`，失败不回滚不重开 | `一键安装.bat:42`，`apply-driver.mjs:107-122` | 用户机器停在「宿主关着、插件半装」 |
| S7 | **备份可被不可逆覆盖**：三处旧路径先删 `.bak` 再重建 | `extract-asar.js:200-203` 等 | 回滚源被自己毁掉 |
| S8 | **静默失效的迁移代码**：引用未定义常量，异常被 `catch{}` 吞 | `redteam/schema.js:586,591` | 老库字段永久缺失且无人察觉 |
| S9 | **无鉴权 HTTP 承载写操作**：回环请求跳过 Origin 校验 | `redteam/ui.js:1090-1096` | 本机任意页面可触发写 |
| S10 | **卸载删用户资产**：连 `prompt-inject.md` 与 `rules/` 一起删 | `uninstall.js:133-144` | 与自身文档不变量冲突 |
| S11 | **巨型单文件**：`store-core.js` 5414 行（单个方法 1085 行）、`client.js` 15088 行、CSS 27 KB 单行 | evidence/05,08 | 无人可安全重构 |
| S12 | **两套发现体系 + 三套缓存语义**：instance.js 认 3 形状，core.js 认 11 形状 | evidence/03 | 自检与 apply 走不同路径，同一事实两个结论 |
| S13 | **文档即真相但没有真相源**：补丁条数三处矛盾（86/84/81） | `AGENTS.md:19,89`、`preset-test.md:12` | 验收口径不可信 |
| S14 | **顶层硬依赖 `yaml`**：无 node_modules 时自检直接崩 | `permission-state.js:1` | 引导安装阶段必炸（曾导致 1.6.11 撤回） |

---

## 7. 风险清单（对后续产品）

| 风险 | 说明 | 处置 |
| --- | --- | --- |
| 宿主升级即失效 | 86 条字面锚点，随宿主每个 rc 漂移 | 新引擎必须**默认** `expect`、锚点最小化、按版本分桶 |
| 换包破坏机器 | 杀进程 + 换归档 + 不校验 | 新方案：**先验证再关进程**，且换包能力默认关闭 |
| 假绿 | 软通过状态过多 | 单一聚合口径，only-evidence 才 ok |
| 供应链 | 更新走 GitHub/镜像/代理 | 离线优先、摘要永远来自权威源、token 不出本机 |
| 许可 | MIT + NOTICE + 上游夹带条款 | 见 `ORIGINAL_SECURITY_REVIEW.md` §5 |

---

## 8. 技术栈对照与选型决定

| 维度 | 原项目 | Purge+ | 理由 |
| --- | --- | --- | --- |
| 语言 | JS（无类型） | TypeScript 源码直跑（Node type stripping） | 有类型约束但不引入打包步骤 |
| 前端 | 662 KB 单文件（不可重建） | 零构建静态 SPA，按屏拆文件 | 可维护、可 diff |
| 存储 | jsonl 审计 + 手写 JSON 状态 | `node:sqlite`（内置） | 事务、索引、可查询 |
| 补丁模型 | 代码内 86 条常量 | **外部数据包（pack）** + 引擎 | 数据与引擎解耦，可导入/审计/换宿主 |
| 状态词表 | 11+ 态，两套聚合口径 | 11 态、**一套聚合** | 消灭假绿 |
| 平台能力 | 换包/重启/杀进程 | v0.1 **不实现**换包与重启 | 风险最高、收益最低（用户可手动重启） |
| 宿主耦合 | 86 条路径硬编码 | Adapter 接口 + 事实证据 | 加宿主不改核心 |

---

## 9. 许可与来源

- 原项目：MIT（`LICENSE`），fork 自上游 `dsh-purge`（作者 小杨 / YuJunZhiXue），维护者 `kingcharleslzy-ai`；`NOTICE.md` 含非背书声明。
- 演练台素材另有 dual-use 与授权声明（`docs/redteam-upstream-LICENSE`、`DISCLOSURE`）。
- 上游 README 夹带「禁止转售 / 违约即终止」条款，**不属于 MIT 授权范围**；Purge+ 不复制其代码与文档正文，只继承工程思想与接口语义，并按 MIT 保留原项目版权声明（见 `references/`）。
