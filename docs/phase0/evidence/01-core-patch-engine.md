# 01 · 宿主补丁引擎（lib/core.js + lib/patches/*）

> 对象：`dsh-purge-community` v1.6.91，路径 `pkg/plugin-copy/dsh-purge-community`。
> 所有结论按「文件:行号」取证，行号与 `read`/`grep` 工具输出一致。
> 引擎核心：`lib/core.js`（4624 行）。补丁数据在 1.6.69 拆出到 `lib/patches/`，`core.js` 只做转发导出
> （`lib/core.js:2381-2393`）。

## 职责

宿主补丁引擎负责一件事：**把 DSH（DeepSeek Harness）安装目录里 `@deepseek-ai/*` 的 JS/YAML 源码按字符串锚点就地改写**，
拆掉审批、沙箱、fs 围栏、计划模式、工具结果修剪等拦截，然后由用户重启宿主生效。它不属于运行时插件 API，
而是「离线源码打补丁 + 文件备份 + 状态机 + 解包/换包」四套机制的组合：

1. 补丁表：86 条声明式补丁，共 217 条 pattern/replace 替换（`lib/patches/*.mjs`）。
2. 目标解析：`targetFiles()` 把 72 个逻辑键映射到宿主真实路径（`lib/core.js:2805-3066`）。
3. 匹配/替换：`applyReplacementsToText()`，字面量 split/join 与正则两路，带命中数契约（`lib/core/shared.mjs`、`lib/core/verify.mjs:7-87`）。
4. 状态机：`patchStatus/readPatchReport/patchDrift`，9 种聚合状态 + 6 种逐文件状态（`lib/core.js:3624-3812`）。
5. 事务与回滚：profile 快照 + 逐文件 `.dshpurge.bak` + 原子写 + 失败拒写（`lib/core.js:1852-1890, 2646-2745, 3384-3528`）。
6. 宿主解包/换包：app.asar → `resources/app`，解完把归档改名让位（`lib/core.js:1947-2079`，`lib/extract-asar.js`）。

## 关键实现（带 file:line 证据）

### (a) ALL_PATCHES 数据模型与组装

组装顺序固定，`ALL_PATCHES` 是 5 个数组合并（`lib/patches/index.mjs:2-8`）：

| 模块 | 条数 | 说明 |
|---|---|---|
| `PATCHES`（prompt.mjs） | 10 | 提示词类大改（免责声明、身份句、审批句、预设） |
| `CODE_PATCHES`（code.mjs） | 3 | #6/#7/#8 沙箱与审批默认值 |
| `ENGINE_PATCHES`（engine.mjs） | 12 | #9-#16 审批/提权/沙箱、#91-#94 桌面与会话卫生 |
| `NEW_TOOL_PATCHES`（new-tools.mjs） | 59 | 工具面、rewind、agent-loop、hooks、hung-prompt 等 |
| `OPT_IN_PATCHES`（opt-in.mjs） | 2 | #18/#19，`disabledByDefault` |
| **合计** | **86** | 217 条 replacements，56 条为多文件补丁 |

`layer` 只是展示标签，与所在模块无关：#11/#12 是 `layer:"提示词"` 却住在 `engine.mjs`（`lib/patches/engine.mjs:40,63`）。
按 layer 计数：`提示词 27`、`代码 47`、`工具 9`、`0.1.5 兼容 1`（#40）、`0.2.0 兼容 2`（#47/#49）。

单条补丁的字段（真实使用情况已核对）：

| 字段 | 语义 | 引擎读取处 |
|---|---|---|
| `id` | 数字主键，`tuning.extraPatches`、显示分组、selfcheck 都按它引用 | `lib/core.js:3703-3707` |
| `name/layer/layer_en/desc` | 展示用 | 面板/CLI |
| `file` | 目标键或键数组 | `lib/core/shared.mjs:209-211`（`fileKeysOf`） |
| `replacements:[{pattern,replace,expect?}]` | 主形态 | `lib/core/shared.mjs:230-234` |
| `patterns:[str]+replace+marker` | 旧形态，被归一成 replacements | `lib/core/shared.mjs:232-233` |
| `markers[]/markersAny/marker` | 「已应用」判定，`markersAny` 取 some，否则 every | `lib/core/shared.mjs:166-175` |
| `forbid[]` | 出现即判「未应用」，用于淘汰旧版错误改写 | `lib/core/shared.mjs:165` |
| `optional` | 第三方/不在场目标，锚点不中算软通过 | `lib/core/verify.mjs:115,202` |
| `disabledByDefault` | 只有 `tuning.extraPatches` 列出才打 | `lib/core.js:3702-3707` |
| `strictFiles` | 硬失败语义：锚点不中必须报错（仅 #43/#70/#71/#90） | `lib/core.js:3489,3497`；`lib/steering.js:36` |
| `fileAllRequired` | 多文件补丁全部必须落地，否则 `partial`（仅 #57） | `lib/core.js:3792-3794` |
| `fileOptional[]` | 该目标已不承载该行为，不参与 partial（#32/#36/#62） | `lib/core.js:3769,3792` |
| `silentWhenMissing` | 「找不到」本身就是正确状态，判 skipped 而非 drifted | `lib/core.js:3262` |
| `settleWhenAbsent` | 撤销型补丁，宿主本来没有等于已到位（#35/#80/#82） | `lib/core.js:3638` |
| `chainedAfter` | 依赖前置补丁 id，只影响漂移诊断（#88→#87） | `lib/core.js:3640-3643` |
| `skipIfMarked` | 有 marker 就不再 replaceAll，防重复叠层 | `lib/core/verify.mjs:24-26` |
| `softSettle` | 残留 pattern 没了即算完成（#21/#48/#71） | `lib/core/shared.mjs:205-207` |
| `surfaces[]` | 只在指定 surface 生效（7 条 desktop-only：#45/#46/#82/#83/#84/#91/#92） | `lib/core/verify.mjs:103-108` |
| `expect`（在单条 replacement 上） | 命中数契约 | `lib/core/verify.mjs:40-45,60-65` |
| `rel`、`multiHit`、`optIn` | **引擎完全不读**（全仓库 grep 无读取点），纯文档残留 | 无 |

### (b) targetFiles()：键 → 宿主路径

`targetFiles(aiBase, dshHome)`（`lib/core.js:2805-3066`）用三种取值器组装 72 个键：

- `firstExisting([...])`：按优先级取第一个存在者（`lib/core.js:2448-2452`）。
- `allExisting([...])`：全部存在的都收进数组（`lib/core.js:2453`），用于「运行入口 + 编译残留」双写，例如 `escalation` 同时覆盖
  `dsh-sandbox/lib/index.js` 与 `lib/types/escalation.js`，注释明确说明「入口排前，保证 markers 命中真正被执行的文件」（`lib/core.js:2859-2867`）。
- `nestedPkg(aiBase, pkg, ...rel)`：同时尝试 `aiBase/pkg/...` 与 `aiBase/dsh/node_modules/@deepseek-ai/pkg/...` 两种 npm 嵌套布局（`lib/core.js:2747-2752`）。

路径解析关键点：

- 单包目录布局：`path.join(aiBase, "dsh-<pkg>", "lib", "index.js")`（`lib/core.js:2811-2818` 等）。
- monorepo 源码布局兜底：`packageRootFromAiBase()` 用 `dsh-base` 的 realpath 回退三级推出仓库根，再拼 `packages/<域>/<包>/...`（`lib/core.js:2754-2762`；示例 `lib/core.js:2813,2827,2848`）。
- 用户目录目标：`userPresetYml(dshHome,"unrestricted")`、`.agent-presets/liangshen/**`、`profiles/web/node_modules/**`（`lib/core.js:2842-2845,2890-2893,2950-2952`）。
- 显式禁止项：`profiles/<name>/cordis.patch.yml` 被排除在 targetFiles 之外，注释给出理由「版本升级自愈会把用户后来追加的 insert 盖掉（#43）」（`lib/core.js:2839-2841`）。
- 落地过滤：`filterTargetFiles()` 删掉空值/空数组键，缺键由 `pathsOf()` 返回 `[]`（`lib/core.js:2764-2785`，`lib/core/shared.mjs:274-279`）。
- 路径分区白名单：`pathZone()` 把路径分为 `desktop-install / desktop-profile / web-profile / web-install / shared`，`allowTargetForPatch()` 按当前 aiBase 决定是否允许写（`lib/core.js:924-957`）。桌面 surface 只碰桌面树+shared，Web surface 反过来不许碰桌面树。

键的实际使用情况（node 加载补丁表与实际声明对比）：补丁引用 **69 个键**，其中 `tool-web-nested / hooks-claude-code-nested / hooks-codex-nested / system-prompt-nested` 由 `nestedTargetFiles()` 按需登记（`lib/core.js:2793-2803`）。
声明了却没有任何补丁使用的键 7 个：`agent-instructions-bootstrap`、`compaction-instant-client`、`base-package`、`deliverables-prompt`、`dsh-tools`、`dsh-tools-types`、`dsh-tools-ptc`（死登记）。

### (c) applyReplacementsToText：匹配/替换算法

入口 `applyReplacementsToText(text, patch, fp)`（`lib/core/verify.mjs:7-87`）：

1. 特例前置：#42 若命中现代 settings API，走 `modernSettingsPatch()` 的「先反向撤销旧 shim、再前向打新 shim」路径（`lib/core/verify.mjs:10`，`lib/core/shared.mjs:88-109`）；旧版重复 `legacyApplyPath` 定义会被折叠（`lib/core/shared.mjs:45-71`）。
2. `skipIfMarked && patchApplied()` → 直接返回未改动，止住「自匹配 pattern 每轮叠一层」（`lib/core/verify.mjs:24-26`，动机注释见 `lib/patches/prompt.mjs:8-11`）。
3. CRLF 归一：先 `asLf()` 全文转 LF，最后按原文件是否含 `\r\n` 还原（`lib/core/verify.mjs:27,29,85`）。
4. YAML 特判：`.yml/.yaml` 目标跳过「无缩进身份句」锚点（`isBareIdentityNeedle`，`lib/core/shared.mjs:236-241`），并把 replace 里的行尾 `//` 注释转成 `#`（`yamlJsCommentsToHash`，`lib/core/shared.mjs:243-272`）。
5. 逐条 replacement：
   - 正则分支：`expect` 先用 `match(cloneRegExp(p,g))` 数命中（`lib/core/verify.mjs:40-45`），再 `out.replace(re, written)` 以**字符串形态**调用，从而保留 `$1..$9`（`lib/core/verify.mjs:50-52`）。
   - 字面量分支：`expect` 用 `out.split(needle).length - 1` 数命中（`lib/core/verify.mjs:60-65`），然后 `out.split(needle).join(written)` **全量替换**（`lib/core/verify.mjs:67`）。没有 `expect` 的补丁命中几次就改几次。
   - 命中数不符 → 立即整体回退为原文并返回 `hitMismatch {patch_id, expected, actual, file}`（`lib/core/verify.mjs:42-44,62-64`），调用方记 `hit_mismatch:期望!=实际` 并计未打上（`lib/core.js:3456-3462`）。全表只有 **#93 一条**使用 `expect`（`expect:3` 与 `expect:1`，`lib/patches/engine.mjs:285-300`）。
6. #90 半迁移保护：`changed` 但 `nativeSteeringRestored(out)` 为假 → 丢弃本次改写、返回原文并 warn（`lib/core/verify.mjs:73-79`）。

「已应用」判定 `patchApplied(text, patch)`（`lib/core/shared.mjs:157-176`）：先过 `forbid`（命中即 false），再 `markers`（`markersAny` 用 some、否则 every），再单 `marker`，最后退化到「replace 首行前 60 字符是否出现」。四条补丁有专用结构检查（#17/#61/#93 见 `lib/core/shared.mjs:113-155`；#42 见 `lib/core/shared.mjs:162-164`；#90 见 `lib/steering.js:53-66`）。

`forbid` 语义实例：#89 用 `"[dsh-purge] ask_user_question never blocks a turn"` 宣布旧版 1 秒硬写为「未应用」，再由迁移 pattern 精确替换（`lib/patches/new-tools.mjs:2462-2476`）。

### (d) patchStatus / patchStatusDetail / patchDrift 状态机

逐文件判定 `filePatchOutcome()`（`lib/core.js:3243-3265`）：

- `patchApplied` 为真 → `applied`
- `patchHasRemainingWork`（还有 pattern 在） → `pending`
- `silentWhenMissing` → `skipped`
- pattern 里带 `[dsh-purge]`（自标记/撤销型） → `skipped`
- 其余（文件在、marker 不在、锚点全不中） → `drifted`

聚合 `readPatchReport()`（`lib/core.js:3718-3812`）优先级（自上而下）：

| 状态 | 触发条件 | 证据 |
|---|---|---|
| `na` | surface 不适用（#91 另有 legacy 探测分支） | `lib/core.js:3724-3728` |
| `disabled` | `disabledByDefault` 且不在 `extraPatches` | `lib/core.js:3730-3732` |
| `unknown` | 任一目标文件读不了 | `lib/core.js:3755,3795` |
| `unmatched` | #71 YAML 解析失败，或 `strictFiles` 补丁有文件判 skipped | `lib/core.js:3762-3766,3780-3782` |
| `pending` | 还有锚点在 | `lib/core.js:3797` |
| `partial` | `fileAllRequired` 且 applied>0 且某必需键未命中 | `lib/core.js:3792-3794,3798` |
| `applied` | 至少一个文件已落地 | `lib/core.js:3799` |
| `drifted` | 至少一个文件漂移 | `lib/core.js:3800` |
| `skipped` | 只有 skipped 计数 | `lib/core.js:3802` |
| `missing_file` | 无任何目标文件（`optional` 则 `na`） | `lib/core.js:3803` |

逐文件明细 `detail[p.id] = [{key,path,status}]`，status 取 `applied|pending|drifted|unmatched|skipped|unreadable`（`lib/core.js:3754,3764,3773-3785`），对外字段名 `patch_files`（`lib/core.js:4542,4598`），面板按 `total/done` 展示（`client.js:10205-10208`）。
`patchStatus()` 与 `patchStatusDetail()` 共用同一个 `readPatchReport`，前者只返回 `.status`（`lib/core.js:3709-3716`）。

apply 侧另有一套**更粗**的聚合 `rollupPatchStatus()`（`lib/core/verify.mjs:89-99`），只有 `applied|already|missing_file|skipped|pattern_not_found|<error>` 六种，**没有 partial 分支**；软通过集合 `ALWAYS_SOFT_STATUSES` 含 `applied/already/missing_file/skipped/na/off/disabled`（`lib/core/verify.mjs:101`），`patchStatusReady()` 对 `skipped/missing_file` 一律返回 true（`lib/core/verify.mjs:197-204`）。

漂移诊断 `patchDrift()`（`lib/core.js:3624-3687`）：先跑一遍 `patchStatus`，对非 applied 的补丁逐 pattern 复查是否命中（`lib/core.js:3658-3673`），三分桶 `drifted / optionalDrift / chained / missing`；`locateAnchor()` 用锚点里最独特的 8 个标识符（去掉停用词）在新文件里找命中行，给出 5 行候选片段（`lib/core.js:3580-3622`）。

### (e) 应用事务：备份 → 写 → 校验 → 失败回退

真实顺序（`applyPatchesAllHosts` → `applyPatches`）：

1. 逐宿主 `backupAll(aiBase)`；**任一文件备份失败即抛错、整轮不写**（`lib/core.js:1866-1873`）。
2. `backupAll` 用 `fs.openSync(bak,"wx")` 独占建占位，`EEXIST` 视为已有备份直接跳过，之后 `atomicCopyFile`；失败清理占位（`lib/core.js:2646-2680`）。备份名固定 `<file>.dshpurge.bak`（`lib/core.js:2509`）。
3. `applyPatches` 再做一次 profile 级快照（`Maintenance.backup("before-host-patches")`），失败只 warn 不阻断（`lib/core.js:3384-3396`）。
4. 自愈两步：`restoreMissingOriginalsFromBak()`（原文丢失/被写成空文件时从 bak 拷回，空或非普通文件的 bak 不采用，`lib/core.js:2534-2580`）、`refreshStaleBaksForUpgrade()`（当前文件不含 `dsh-purge` 字串且与 bak 不同 → 视为官方升级，把 bak 刷成新基线，`lib/core.js:2608-2644`）。
5. 逐补丁逐文件写入：`saveText()` 先读字节比对，相同则返回 false（记 already），不同则 `atomicWriteFile`（`lib/core.js:3303-3314`）。
6. 原子性与权限：写临时文件 `<file>.<pid>.<uuid>.tmp`，`wx` 打开，`chmod` 回原 `mode & 0o777`，再重命名；rename 遇 `EPERM/EACCES/EBUSY` 退避重试 5 次（`lib/atomic-files.js:9-15,16-38,53-64`）。CLI 启动器的可执行位也靠这条路径保住。
7. 写后校验：`applyPatches` 自身**不做**复读校验，只按 `changed/!changed` 累加计数（`lib/core.js:3477-3491`）。真正的校验在调用方：面板/CLI 用 `allPatchHostsWritten()`+`hostCleanMarkersPresent()`（`lib/core.js:1837-1839,2105-2113`；`lib/index.js:1231-1241`），自愈路径 `ensureHostClean()` 重新跑 `patchStatus` 检查是否还残留 pending（`lib/core.js:2145-2192`）。
8. 失败回退的边界：**单文件写失败只记 `write_error:`，不回滚已写的其它文件**（`lib/core.js:3482-3484`）；整轮级回退只发生在解包阶段（`commitExtractedDir` 失败→恢复 prev→写 `recover.json`，`lib/extract-asar.js:377-409`）和备份阶段（拒写）。`lib/rollback-transaction.js` 是插件安装回滚用的，与宿主补丁无关（`lib/community.js:19`）。

`revertAll()`（`lib/core.js:2692-2745`）：先补回丢失原文，再逐文件「bak 存在且与当前字节不同」才 `restoreBackupFile` 并删 bak；**没有 bak 时绝不删除目标**（`lib/core.js:2734-2735`）；用户 patch 层即使有 bak 也只删 bak 不动文件（`lib/core.js:2709-2719`）。

### (f) ensureHostClean、revert、宿主解包与放行

- `ensureHostClean()`（`lib/core.js:2134-2197`）：定位/解包官方宿主 → 枚举全部补丁宿主 → 任一 pending / 未写全 / cmd-flash 未静音就整轮 apply → 复查仍 pending 或失败即返回 `{ok:false}` 取消重启。它是「重启前必须干净」的闸门（错误文案「清洗没有完成，已取消重启」，`lib/core.js:2185`）。
- 解包：`sealedAsarHandoff()` 只在 desktop surface 且能确认 exe + `app.asar` 是文件时返回句柄（`lib/core.js:1947-1976`）；`openSealedDesktopHost()` 决定是否解包（`shouldExtractAsar`：目录不可用 / 归档 size+mtime 与记录不符 / upgrade 标记，`lib/extract-asar.js:244-251`），解到旁路 `<app>.dshpurge-next`（`lib/extract-asar.js:354-364`），补 `.unpacked` 原生文件（`lib/extract-asar.js:318-346`），校验目录里确有 `@deepseek-ai` 才 `commitExtractedDir` 换上去，失败删半成品并 `restoreUnusableExtract`（`lib/core.js:2041-2071`）。归档身份戳存 `$DSH_HOME/dsh-purge/unpacked-asar.json`（`lib/core.js:1978-1999`）。
- 「再密封」= 让位而非重建 asar：`renameAsarAside()` 把 `app.asar` 改名为 `app.asar.bak`，让 Electron 只能加载解包目录（`lib/extract-asar.js:195-209`）；`scheduleSealedDesktopRestart()` 在 Windows 走桌面层换包等待、macOS 走 handoff（`lib/core.js:2094-2101,2200-2220`）。因此仓库里**没有重新打包 asar 的代码**。

### (g) 锚点本地覆盖（lib/anchors.js）

- 覆盖文件 `$DSH_HOME/dsh-purge/anchor-overrides.json`，结构 `{ "<patchId>": { "<replacementIndex>": {pattern, at, host} } }`（`lib/anchors.js:1-26`）。写 `0o600`、目录 `0o700`（`lib/anchors.js:49-50`）。
- 引擎侧 `applyOverrides()` 把覆盖叠进 `replacements` 的对应下标，只换 `pattern` 保留 `replace`，并给补丁打 `overridden:true`（`lib/anchors.js:67-84`）。
- 生效路径：`patchReplacements()` 每次先 `applyOverrides(p, overridesSnapshot())`（`lib/core/shared.mjs:230-234`），快照缓存在模块级 `cachedOverrides`，写覆盖后必须 `refreshAnchorOverrides()` 才重读（`lib/core/shared.mjs:213-228`）。
- 覆盖只影响 pattern：apply 与 status 都走 `patchReplacements`，所以重锚后状态机自动对齐；`patchDrift` 会把 `overridden` 带进漂移行（`lib/core.js:3667`）。
- 写覆盖的唯一入口是 CLI `purge-community reanchor apply <id> [--index n] [--lines a-b] [--yes]`：先 dry-run 打印候选片段、校验片段在文件里唯一出现（`bin/community.js:88-106`），`--yes` 才 `writeOverride` + 审计 + 刷新缓存（`bin/community.js:107-113`）。`clear` 删除单条或整条（`lib/anchors.js:54-64`）。

### (h) 硬编码耦合

- **锚点是宿主源码的逐字副本**：#16 复制整个 `checkedTarget()` 方法体（`lib/patches/engine.mjs:207-221`），#56 的 replace 里塞进一整段压缩后的 rewind 判定函数（`lib/patches/new-tools.mjs:1859`）。宿主改一个字符锚点即失效。
- **同一逻辑的多个版本锚点并联**：#15 同时挂「新签名」与「旧 async 签名」两段（`lib/patches/engine.mjs:129-186`）；#23 三条（`lib/patches/new-tools.mjs:76-97`）；#1 六条 V1/V2/旧名/新名（`lib/patches/prompt.mjs:13-68`）；#40/#47/#49/#74/#87/#88 同理。
- **包名与目录名写死**：`dsh-*` 前缀 + `@deepseek-ai` scope 遍布 `targetFiles`（`lib/core.js:2811-3060`）；`dsh-base` 被当作版本根锚点（`lib/core.js:2756-2758`）；`dsh-agent-loop/package.json` 被当作 version 来源，但**只写进审计**、不参与任何分支（`lib/core.js:3513-3519`）。
- **升级识别靠 marker 字串**：`refreshStaleBaksForUpgrade` 以「当前文件是否含 `dsh-purge`」判断是不是我们改过的版本（`lib/core.js:2597-2607,2632-2633`）。
- **surface 常量**：`desktop/web` 由 `lib/surface.js` 派生，补丁用 `surfaces:["desktop"]` 硬绑 7 条（`lib/patches/engine.mjs:240,260`；`lib/patches/new-tools.mjs:2250-2256`）。
- **版本适配只写在注释里**：`0.2.1 起…`、`0.2.2：…搬了家`（`lib/core.js:2829,3041`），代码没有版本比较分支。

## 数据流与状态

```
[用户点应用 / CLI apply]
   ↓ resolveOfficialAiBase → openSealedDesktopHost（必要时解包 + 归档改名）
   ↓ enumeratePatchAiBases（多宿主去重，realpath 归一见 core.js:1781-1810）
   ↓ backupAll（逐文件 .dshpurge.bak，任一失败→整轮拒写）
   ↓ applyPatches（profile 快照 + 自愈 bak + 逐 patch 逐文件）
       patchReplacements(p)  ← anchors.applyOverrides（本地重锚）
       applyReplacementsToText → hitMismatch? 拒写 : saveText(atomicWriteFile)
       rollupPatchStatus（粗聚合）
   ↓ patchAllShims / silenceCmdFlash / hostCleanMarkersPresent
   ↓ 面板/CLI 判 complete → 安排重启（sealed→换包，manual→让用户自己点）
   ↓ 用户重启后：patchStatusDetail 逐文件复核 + patchDrift + selfcheck
```

状态流变（单补丁）：

`pending`（锚点在）→ apply → `applied`（marker/结构检查通过）/ `already`（字节相同）
失败面：`pattern_not_found`（apply 侧）/`drifted`（status 侧，宿主改版）/`unmatched`（strictFiles 或 YAML 坏）/`missing_file`（键全空）/`unknown`（读不了）/`partial`（fileAllRequired 部分命中）/`disabled`（opt-in 未开）/`skipped`（自标记或 silentWhenMissing 的「本来没有」）。

落盘状态：
- `<host-file>.dshpurge.bak`：逐文件原文基线（`lib/core.js:2509`）。
- `$DSH_HOME/dsh-purge/unpacked-asar.json`：解包时的归档 size/mtime 指纹（`lib/core.js:1978-1999`）。
- `$DSH_HOME/dsh-purge/anchor-overrides.json`：本地重锚（`lib/anchors.js:19-25`）。
- `$DSH_HOME/dsh-purge/tuning.json`：`extraPatches` 决定 opt-in 补丁是否参与（`lib/core.js:3690-3700`）。
- `$DSH_HOME/dsh-purge-community/audit.jsonl`：apply/revert/reanchor 审计（`lib/core.js:3511-3525,2738-2743`；`bin/community.js:109`）。
- 内存：`DISPLAY_GROUP_BY_ID` 由 `PATCH_DISPLAY_GROUPS` 填充（`lib/core.js:2391-2393`），面板把升级链合成一行显示；
  `cachedOverrides` 是唯一会被写操作显式失效的缓存（`lib/core/shared.mjs:213-228`）。

## 真实能力清单

| 能力 | 入口 | 实现位置 | 真实现 | 证据 |
|---|---|---|---|---|
| 声明式补丁表（86 条） | `ALL_PATCHES` | `lib/patches/index.mjs:8` | 是 | node 加载计数 86，217 条 replacements |
| 宿主文件键解析（72 键） | `targetFiles()` | `lib/core.js:2805-3066` | 是 | `filterTargetFiles` 落地过滤 `2764-2785` |
| 字面量/正则替换 + 命中数契约 | `applyReplacementsToText()` | `lib/core/verify.mjs:7-87` | 是（expect 仅 #93 用） | `verify.mjs:40-45,60-65` |
| CRLF/YAML 语义保持 | 同上 | `lib/core/verify.mjs:27-36,85`；`shared.mjs:243-272` | 是 | 行尾注释转 `#`、BOM/缩进锚点特判 |
| 多文件补丁与 partial 判定 | `readPatchReport()` | `lib/core.js:3792-3798` | 是（仅 #57 声明 fileAllRequired） | `lib/patches/new-tools.mjs:1963-1967` |
| 软通过/硬失败分级 | `strictFiles/optional` | `lib/core/verify.mjs:110-118,197-204` | 是 | 硬失败仅 4 条补丁 |
| 逐文件状态明细 | `patchStatusDetail()` | `lib/core.js:3714-3716,3718-3812` | 是 | 输出 `patch_files`（`4542`） |
| 漂移诊断 + 新落点建议 | `patchDrift()` / `locateAnchor()` | `lib/core.js:3599-3687` | 是 | token 打分取 5 行片段 |
| 本地重锚覆盖 | CLI `reanchor *` | `lib/anchors.js:38-84`；`bin/community.js:37-116` | 是 | dry-run 校验唯一性 `bin/community.js:88-91` |
| 逐文件备份 | `backupAll()` | `lib/core.js:2646-2681` | 是（wx 独占，旧 bak 不刷新） | `2659-2668` |
| 原子写 + 权限保留 | `atomicWriteFile()` | `lib/atomic-files.js:53-64` | 是 | chmod 原 mode `9-15,58` |
| 整轮回滚 | `revertAll()` | `lib/core.js:2692-2745` | 是（依赖 bak 完整） | 无 bak 不删 `2734-2735` |
| 写失败单文件回滚 | — | — | **否** | 只记 `write_error:`，`3482-3484` |
| 多宿主 apply | `applyPatchesAllHosts()` | `lib/core.js:1852-1890` | 是（首宿主备份失败即整轮中止） | `1866-1873` |
| opt-in 补丁开关 | `patchEnabled()` + tuning | `lib/core.js:3702-3707` | 是（仅 #18/#19） | `lib/patches/opt-in.mjs:23-24` |
| asar 解包 | `openSealedDesktopHost()` | `lib/core.js:2021-2079` | 是 | 旁路解包 + 提交 + 失败恢复 |
| asar 重新打包 | — | — | **否** | 仅 `renameAsarAside` 让位 `extract-asar.js:195-209` |
| 重启/换包编排 | `planApplyRestartAction()` 等 | `lib/core.js:2200-2271`；`lib/index.js:1160-1175` | 是（桌面未运行→`needsDesktopApply`） | `lib/core.js:2260-2263` |
| 升级自愈（bak 基线刷新） | `refreshStaleBaksForUpgrade()` | `lib/core.js:2608-2644` | 是（启发式） | marker 字串判据 `2632-2633` |
| 面板显示分组 | `PATCH_DISPLAY_GROUPS` | `lib/patches/index.mjs:11-22`；`lib/core.js:2391-2393` | 是（8 组） | 组内 id 例：`disclaimer:[1,2,3]` |

### 10 条代表性补丁（改了什么宿主文本 → 行为变化）

| # | 名称 | 目标文件 | 宿主文本改动 | 行为变化 |
|---|---|---|---|---|
| 1 | WORKSPACE_CONTEXT_INTRO | `dsh-agent-instructions/lib/index.js` | `const (WORKSPACE_CONTEXT|AGENT_INSTRUCTIONS)_INTRO = "The following workspace instructions…"` → 强句 `STRONG_INTRO`（含 "ACTIVE and MANDATORY"、"不要软拒绝/硬拒绝"）`lib/patches/prompt.mjs:13-68`、`lib/patches/shared.mjs:2-18` | 每条工作区规则被包上「强制、优先于冲突行为」的措辞 |
| 6 | SANDBOX_DENY_FILE_WRITE | `dsh-sandbox-local/lib/index.js` | `"(deny file-write*)"` → `"(allow file-write*)"` `lib/patches/code.mjs:3-11` | bwrap 配置不再 deny 写文件 |
| 9 | APPROVAL_AUTO_GRANT | `dsh-user-approval/lib/{index,types,invariant}.js` | `if (effectivePolicy(session) === "never") return "rejected";` 后整段 waterfall 调用 → `return "allowed-once";` + 注释；types 里 `'never'` 分支同样改写 `lib/patches/engine.mjs:3-29` | 审批请求不再走 waterfall、不再 fail-closed，全部自动放行 |
| 15 | SANDBOX_CONFINE_PASSTHROUGH | `dsh-sandbox-local/lib/index.js` | 整个 `confine(argv, policy){…}` 方法体 → `return {argv:[...argv], enforcement:"full", denialSignatures:[], runnerFailureRules:[]}` `lib/patches/engine.mjs:124-201` | 三种 mode 都以原 argv 执行，且没有任何 denial 签名可被判定 |
| 16 | FS_FENCE_DISABLED | `dsh-fs-sandbox/lib/index.js` | `async checkedTarget(target, sandboxPolicy){…}` 整段（含 read-only / workspace-write 两处抛错）→ `return target;` `lib/patches/engine.mjs:203-231` | 写/改文件不再受围栏限制 |
| 17 | FS_OBSERVATION_INTENT_FREE | `dsh-fs-observation-policy/lib/index.js` | `writeIntent` / `requirePresent` / `editIntent` 三个方法体 → `return void 0;` `lib/patches/new-tools.mjs:13-26` | 取消「先读再改」与版本前置校验（`FS_NOT_OBSERVED` 不再触发） |
| 22 | READ_CAPS_RAISED | `dsh-tool-fs/lib/index.js` | `READ_MAX_LINE_LENGTH 2e3→1e4`、`READ_MAX_BYTES 50*1024→1024*1024`、`READ_LIMIT 2e3→2e4` `lib/patches/new-tools.mjs:53-67` | 单次 read 的行长/字节/行数上限 5–20 倍放宽 |
| 55 | SYSTEM_PROMPT_REPLACE_HEAD | `dsh-agent-loop/lib/index.js` | `inHistory: preparedCall?.systemPromptUpdate === "in-history",` → `inHistory: false,` `lib/patches/new-tools.mjs:1313-1317` | 每步用当前系统提示替换首个 system 节点，旧提示不被钉住 |
| 62 | OFFICIAL_TOOL_ASK_FAILOPEN | `dsh-tools/lib/pipeline.js`、`lib/types/pipeline.js` | `const approval = this.ctx.get("approval");` 后插 `if (true) return { decision: { kind:"allow" }, approvalCancelled:false };` `lib/patches/new-tools.mjs:2106-2114` | 无审批服务时直接 allow（用户点拒绝仍 deny） |
| 90 | RESTORE_NATIVE_STEERING | `dsh-api-session-controller`、`dsh-agent-loop` | 旧 `[dsh-purge-85]/[dsh-purge-86]` 改写（steer→followup）还原为原生 `agent.steer/followup` 分流 `lib/steering.js:3-49`；半迁移会被 `nativeSteeringRestored` 拒绝落盘 `lib/core/verify.mjs:73-79` | 插话恢复原生行为，且禁止「部分迁移」污染宿主 |

（另有 #89 把 `ask_user_question` 的 `-1` 收成 300 秒并迁移旧的「硬写 1 秒」，`lib/patches/new-tools.mjs:2467-2476`；#91 会话 cookie 名忽略端口避免 431，`lib/patches/engine.mjs:239-252`；#92 用幂等自匹配正则给宿主加 `--max-http-header-size=262144`，`lib/patches/engine.mjs:262-273`。）

## 依赖与耦合

- 内部强耦合：`core.js` 与 8 个模块构成环状依赖 —— `core/shared.mjs` 反向依赖 `extract-asar.js` 的 `hostFs`（`lib/core/shared.mjs:2`）、`steering.js`（`:3`）、`anchors.js`（`:4`）；`anchors.js` 刻意不 import core 以免成环（`lib/anchors.js:11-12`）。`core.js` 仍是聚合门面（`lib/core.js:2381-2393`）。
- 宿主耦合：写死 `@deepseek-ai/*` 包名、`lib/index.js`、`cordis.patch.yml`、`lib/types/index.js` 等入口路径（`lib/core.js:2747-2752,2805-3066`），并依赖 DSH 的 `system-prompt/assemble`、`approval/request`、`llm/stream` 等方法名出现在锚点里。
- 平台耦合：`win32` 分支走 `desktop.restartOfficialHarness`、`darwin` 走 handoff（`lib/core.js:2205-2218`）；`renameAsarAside` 必须用 `original-fs`，因为 Electron 把 `app.asar` 伪装成目录（`lib/extract-asar.js:185-209`）。
- 外部运行时依赖：`yaml` 仅用于 #71 的 preset 解析，且按需动态 import 以保住无 node_modules 的引导 CLI（`lib/core.js:3760-3766`）。
- 上层耦合：`lib/index.js`（HTTP/命令/工具面）直接调 `applyPatchesAllHosts`/`revertAll`/`ensureHostClean`，`bin/community.js` 直接调 `patchDrift`+`applyReplacementsToText` 做 dry-run；因此引擎的返回结构（`{status,files}`、`apply report 行`）是对外契约。

## 局限与缺陷（带证据）

1. **不是真事务**：写失败只记 `write_error:` 并继续下一个文件，已写文件不回滚（`lib/core.js:3482-3484`）；`applyPatches` 也没有写后复读校验（对比 `3477-3491`）。结果是「半打」状态只能靠下次 apply 或 revert 收敛。
2. **apply 与 status 两套聚合口径不一致**：`rollupPatchStatus` 无 `partial` 分支（`lib/core/verify.mjs:89-99`），而状态页会给出 `partial`（`lib/core.js:3798`）。`fileAllRequired` 只在 status 侧生效，apply 汇总可能报 applied。
3. **软通过面积过大**：47 条 `optional` + `ALWAYS_SOFT_STATUSES` 含 `skipped/missing_file`（`lib/core/verify.mjs:101,197-204`），`drifted` 虽不再算绿（`lib/core.js:3800`）但 `skipped` 仍算 ready；自标记补丁（pattern 含 `[dsh-purge]`）会永久 skipped（`lib/core.js:3250-3264`），面板易「假绿」。
4. **备份基线可能与宿主版本错位**：`backupAll` 对已存在 bak 直接 `continue`（`lib/core.js:2664-2665`），只有 `refreshStaleBaksForUpgrade` 的启发式会刷新（`lib/core.js:2608-2644`）；一旦宿主被官方更新但文件仍含 `dsh-purge` 字串，旧 bak 会被保留，`revertAll` 可能把旧版源码写回新版（注释自述该风险：`lib/core.js:2599-2607`）。
5. **首宿主失败即整轮中止**：`backupAll` errors 直接 `throw`（`lib/core.js:1868-1873`），后面的宿主一个都不会尝试，多装场景没有 per-host 隔离。
6. **锚点脆弱且无版本分支**：锚点是宿主源码逐字副本（`lib/patches/engine.mjs:131-186`、`lib/patches/new-tools.mjs:1859`），`expect` 全表仅 1 条使用（`lib/patches/engine.mjs:285-300`），因此宿主把同一片段复制两次时会被静默一起改掉；`host_version` 只写审计（`lib/core.js:3513-3519`），没有版本到补丁集的映射表。
7. **死字段与死键**：`rel`/`multiHit`/`optIn` 引擎不读（全 lib grep 无读取点）；`targetFiles` 声明了 7 个无补丁使用的键（见 §(b)）。
8. **状态命名双轨**：聚合用 `unknown`、明细用 `unreadable`（`lib/core.js:3755,3795`）；`missing_file` 与 `na` 只差一个 `optional`（`3803`），调用方容易误判。
9. **opt-in 读取静默降级**：`readExtraPatches` 解析失败返回 `[]`（`lib/core.js:3690-3700`），#18/#19 会静默变回 disabled，用户看不到配置损坏。
10. **性能**：`patchDrift` 先完整跑一遍 `patchStatus` 再读一遍所有目标文件（`lib/core.js:3626,3647-3673`），`targetFiles` 每次调用都 `existsSync` 全部候选，CLI `diagnose` 在慢盘上是双倍 IO。
11. **`forbid` 与转义耦合**：#67 的 forbid 用字面 `\\n`（`lib/patches/new-tools.mjs:1451`）来识别 1.6.73 写坏的产物，属于「用错误特征当指纹」，只要宿主自己出现同形文本就会误判。
12. **需要重启才生效**：引擎写的是磁盘源码，当前进程不热加载（`lib/index.js:1208-1256` 的 apply 只安排重启），且桌面密封包还有「归档还在就不算生效」的额外门槛（`lib/core.js:2267-2271`）。

## 对 Purge+ 的启示

**值得原样继承（结构本身就是资产）**

1. **声明式补丁表 + 稳定数字 id + 显示分组**：`{id,file,replacements,markers}` 这套 schema 让 86 条规则可审计、可开关、可分组展示；`PATCH_DISPLAY_GROUPS` 把升级链合成一行的做法直接沿用。
2. **逐文件状态明细 `patch_files`**：把「补丁 → 多目标文件 → 每文件状态」摊开，是这套产品最实用的诊断资产。
3. **`expect` 命中数契约**：这是唯一能阻止「宿主复制了一段代码导致改错两处」的机制，应扩展成全表默认（每条锚点声明期望命中数），而不是只给 #93 用。
4. **原子写 + 权限保留 + rename 退避**：`lib/atomic-files.js` 可直接搬，Windows `EPERM/EBUSY` 退避是被现场验证过的必要细节。
5. **备份失败即拒写**：把「没有可回滚基线就不动手」写成硬约束，比例子里的任何重试都值钱。
6. **本地重锚（anchor-overrides）**：不改插件源码、只改本地 pattern，配合 dry-run 唯一性校验，是宿主升级期的低成本止血手段。
7. **解包/换包的旁路提交模型**：解到 `.dshpurge-next` → 校验含 `@deepseek-ai` → rename 换入 → 失败保留 prev + `recover.json`，比「原地解包」安全一个量级。

**需要重构**

1. **锚点表达方式**：把「整段方法体逐字复制」换成「结构化定位」——用函数签名/字段名做多层选择器（可选正则 + 局部窗口 + 前后文断言），并在表里记录**适配的宿主版本区间**，让新宿主命中时能自动选择分支，而不是靠多条并列锚点赌运气。
2. **单一口径状态机**：合并 `rollupPatchStatus` 与 `readPatchReport`，`applied|partial|drifted|missing|unreadable|disabled|skipped|unmatched` 只有一套语义；`partial` 必须在 apply 汇总里也有位置。
3. **真正的事务**：apply 应产出一次「补丁批次」清单（文件 → 旧 blob → 新 blob 的哈希），失败时按清单回滚，而不是依赖宿主目录里散落的 `.dshpurge.bak`；备份基线带宿主版本指纹，禁止用旧 bak 覆盖新宿主。
4. **写后校验内建**：每次写入后立即复读校验 marker/结构（现在只有少数补丁有 `patchApplied` 专用检查），失败即本条回滚并标记，不等用户下次点应用。
5. **多宿主隔离**：每个宿主独立事务、独立失败，不再「首宿主备份失败即整轮中止」。
6. **清理死元数据**：`rel/multiHit/optIn` 与 7 个无补丁使用的目标键，或者补上使用点，或者删掉——留着会让后续维护者误以为有语义。

**建议替换**

1. `renameAsarAside` 的「归档让位」可以保留，但需要一份显式的「安装态清单」（当前是解包态/密封态 + 指纹），替代现在分散的 `unpacked-asar.json` + `hostCleanMarkersPresent` 探测。
2. `host_version` 从 `dsh-agent-loop/package.json` 读（`lib/core.js:3513-3519`）改为统一实例身份服务（DSH 版本、包布局、surface 三者一起给出），并让补丁选择真正依赖它。
3. 大型内联 prompt 常量（`STRONG_INTRO` 等写进宿主源码）应与「运行时注入层」解耦：宿主补丁只做闸门类改动，措辞类内容交给 `prompt-inject` 层，减少补丁数量与漂移面。
