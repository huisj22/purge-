# 10 · 文档与 issue 历史作为工程证据（dsh-purge-community 1.6.91）

> 切片范围：`docs/MAINTENANCE.md`、`docs/INSTALLATION.md`、`docs/inject-review.md`、`docs/refusal-ab.md`、`docs/AUTO-UPDATE.md`、`docs/CWD-COMPAT.md`、`docs/native-input-integrity.md`、25 份 `docs/maintenance-*.md`、61 份 `docs/releases/*.md`、`README.md`、`AGENTS.md`、`NOTICE.md`、`LICENSE`、`docs/upstream/*`（3 份）、`docs/redteam-upstream-LICENSE`、`docs/redteam-upstream-DISCLOSURE`、`package.json`、`CONTRIBUTORS.md`。原项目目录只读，本报告仅引用，未改动任何文件。

## 职责

这个项目的**文档不是说明书，而是第二套运行时契约**。三种文档承担三种不同职责，混用会读错：

1. **面向 agent 的操作约束**：`AGENTS.md` 是给模型读的强制条款集（"不要…""不得…""不能把…当成…"），明文声明与 `README.md` 冲突时以它为准（`AGENTS.md:519` 区域 §10；`README.md:219`）。
2. **面向人的故障决策树**：`MAINTENANCE.md` / `INSTALLATION.md` 把"症状 → 该跑什么 → 怎么判读 → 不要做什么"写成可执行流程（`MAINTENANCE.md:41-51`、`INSTALLATION.md:79-107`）。
3. **面向维护者的事后证据档**：61 份 `docs/releases/*.md` + 25 份 `docs/maintenance-*.md` 记录每次修复的**根因、修复边界、实测计数、已知未通过项**，并反复声明"哪些结论不许外推"。

因此本切片的价值不在功能描述，而在：**它记录了这个架构所有已知的失败模式，以及维护者用来区分"已证明"与"未证明"的语言**。这正是继任产品最该继承的部分。

## 关键实现（带 file:line 证据）

### 1. 文档分层与自动守卫

- 版本一致性靠脚本守：`check:docs` 断言 `package.json` 版本 = release-notes 首行 = `README.md` = 英文 README（`docs/releases/1.6.3.md:37`、`package.json:49`）。
- 该守卫被明确限定为"只校验版本与关键安装边界"，不校验功能真伪（`docs/MAINTENANCE.md:39`）。
- 版本行同时写在 `AGENTS.md` 首部并由同一脚本校验（`docs/releases/1.6.3.md:19`）。
- 文档守卫会**解析 YAML 代码围栏里的安装示例**，防"照抄历史示例造成重复入口"（`AGENTS.md:501`、`docs/native-input-integrity.md:37-39`）。
- 每份维护记录必须给出可复用验收命令与"禁止指向正式 DSH"的边界（`docs/maintenance-issue-52.md:34-36`、`docs/pr78-runtime-integrity.md:54-60`）。

### 2. (a) 演进年表（按主题，版本号为证据）

**安装 / 迁移 / 更新**

- 1.6.3：tgz 先落 `pkgs/` 再交 pnpm，避免 `file:` 指向临时目录（`docs/releases/1.6.3.md:10`）；合并 PR#1 修 `repairOfficialCliAfterUnpack()` 同步函数里未 await 的异步拷贝（同文 `:9`）。
- 1.6.4：Web/Headless 维护页空备份列表、HTTP 200 + `ok:false` 误报成功、npm CLI 定位（`docs/releases/1.6.4.md:7-11`）。
- 1.6.6 → 1.6.7：macOS `/var` 与 `/private/var` 别名导致 bootstrap 静默不执行；1.6.6 当天即被 1.6.7 取代（`docs/releases/1.6.6.md:13`、`1.6.7.md:13`）。
- 1.6.8：PowerShell call operator 对 GUI 子系统 exe 假成功 → `Start-Process -Wait`（`docs/releases/1.6.8.md:7-12`）。
- 1.6.9 → 1.6.10：Windows 密封归档换包助手（`1.6.9.md:9`）→ 相对 junction 随 cwd 解析错误，改绝对目标，1.6.9 降级为预发布（`1.6.10.md:3,7`）。
- 1.6.11 → 1.6.12：引导 CLI 顶层经 selfcheck 引入 `yaml`，无 `node_modules` 时 migrate 直接崩（`1.6.12.md:3-7`）。
- 1.6.14：原子替换丢执行位（#20）；新增只读 `host-status`（#19）（`1.6.14.md:5-7`）。
- 1.6.28：逐 profile 检查实际版本（#28）、源码 ZIP 固定 commit + Git blob 校验（#29）（`1.6.28.md:5-6`）。
- 1.6.29：面板回滚改走 `.tgz`（#34）、`update-http` 统一 token/代理（#35）（`1.6.29.md:5-6`）。
- 1.6.33：Linux 用户目录安装、成功后切换入口、卸载不跟随链接（`1.6.33.md:5-8`）。
- 1.6.38/1.6.39：下载总预算 180s + 可选镜像；fetch 失败 → 系统 curl 备用（`1.6.38.md:3`、`1.6.39.md:3-6`）。
- 1.6.41：运行版本 vs 磁盘版本分离，修 pendingVersion 卡死（`1.6.41.md:5-7`）。
- 1.6.44：市场安装引导 + 旧包 `name` 精确迁移（`1.6.44.md:5-9`）。
- 1.6.51：改名/自定义路径识别、多架构运行时（PR#78），展示名统一为 `dsh-purge Community`（`1.6.51.md:5-11`）。
- 1.6.54/1.6.56：旧平铺 runtime 链接迁移（#79）、状态读取缓存与错误保留（#81/82/83）。
- 1.6.61：锁原子发布（#92）、子路径部署（#106）、更新通道 SOCKS/Token（PR#99）、技能目录发现（PR#103）（`1.6.61.md:7-11`）。
- 1.6.67：代理探测改 `reg.exe`、Windows 凭据 DACL（#122）（`1.6.67.md:5-9`）。
- 1.6.75：#130 新旧 Desktop CLI 定位、#132 镜像通道、#137 市场兼容声明（`1.6.75.md:5-7`）。
- 1.6.85：升级事务先迁移旧 `latest` 依赖再解析（#164）、Windows 换包等待启动回执（#165）（`docs/releases/1.6.85.md:5-6`）。
- 1.6.87：密封归档用物理归档决定 CLI 入口（#181）、维护锁对瞬态 EPERM/EBUSY 重试（`1.6.87.md:4,9`）；1.6.88 补 `rmdir` 分支（`1.6.88.md:3`）。

**宿主补丁 / 锚点**

- 1.6.3：83 条补丁逐条适配 0.2.1-rc.1，6 条重写锚点（`1.6.3.md:56-86`）；同时恢复 1.2.0 被硬关掉的写能力（`1.6.3.md:60-72` 对照表）。
- 1.6.3：`diagnose` 分桶 `drifted/optionalDrift/chained/missing` + 候选落点（`1.6.3.md:88-92`）；`reanchor` 把新锚点存为本地覆盖，不动源码（`1.6.3.md:16`）。
- 1.6.62：0.2.1-rc.5 全树零漂移；补丁 80→82（`1.6.62.md:2,6`）。
- 1.6.63：目标文件在、marker 不在、锚点全灭 → `drifted` 而非 `skipped`（`1.6.63.md:3-6`）。
- 1.6.64：`expect: N` 命中数契约，不符整条拒写（`1.6.64.md:3-4`）；与上游 1.1.83 按 name 对齐 72 条逐字一致、6 条加强（`maintenance-1.6.64.md:6`）。
- 1.6.65：#18/#19 改 `disabledByDefault`，opt-in 才写（`1.6.65.md:3-5`、`maintenance-1.6.65.md:14-17`）。
- 1.6.72/1.6.73：0.2.2-rc.1 重写 8 条锚点、新增 4 个目标包、#14 直接短路 `approveEscalation`（`docs/releases/1.6.72.md:5-6`）；1.6.73 收尾给 #54/#35 标 `silentWhenMissing`（`1.6.73.md:3`）。
- 1.6.77：取上游 1.1.90 两条去品牌补丁，编号冲突改 93/94；新增 `multiHit`（`1.6.77.md:3-5`）。
- 1.6.90：适配 rc.2 单行压缩会话客户端，按 `surfaceOp` 过滤回退事件（`1.6.90.md:3`）。
- 1.6.91：#92 改幂等，收敛旧版重复插入的 `--max-http-header-size`（`1.6.91.md:3`）。

**诊断 / 状态语义**

- 1.6.11：`inferred`/`unknown` 与 `broken` 分离；退出码只在 broken 为 1（`1.6.11.md:6`、`AGENTS.md:206`）。
- 1.6.31：#76 的 skipped 不再一律算失败，静态只读 YAML 判 `not_needed`（`1.6.31.md:5-9`）。
- 1.6.32：#40 引入 `diagnosticHost`，归档内路径不再交给磁盘检查器（`1.6.32.md:5-7`、`maintenance-issue-40.md:17-25`）。
- 1.6.45：`complete:false` 不再统一归因 `CMD 无感未钉入`（`1.6.45.md:5-7`）。
- 1.6.56：只读诊断内共享缓存，不跨请求（`1.6.56.md:3`）；1.6.71 修 `undefined++` 造成 `NaN`（`1.6.71.md:7`、`maintenance-022-diagnostics.md:11`）。
- 1.6.69：`apply`/`revert` 失败返回非零退出码（`1.6.69.md:11`）。
- 1.6.86/1.6.89：纯 Web 时换包状态标"不适用"；启动日志与维护接口共用同一实例查询（#192）（`1.6.86.md:4`、`1.6.89.md:6`）。

**交互语义（模型层）**

- 1.6.27：撤销 1.6.26 的 followup 降级，恢复原生 steer 分流（`1.6.27.md:3`、`docs/steer-notes.md:7-11`）。
- 1.6.40：`excludePresets` 按预设精确隔离注入（`1.6.40.md:3-5`）。
- 1.6.74：`PURGE_INVALID_PRE_STEP_DECISION` 显式报错、提示词装配失败保留原异常（`1.6.74.md:6-7`、`native-input-integrity.md:9-10`）。
- 1.6.83/1.6.84：红队技能加一次性命令执行挑战 + `scripts/exec-proof.mjs`；1.6.83 因 Windows CI 只认 LF 未发行（`1.6.83.md:3-5`、`1.6.84.md:7`）。

**UI**

- 1.6.3：设置页从右侧抽屉改左侧栏整页；状态页改 hero + 折叠块（`1.6.3.md:27,49-51`）。
- 1.6.56：主题对比度配对（`1.6.56.md:5`）。
- 1.6.86/1.6.87：回退菜单挂 body 按视口坐标对齐（#151）、环境提示改原生 modal（#172）、历史别名预设折叠显示（#174/#186）（`1.6.86.md:3`、`1.6.87.md:5-7`）。

### 2b. 上游年表（fork 的起点，1.1.16–1.1.90）

`docs/upstream/release-notes.md` 是上游 54 个版本的存档（`:1` 注明原仓库已不可访问），它解释了 fork 为什么一开始就是"补丁集合 + 宿主适配"形态：

- 1.1.17 → 1.1.46 之前：#42 在 dsh 0.1.7 上叠加重复 `legacyApplyPath` 打崩 `dsh-settings`，改用 `skipIfMarked` 并清理历史重复（`upstream/release-notes.md:803,812`）。
- 1.1.44：确立"先解包到旁路目录、成功才换 `resources/app`"的换包语义，失败回退并保留升级标记（`:507`）。
- 1.1.46：拒绝安装 1.1.45；修注入在第二轮掉人设、ChatML/`<project_instructions>` 外层必须剥离、`decision.messages` 规范成数组、`renderPrompt` 读 `undefined.length` 崩、回退空 `snapshotEvents()` 崩（`:486-497`）。
- 1.1.47：`unknown op: platformConfigGet`、技能目录探测、首次安装告知、桌面定位缓存不粘滞（`:472-477`）。
- 1.1.71：`??` 混 `||` 导致插件 `failed to import`；UI 队列 steer 改 followup（这正是本 fork 1.6.26→1.6.27 要撤销的那一处，`steer-notes.md:7`）；发版前 `node --check` 主入口（`:8-11`）。
- 1.1.78–1.1.83 / 1.1.90：fork 逐条评审后选择性取用，`maintenance-1.6.63.md:5-15` 给"采纳/不采纳+理由"全表，`1.6.77.md:3` 取 1.1.90 的两条去品牌补丁。

含义：**补丁式"破甲"这条路本身有 54 个版本的试错史**，其中反复出现的失败模式（注入第二轮丢失、ChatML 外层、消息数组、回退崩溃）在 fork 里全部以"补丁 + 契约测试"的形式再演一遍。

### 2c. issue 分诊纪律（可复用的运维规则）

- 讨论型 issue（经验分享/提问，非 bug/非重复）**只回复、不关闭**；只有"已修复/重复/明确不支持"才关闭并写依据（`AGENTS.md:416-418`）。
- 关闭带说明用 `gh issue close -c`；纯评论必须用 `gh issue comment --body/--body-file`，`-c` 在 comment 子命令静默失败（`AGENTS.md:420`）。
- 索取信息有白名单：只要 OS/架构、DSH 发行名与版本、插件**运行**版本、脱敏错误码与手递状态；不索取提示词、凭证、完整配置、整份备份（`AGENTS.md:167,347,384`、`MAINTENANCE.md:15`）。
- 复现不到报告者环境时，结论只能写到"已复现的机制"为止（`maintenance-issues-86-89.md:28`、`host-diagnostics-118-119.md:55-67`）。

### 3. (c) 许可与继承关系

| 来源 | 文件证据 | 继承内容 | 对派生品的约束 |
|---|---|---|---|
| 上游 `dsh-purge`（小杨 / YuJunZhiXue） | `LICENSE:1-3`；`NOTICE.md:3-6`；`docs/upstream/README.md:1` | MIT + 全部宿主补丁思路、提示词、默认注入正文、上游 README（存档于 `docs/upstream/`） | 必须保留版权与许可声明；fork 自称"免费、不做付费转售、非上游官方发行"（`NOTICE.md:6`） |
| 上游 README 的追加条款 | `docs/upstream/README.md:96,100,110,150` | "非营利""禁止商业销售/付费转售""必须署名""违约即许可终止" | 这些是作者声明，**不是 MIT 授予的一部分**；派生品要做商业分发必须重新评估，不能引用上游条款当授权 |
| 红队模块 `dsh-redteam-mode`（Jueze-2019） | `docs/redteam-upstream-LICENSE:1-3,25-27` | MIT + "仅限已获授权安全评估"声明 | 保留该作者版权；保留 dual-use 声明 |
| 红队 dual-use 声明 | `docs/redteam-upstream-DISCLOSURE:4-16,45,65-74` | 包内无 exploit 代码、纯本地 SQLite、无遥测 | 派生品若沿用技能库，需继续提供同类声明 |
| DSH 官方测试夹具 | `NOTICE.md:12` | `test/fixtures/agent-loop-022-native.json` 内含 `@deepseek-ai/dsh-agent-loop` 0.2.2-rc.1 方法体，MIT 原文保留在同目录 | 夹具仅用于隔离契约测试，不得据此宣称官方背书 |
| 本项目 | `package.json:56,75-78` | MIT，仓库 `kingcharleslzy-ai/dsh-purge` | 与上游同名但不共享仓库；`NOTICE.md:6` 明确"未获上游作者背书" |

### 4. (d) 维护者声明的测试/验收纪律（原文最强条款）

- 真实与模拟必须分开报告："**真实宿主验收与模拟测试分别报告，不把未知平台写成已验证**"（`MAINTENANCE.md:39`）；"**不能以组件测试或 pnpm 版本查询通过替代 Windows 完整安装、迁移、回滚通过**"（`MAINTENANCE.md:103`）。
- 磁盘 ≠ 加载："**磁盘存在 app.asar 不足以证明当前服务从归档加载；归档已移走也不足以证明旧进程已经重载**"（`MAINTENANCE.md:79`）；"**starting 不是就绪，waiting_for_quit 不是完成，磁盘补丁数不是当前进程已加载**"（`MAINTENANCE.md:45`）。
- 禁止 mock 冒充实测："**不得只用 mock bin/community.js 或先安装依赖的 smoke 代替**"（`AGENTS.md:214`）；"**不得用'只读正式运行时'选项回退运行用户的 DSH**"（`INSTALLATION.md:208`）。
- 跳过不算通过："**跳过项不算通过**；Windows/macOS 的 Electron 补充测试与 Node 计数分开"（`maintenance-1.6.61.md:50`）。
- 负对照是硬要求："旧实现作为负对照，**必须能复现故障**；新实现必须通过相同场景"（`steer-notes.md:30`）；"Original PR head fails the new … negative control with ReferenceError; this is an executed regression, not only an import check"（`review-pr128-settings.md:19`）。
- 发布授权 ≠ 修复："**维护者已知悉此限制后决定发布；发行说明保留未通过的实机验收；不能把此决定说成问题已修复**"（`AGENTS.md:472`、`maintenance-integrity-169.md:28`）。
- 报告者环境未复现 → issue 保持打开："不能证明报告者的 DSH 一定由相同 Job 管理"（`maintenance-issues-86-89.md:28`）；"#118 保持打开：已复现并修复的是错误分类问题，不能据此认定报告者的具体卡住原因"（`1.6.66.md:18`）。
- 注入送达必须可证：探针 nonce 回显才算链路通（`AGENTS.md:96-106`）；被排除的预设不会回显探针，"不能据此认定插件故障"（`maintenance-issue-53.md:42`）。
- 质量主张要有基线且允许撤回：`refusal-ab.md:52-59` 给基线（968 条回答 / 4 条拒绝 / 0.41%），`:86-88` 自认单次采样不足，`:89-108` 明确更正"head 0/8 不代表不拒绝"，并附模型 reasoning 原文作为失败证据。

## 数据流与状态

文档把系统描述成 5 个可观测状态机，状态值同时出现在 CLI、面板、自检三处，且**互不等价**：

1. **动作三阶段**：安装 ≠ 应用 ≠ 重启（`MAINTENANCE.md:9`、`AGENTS.md:39-48`）。应用是幂等的，宿主更新后必须重做（`AGENTS.md:44`）。
2. **补丁状态**：`applied | already | pending | skipped | unmatched | missing | unreadable | drifted | disabled | partial | broken|inferred|unknown`，且 `partial` 仅对声明 `fileAllRequired` 的多文件补丁产生（`AGENTS.md:490-495`、`1.6.58`/`1.6.59` 条目）。
3. **换包 handoff**：`not_scheduled → starting → ready → waiting_for_quit → moving → complete`，另有 `failed/expired/helper_stopped/unreadable/archive_reappeared/backup_missing`（`AGENTS.md:284-285`、`maintenance-issue-40.md:58`）。
4. **更新状态**：`runningVersion`（模块首次加载固定）vs `diskVersion`（profile 逻辑路径），相同则清 `pendingVersion/restartRequired`，不同则等待手动重启（`maintenance-update-state.md:9-13`、`AUTO-UPDATE.md:9`）。
5. **快照与锁**：`backups/<id>/manifest.json` + `objects/` 内容寻址、保留 5 份/7 天/200MB（`MAINTENANCE.md:13`）；锁为 `maintenance.guard/` 目录门 + 兼容 `maintenance.lock`，`LOCK_UNREADABLE` 与 `LOCK_LOST` 分别停止写入（`1.6.61.md:9-11`、`maintenance-1.6.61.md:7-13`）。

文档自身的流转：releases/*.md → `check:docs` → CI（三平台 + PowerShell 5.1/7 + 真实 Electron 交接）→ tag 发布 tgz + SHA256SUMS → 市场索引（`MAINTENANCE.md:39`、`1.6.8.md:26`）。

## 真实能力清单

| 能力 | 入口 | 实现位置 | 是否真实现 | 证据 |
|---|---|---|---|---|
| 版本/文档一致性守卫 | `npm run check:docs` | `scripts/check-docs.mjs` | 真实现，但只查版本行与关键边界 | `docs/releases/1.6.3.md:37`、`MAINTENANCE.md:39` |
| 逐版本发行说明 | `docs/releases/*.md` | 61 份文件 | 部分：缺 1.6.5/15–26/34/37/43/49–50/52–53/55/57–60/80–82 | 目录清点；`AGENTS.md:249-259` 仍在引用 1.6.34/1.6.52 行为 |
| 维护记录（根因+边界） | `docs/maintenance-*.md` | 25 份 | 真实现，含失败注入与负对照 | `maintenance-issue-67.md:29-31`、`maintenance-issues-86-89.md:23-30` |
| 锚点漂移诊断 | `purge-community diagnose` | `lib/anchors.js`（文档记载） | 真实现，给出文件/行号/候选片段 | `1.6.3.md:88-92`、`AGENTS.md:157` |
| 半自动重锚 | `reanchor list/show/apply/clear` | `anchor-overrides.json` | 真实现，dry-run + `--yes` | `1.6.3.md:16`、`AGENTS.md:141-150` |
| 注入送达探针 | `probe new` + 面板 | `probe.json`，30 分钟 TTL | 真实现（nonce 回显为准） | `1.6.3.md:23`、`AGENTS.md:96-110` |
| 逐层自检 + 证据分级 | `selfcheck [--json]` | 25 层 | 真实现，`broken` 才退出 1 | `AGENTS.md:52-58,206` |
| 动作审计 | `audit [--limit n]` | `audit.jsonl` 1MB 轮转 2 份 | 真实现 | `1.6.3.md:12`、`AGENTS.md:64` |
| 拒绝率 A/B harness | `scripts/refusal-report.mjs` | 只读本地会话/审计 | 真实现（文档自认样本不足） | `refusal-ab.md:4,52-59,86-88` |
| 注入正文逐段审计 | `docs/inject-review.md` | 47 段 / 20,969 字符静态分类 | 真实现（仅建议，不改正文） | `inject-review.md:3-11` |
| 命令执行挑战（红队） | `scripts/exec-proof.mjs` | 生成 nonce、核对原始输出 | 真实现，不连目标、不认证来源 | `1.6.83.md:4`、`1.6.84.md:4` |
| 市场兼容声明 | `package.json` `dsh.compatibility` | 逐版本 `compatible/unknown` | 真实现（rc.4/alpha.2 留 unknown） | `package.json:103-117`、`DSH-STORE.md:21-28` |
| 许可与署名 | `LICENSE`/`NOTICE.md`/2 份 redteam 文件 | — | 真实现，但上游附加条款与 MIT 并存 | `NOTICE.md:3-12`、`upstream/README.md:96-152` |
| 中文/英文 README 一致性 | `check:docs` 声明校验"中文副本一致" | — | **名义实现**：`README.md` 与 `README.zh-CN.md` SHA256 完全相同（CE9326D9…C03D） | 实测哈希；`MAINTENANCE.md:39` |

## 依赖与耦合

- **上游血缘**：`NOTICE.md:3-6` 表明全部宿主补丁与提示词来自 `YuJunZhiXue/dsh-purge`；上游已停止维护且仓库不可访问（`docs/upstream/README.md:1`、`1.6.3.md:126`）。
- **宿主强耦合**：补丁是对 `@deepseek-ai/*` 源码的**字面片段替换**，宿主每个 rc 都要重锚（`1.6.3.md:77-86`、`1.6.62.md:2`、`1.6.72.md:3`、`1.6.90.md:3`）；兼容清单只到 `0.2.2-rc.1`，rc.4/alpha.2 为 unknown（`package.json:104-117`）。
- **运行时耦合**：peerDep `@deepseek-ai/cordis ^4.0.1`（`package.json:123`）、`yaml 2.9.1`（`:161`）、Node ≥18、红队需 ≥22.5（`node:sqlite`）（`README.md:197`）。
- **平台耦合**：Windows GUI 子系统 exe、detached PowerShell、Job Object、junction、DACL、8.3 短路径、Defender 各自需要专门处理（`1.6.8.md:7`、`maintenance-issues-86-89.md:26-39`、`update-channel-122.md:11`、`maintenance-issues-44-47.md:37`、`maintenance-integrity-169.md:26`）。
- **外部市场耦合**：dsh-market 的重复安装拦截发生在插件加载前，插件无法修复（`INSTALLATION.md:75`、`MARKET-MIGRATION.md:16`）；DSH Store 的 Bundle 解析器更窄，`SUBMISSION_PATCH_AMBIGUOUS` 未通过（`DSH-STORE.md:44`）。
- **第三方红队内容**：`skills/redteam/unauth-exploit.md` 被 Defender 判为 `Backdoor:PHP/Chopper.E!dha`，跨 ≥5 个版本未解（`1.6.61.md:3`、`1.6.69.md:3`、`1.6.70.md:16`、`1.6.75.md:11`、`maintenance-integrity-169.md:26-28`）。

## 局限与缺陷（带证据）

### (b) 缺陷目录（按 bug 类归一，含修复手法）

| # | 缺陷类 | 具体表现 | 修复手法 | 证据 |
|---|---|---|---|---|
| 1 | 异步/同步混用的 atomic 写 | 同步函数调用未 await 的异步拷贝 → Windows/Node24 `uncaughtException` 导致宿主启动即退；`.dsh-purge.bak` 存成补丁后字节 | 新增 `atomicCopyFileSync` + 回归 | `1.6.3.md:9` |
| 2 | 原子替换丢权限位 | 新 inode 未继承 rwx，0755 启动器变 0644（#20） | 抽 `lib/atomic-files.js`，唯一临时名，失败清理并抛错；只对已识别官方启动器补执行位 | `1.6.14.md:5`、`AGENTS.md:198` |
| 3 | Junction 递归删除越界 | 原生 `fs.rmSync(recursive)` 穿过 Junction，外部依赖文件静默消失（#67） | `lib/remove-tree.js` lstat + unlink，只递归普通目录，根目录拒绝，失败不回退原生 rm | `maintenance-issue-67.md:5,11` |
| 4 | 相对 junction 随 cwd 解析 | `..\runtime` 指向错误位置，解包后再装报 pnpm 缺失 | 改绝对目标，旧链接改名保留，冲突停止 | `1.6.10.md:7-9` |
| 5 | 快照裸目录回滚 | pnpm 写入 `link:`，快照不含 `node_modules`，安装成功但插件无法加载（#34） | 快照打包成 tgz 走官方 CLI，装后新进程验证依赖与入口 | `maintenance-issues-34-35.md:5-9` |
| 6 | 递归 cpSync 原生退出 | Windows Node22 在链接树上递归复制导致进程退出 | 改显式遍历、不跟随链接 | `1.6.29.md:7`、`maintenance-issues-34-35.md:11` |
| 7 | 磁盘态与加载态混淆 | 归档存在即宣称"已加载"；写盘计数当运行时证据（#19） | `host-status` 分 `disk`/`process`，状态含 `unknown_runtime/different_instance` | `1.6.14.md:7-13`、`AGENTS.md:233` |
| 8 | 归档路径交给磁盘检查器 | `.asar/` 内路径被 `isFile` 排除 → 必需文件报 `missing_file`（#40） | 新增 `diagnosticHost`，只映射到同 Resources 下 `app`/`app.asar.unpacked` | `maintenance-issue-40.md:5-25` |
| 9 | 安装根与组件根混淆 | 自检读错组件、`findAiBase` 回退到别的安装（PR#33） | `currentHost()` 保定位语义，`normalizeHostBase()` 只探固定嵌套 | `maintenance-pr-33.md:7-11`、`AGENTS.md:268-271` |
| 10 | 统计口径错 | `undefined++` → `NaN`；`skipped` 被当成功；`disabled` 计成失败 | 初始化计数；` drifted` 新状态；`ALWAYS_SOFT_STATUSES` | `maintenance-022-diagnostics.md:11`、`1.6.63.md:3`、`maintenance-1.6.65.md:17` |
| 11 | 锚点漂移被软吞 | 目标在、锚点全不中仍报 `skipped`，状态页假绿 | `patchStatusReady("drifted")=false`，`ensureHostClean` 不再忽略 `pattern_not_found` | `1.6.63.md:3-5` |
| 12 | 静默部分替换 | 一条 pattern 命中多处或多文件只中一处 | `expect: N` 契约（含 0 次）+ `partial` + `fileAllRequired` | `1.6.64.md:3`、`AGENTS.md:488-495` |
| 13 | 补丁模板字面 `\n` | 注释吞掉下一行 → `Missing catch or finally after try`，DSH 起不来 | 只修模板并精确迁移已知损坏产物，不做全局替换 | `native-input-integrity.md:45-49`、`AGENTS.md:503-505` |
| 14 | YAML/预设不可解析即猜 | `toolFilter` 被新宿主拒绝，老预设整份挂载失败（#13/§18） | `preset-compat.js` 先 SHA256 备份，再在内存转成原生子预设 + `agentPreset`；未知策略停止 | `1.6.13.md:5-9`、`AGENTS.md:218-230` |
| 15 | 用户正文按关键词判默认（#72） | 命中 3 个模板标记即覆盖自定义正文 | 只对可证明来源的默认值更新；读取失败停止写入 | `maintenance-issues-72-74.md:5-15` |
| 16 | 重复入口 / 双 bundle | 手工 insert 与 bundle 同名 → `Cannot find package`，误判为重复安装后批量删配置 | 先核实 home/profile/bundle/别名；只迁移已确认重复项，合并全部 config，禁止按前缀删 | `INSTALLATION.md:79-107`、`AGENTS.md:497-505` |
| 17 | 锁活性靠年龄猜测 | 空锁/损坏锁被当死锁删除；或按 30 分钟强删 | 完整元数据原子发布（硬链接），只按真实 PID/进程启动时间回收，`LOCK_UNREADABLE`/`LOCK_LOST` 分别处理 | `maintenance-1.6.61.md:7-13`、`maintenance-issues-86-89.md:13` |
| 18 | 更新状态残留 | `pendingVersion` 只在与 running 相等时清；跨版本升级后永久卡住并阻断后续安装 | 运行版本与磁盘版本分开核对，保留 `lastPendingVersion` | `maintenance-update-state.md:5-13` |
| 19 | 部分成功当全部成功 | 多 profile 中失败副本被遗漏并可提前提交全局版本 pin | 逐 profile 读 manifest，`ok` 与 `applied` 分开，只重试失败目标 | `maintenance-issues-27-30.md:7-16` |
| 20 | 校验源被替换 | 源码 ZIP 追随移动分支；镜像自报摘要 | 固定 commit + Git blob 逐文件比对；镜像只传字节，摘要必须走 GitHub | `maintenance-issues-27-30.md:20-29`、`1.6.75.md:7` |
| 21 | 流/分段语义破坏 | 旧标记出现在普通句子会截断正文；取消不向上游传播；设置直写无审计 | 只认围栏外独占整行大写标记；取消向上传播且只关一次；统一从写入入口记账 | `maintenance-pr-58-61.md:20-31` |
| 22 | 插话降级副作用 | followup 兜底撤回已投递插话、打乱队列顺序（#90） | 恢复原生守卫与 `prompt(mode)` 分流，重复/过期请求保留原生错误码 | `steer-notes.md:7-11` |
| 23 | 输入被静默修补 | `decision.messages` 缺失被塞 `[]`，空轮当成功；装配异常返回空提示词 | 显式抛 `PURGE_INVALID_PRE_STEP_DECISION`，装配错误 rethrow 保留 code/cause | `native-input-integrity.md:9-10` |
| 24 | ChatML 单边标签吞噬 | 只有 `<|im_start|>system:` 没有闭合，后续官方段全被吞 | 成对保留、单边丢弃（`normalizeChatmlLayout`） | `1.6.62.md:4`、`maintenance-1.6.62.md:10-17` |
| 25 | 模块拆分丢常量 | `endOfBalancedBlock`/`SETTINGS_APPLY_CALL` 未随调用方迁移 → ReferenceError | 常量与调用方同址，ESLint no-undef 兜底 | `review-pr128-settings.md:3-7,19` |
| 26 | 缓存陈旧证据 | 进程级 memo 在归档删除/软链改向后仍返回旧身份 | 缓存只在一次只读诊断内共享；前端只合并 in-flight GET | `maintenance-issues-81-83.md:16-22` |
| 27 | 凭据文件权限过宽 | Windows `update-channel.json` 继承普通 Users 读取权限 | 受保护暂存目录建文件→写入→原子替换；旧文件首次读取收紧 DACL | `update-channel-122.md:11`、`1.6.67.md:7` |
| 28 | helper 被 Job Object 杀死 | `KILL_ON_JOB_CLOSE` 下换包助手随 launcher 退出（#89） | 先探测 Job 成员关系，在 Job 内由 WMI 提交一次性助手 | `maintenance-issues-86-89.md:26-39` |
| 29 | 清理失败触发错误回滚 | 已部分清理的 checkpoint 被拿去回滚 | 清理失败返回 `cleanup_warnings`，不回滚已提交安装 | `maintenance-issue-67.md:17` |
| 30 | 测试夹具依赖 cwd | `path.resolve('test/...')` 在 Windows runner 拼出不存在的路径 | 改 `import.meta.url`；加 `test/fixture-paths.test.mjs` 护栏 | `1.6.79.md:3-4` |
| 31 | CRLF/LF 与编码假设 | Windows CI 只认 LF；PowerShell 5.1 读 UTF-8 需 `-Encoding UTF8` | 同时覆盖 LF/CRLF；统一 `Get-Content -Raw -Encoding UTF8` | `1.6.84.md:7`、`AGENTS.md:214` 附近 §13 |

### 文档自身的缺陷（可直接作为"别这样写文档"的反例）

- `docs/releases/1.6.72.md:1` 标题写成 `# 1.6.73`，内容却是 1.6.72 的宿主适配；同一目录另有内容不同的 `1.6.73.md:1-4`。发行史出现"重号 + 缺失"。
- 补丁条数三处互相矛盾：`AGENTS.md:19,32,112` 说 86；`AGENTS.md:89` 说"全量 84"；`docs/preset-test.md:12` 说"全量 81"；`docs/releases/1.6.62.md:6` 说 82。
- `README.md:73` 的"1.6.39 更新"段把发行说明链接指向 `docs/releases/1.6.48.md`，版本与内容不符。
- `README.md` 与 `README.zh-CN.md` 字节完全相同（哈希一致），"中文副本一致"检查因此恒真，实质上是空检查（`MAINTENANCE.md:39` 声称会校验）。
- `docs/upstream/release-notes.md` 自 1.1.44 起中文段落整体 mojibake（`…:481-483`、`:501-503` 出现"涓枃/鐗堟湰"等 GBK 误解码字符），归档时丢了编码。
- 61 份发行说明不连续：`docs/releases` 缺 1.6.5、1.6.15–1.6.26、1.6.34、1.6.37、1.6.43、1.6.49–1.6.50、1.6.52–1.6.53、1.6.55、1.6.57–1.6.60、1.6.80–1.6.82，而 `AGENTS.md:249-259`、`:395-405` 仍在描述 1.6.34 / 1.6.52 的行为——行为有文档、版本无档案。

### (e) 诚实评估

**值得照抄的**（这部分是同类项目里少见的成熟度）：

1. **证据分级而不是布尔值**：`ok/pending/inferred/unknown/broken` + `drifted/disabled/partial`，并规定"未显式设置 ≠ 未生效"（`AGENTS.md:206`）。继任品只要保留这套词表就能避免 90% 的"假绿"投诉。
2. **负对照作为验收门槛**：新测试必须证明旧实现失败（`steer-notes.md:30`、`review-pr128-settings.md:19`）。这是把"我修好了"变成可验证命题的最低成本手段。
3. **禁止 mock 冒充实机 + 禁止借用正式安装**：`AGENTS.md:214`、`INSTALLATION.md:208`、`pr78-runtime-integrity.md:28-32`（明确记录"第一次 Windows 驱动没抓对退出码，整轮五场景重跑"）。
4. **发布说明保留未通过项**：1.6.61/1.6.69/1.6.70/1.6.75 连续多版把 Defender 阻断写在发行说明首段（`1.6.61.md:3`、`1.6.75.md:11`）。
5. **能力审计对齐上游**：`maintenance-1.6.64.md:6` 给出"82 vs 82，72 条逐字一致，6 条加强，4 条不取"的可复核账本；`maintenance-1.6.63.md:5-15` 逐条写"采纳/不采纳 + 理由"。
6. **注入正文的静态清点**：`inject-review.md:7-11` 用"47 段 / 79% 是强制语句 / 可删 0 段"直接否掉"把 21k 压到 6k"的幻想——先量化再谈优化。

**属于架构性问题的创可贴**（继任品应当换掉，而不是继承）：

1. **86 条字面锚点替换**是全部痛苦的源头：每个宿主 rc 都要重锚（`1.6.62`、`1.6.72`、`1.6.90`），于是必须发明 `diagnose`/`reanchor`/`expect`/`multiHit`/`silentWhenMissing`/`fileOptional`/`partial` 一整套补丁元数据语言来管理脆弱性。`MAINTENANCE.md:7` 自己承认"兼容状态不是'全部补丁已生效'的保证"。
2. **改宿主源码等于把每次官方升级变成迁移项目**：`AGENTS.md:44` 要求用户"不确定就点一次应用再重开"；`1.6.14.md:15` 承认 #19 长期开放。正确的替代是宿主侧正式扩展点（preset/section/hook），补丁只做无法扩展的少数项。
3. **Windows 换包 = 助手 + broker + Job Object + 回执 + 30 分钟超时**（`AGENTS.md:184-190`、`maintenance-issues-86-89.md:26-39`、`1.6.85.md:6`）。这条链每加一个平台补一层；`maintenance-next-host.md:114-118` 直接列出 NEXT/macOS handoff 未覆盖。
4. **文档即真相但没有真相源**：版本号靠脚本对齐（`1.6.3.md:37`），条数/行为/链接靠人肉，于是出现上面列出的 5 类文档缺陷。继任品应把"补丁条数、层数、支持版本、命令表"从代码里生成文档，而不是反向维护。
5. **拒绝重试与提示词注入都在猜模型**：`refusal-ab.md:89-108` 已经证明"声明式加固在带具体目标的请求上会被判成包装并强化拒绝"，而实现仍留在 `llm/stream` waterfall（`AGENTS.md:257-266`）。这是产品定位问题，不是 bug 修复能解决的。
6. **红队内容与杀软长期冲突**：同一文件 5 个版本被 Defender 隔离且不接受提交复核（`maintenance-integrity-169.md:52-54`）。继任品要么拆成可选内容包，要么根本不在主包里放 WebShell 示例。

## 对 Purge+ 的启示

**继承（原样搬走，几乎不需要改）**

- 证据分级词表与退出码契约：`ok/pending/inferred/unknown/broken`，仅 `broken` 退出 1，调用方必须读 `state`（`AGENTS.md:52-58,206`）。
- "磁盘 ≠ 加载"的三段式诊断输出：`disk` / `process` / `handoff`，以及 `unknown_runtime` 作为合法结果（`AGENTS.md:233`、`maintenance-issue-40.md:17-25`）。
- 探针机制（nonce 回显证明注入到达）+ 30 分钟 TTL（`AGENTS.md:96-110`）。
- 负对照测试纪律、禁止 mock 冒充实机、禁止指向正式安装（`steer-notes.md:30`、`AGENTS.md:214`、`INSTALLATION.md:208`）。
- 发行说明的"已知未通过项"首段制，以及"维护者批准发布 ≠ 已修复"的表述（`1.6.61.md:3`、`AGENTS.md:472`）。
- 上游对齐账本（逐条 采纳/不采纳 + 理由）（`maintenance-1.6.63.md:5-15`、`maintenance-1.6.64.md:6`）。
- 许可与署名三层：`LICENSE`（MIT）+ `NOTICE.md`（fork 关系与非背书）+ 第三方 dual-use 声明（`NOTICE.md:3-12`、`redteam-upstream-DISCLOSURE:4-74`）。

**重构（保留目的，换实现）**

- 补丁引擎：从"字面片段替换 + 手写 expect"改为"声明式能力开关 + 命中/漂移自动基线快照"，把 `diagnose`/`reanchor` 从人工流程变成引擎内建；`expect: N` 与 `fileAllRequired` 的语义要保留（`1.6.64.md:3`、`AGENTS.md:490-495`）。
- 状态与版本模型：把"运行版本 / 磁盘版本 / 待重启 / 上次失败"做成单一状态机并持久化 schema 版本，替代 `update-status.json` + `pendingVersion` + `installed-rev` 的散装字段（`AUTO-UPDATE.md:9`、`maintenance-update-state.md:9-13`）。
- 文档生成：补丁条数、层数、命令表、支持版本从代码常量生成；`check:docs` 升级为"生成物未漂移"检查，杜绝本报告列出的 5 类文档缺陷。
- 权限与凭据：把 `0600`/DACL/原子替换抽成独立模块（现存 `lib/atomic-files.js` 方向正确，`1.6.14.md:5`），并让所有写路径强制走它。

**替换/放弃**

- 放弃"改宿主源码"为主路径；继任品应优先使用宿主公开扩展点，把需要改源码的部分收敛成最小集合并显式标注"随宿主升级失效"。
- 放弃 Windows asar 换包助手链（broker/Job Object/回执）；改为主张用户走官方更新通道 + 插件侧只做只读诊断（`AGENTS.md:184-190` 的复杂度即反例）。
- 红队技能库从主包剥离为可选内容包，避免主包被 AV 隔离（`maintenance-integrity-169.md:26-28`）。
- 不再维护"两份同样内容的 README"；单一源 + 生成。
