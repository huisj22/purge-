# 07 · 诊断 / 自检 / 审计 / 恢复（dsh-purge-community 1.6.91）

> 分析对象：`pkg/plugin-copy/dsh-purge-community`（原项目，只读）。切片文件：`lib/selfcheck.js`、`anchors.js`、`audit.js`、`atomic-files.js`、`rollback-transaction.js`、`maintenance-lock.js`、`reapply.js`、`reapply-cli.js`、`restore-backup.js`、`remove-tree.js`、`zip-extract.js`、`extract-asar.js`。所有断言均带 `文件:行号`。

## 职责

这一层**不产生破甲能力**，只回答三个问题：①“补丁到底在不在”（自检/证据）；②“为什么不在、该改哪一行”（漂移诊断 + 重锚）；③“出事了怎么退回去”（快照/回滚/维护锁/原子写）。

- 自检：`selfCheck()` 把 86 条补丁折叠成 25 层，逐层给 `state`，`broken→退出码 1`（`lib/selfcheck.js:198-300`、`bin/community.js:195-235`）。
- 漂移诊断：`patchDrift()` 输出文件/行号/旧锚点首行/候选落点（`lib/core.js:3624-3687`）。
- 重锚：`reanchor` 把新锚点钉进 `$DSH_HOME/dsh-purge/anchor-overrides.json`，不改插件源码（`lib/anchors.js:1-84`、`bin/community.js:37-116`）。
- 审计：`apply/revert/reanchor/tuning/refusal_retry` 落 `audit.jsonl`（`lib/audit.js:97-122`）。
- 恢复基础件：原子写 + 权限保持、junction 安全删除、CAS 快照、维护互斥锁、旧包重打。

## 关键实现

### (a) selfCheck 的层清单与状态机

层清单是**硬编码常量**，不是数据文件：`BYPASS_LAYERS` 共 22 条（`lib/selfcheck.js:17-62`），每条 `{ids,title,kind,why,optionalIds?}`；`kind` 三值 `host|runtime|config`（`:15-16`）。运行期再追加 3 层：运行时注入（`:221-234`）、profile 权限（`:235-249`）、磁盘布局（`:250` → `hostLayoutLayer` `:184-196`），外加条件层“其他必需目标文件”（`:214-220`）。常规输出 **25 层**，与 `AGENTS.md:§3` 一致。

1. `沙箱 confine 直通` — ids `[15]`，host，`selfcheck.js:18-19`
2. `文件系统围栏禁用` — ids `[16]`，host，`:20-21`
3. `观察策略放行` — ids `[17]`，host，`:22-23`
4. `拒绝话术中性化` — ids `[6,33,48]`，host，`:24-25`
5. `默认策略` — ids `[7,8,10]`，host，`:26-27`
6. `审批自动放行` — ids `[9,35]`，host，`:28-29`
7. `Auto Review 不拦工具` — ids `[59]`，host，`:30-31`
8. `工具审批 fail-open` — ids `[60,62,61]`，host，`:32-33`
9. `计划模式不硬拦` — ids `[63]`，host，`:34-35`
10. `官方身份剥离` — ids `[4,25,43,71,76]`，`optionalIds [71,76]`，`:36-37`
11. `Web 面身份中性化` — ids `[32,53]`，`:38-39`
12. `注入不被预设覆盖` — ids `[40,74,55,72]`，`:40-41`
13. `极简/梁神预设保留注入` — ids `[26,28]`，`optionalIds [28]`，`:42-43`
14. `外部内容不降级为只读` — ids `[29,50]`，`:44-45`
15. `Hooks 不否决回合` — ids `[30,31,64,65]`，四个全是 optional，`:46-47`
16. `工具上限放宽` — ids `[21,22,23]`，`:48-49`
17. `预设与子代理不设锁` — ids `[24,37]`，`:50-51`
18. `新会话与日志默认` — ids `[51,52]`，`:52-53`
19. `回退不残留` — ids `[56,58,75,77]`，`:54-55`
20. `模型网关兼容` — ids `[47,49,57,69]`，`:56-57`
21. `会话消息投递与挂载` — ids `[87,88,90]`，`:58-59`
22. `桌面宿主启动兜底` — ids `[82,83,84]`，三个全是 optional，`:60-61`
23. `运行时提示词注入` — 动态，证据 = `$DSH_HOME/prompt-inject.md` 字节数 > 0（`:84-101,221-234`）
24. `当前 profile 的权限选择` — 动态，证据 = `permission-state.js:39-72`（优先 runtime `permissionPresets`，退化到 profile YAML 字面量）
25. `宿主磁盘布局` — 动态，证据 = 目标 Resources 下 `app.asar` 是否仍是普通文件（`:184-196`）
26. （条件层）`其他必需目标文件` — 只收“未分组且 `status==="missing_file"`”的补丁（`:214-220`）

各层 `rows` 的 `optional` 取补丁元数据优先、`optionalIds` 兜底（`:135`）；`required = rows - notApplicable`（`:139`）；`applied/required/total/pending/absent/broken` 六个计数字段（`:150-160`）是面板与 CLI 渲染的唯一输入（`bin/community.js:212-218`）。

补丁总数实测 86（`lib/patches/index.mjs:9` 拼装；`node -e` 导入 `ALL_PATCHES.length === 86`）。其中 30 条未被任何层分组（1,2,3,5,11,12,13,14,91-94,80,34,36,38,39,42,45,46,54,66,67,68,78,89,18,19）。

**状态值域**：层级 `ok | pending | broken | unknown | inferred | na`（`selfcheck.js:147,187-195,242,270`）；补丁级 `applied|already|pending|drifted|unmatched|partial|skipped|missing_file|na|off|disabled|unknown|not_needed`（`core.js:3795-3808`、`preset-diagnostic.js:30`、`core.js:3703-3707`）。

**聚合状态机**（纯函数，可单测）：

```
rollupLayers:  broken = required 中 status ∉ {applied,already,pending,unlocated,unknown}   (selfcheck.js:144)
               unknown = statusError || 任一行 unlocated/unknown                            (:146)
               state   = broken ? broken : unknown ? unknown : pending ? pending : ok       (:147)
selfCheck:     state   = broken 层 ? broken : pending 层 ? pending
                       : 有 unknown 层 ? unknown : 有 inferred 层 ? inferred : ok            (:270)
               ok      = 不存在 !layer.ok 的层                                              (:265,269)
               needsApply = 无 broken 且 有 pending                                          (:271)
```

**退出码**：`report.state === "broken" ? 1 : 0`（`bin/community.js:201`，`--text` 路径 `:230-233`）；异常统一 `process.exitCode = 1`（`:271-274`）。注意 `unknown/inferred/pending` 都是 **0**，调用方必须读 `state`（同 `AGENTS.md:§16`）。

### (b)“没有证据 = unknown，绝不绿”的代码路径

1. 状态读失败不折叠成通过：`statusFailed = Boolean(options.statusError)`（`selfcheck.js:128`），任何行 `unlocated/unknown` 都让整层 `unknown`（`:146`），note 明确“这一层没有被核对”（`:161-165`）。
2. 取不到状态时补丁默认不是 “applied”：`status: status[id] || (hasHost ? "unknown" : "unlocated")`（`:136`）。
3. 只有**显式**不适用才从分母剔除：`notApplicable()` 只接受 `na/off/disabled`、`not_needed` 且 id=76、`missing_file` 且 optional、`skipped` 且 `settleWhenAbsent`（`:104-109`）；注释写明“必需文件缺失不能伪装成成功”（`:138`）。
4. 必需文件缺失保留分母并单独成层：`:214-220` 且 `note` 要求核路径。
5. 权限层三态：`state = !known ? "unknown" : !full(observed) ? "broken" : pinned ? "ok" : "inferred"`（`permission-state.js:57-58`），“未显式设置不等于未生效”（`:66`）。
6. 布局层：`surface === "unknown"` → `state:"unknown"` 且 `ok:false`（`selfcheck.js:188`）；`app.asar` 仍在 → `broken`（`:195`）。
7. 预设 #76 的 `skipped` 不解释为通过：只读 YAML 静态检查，动态/损坏/不可读一律 `unknown`（`preset-diagnostic.js:8-34,37-47`）。

**反例（同仓内违反该原则）**：`hostPatchesStillPending()` 捕获异常后 `return false`，语义变成“没有 pending”（`reapply.js:152-161`），直接让 `patchesMatchInstallStrict()` 通过（`:164-168`）；`hostStillHasAppliedPatches()` 在 `aiBase` 缺失时 `return true`（`:127-129`）。settle 路径因此可能把“未知”当“已对齐”。

### (c) patchDrift 诊断与 reanchor 闭环

输出结构：`{host, desktop_entry, checked, drifted[], optionalDrift[], chained[], missing[]}`（`core.js:3686`）。每条漂移行 `{id,name,layer,optional,status,anchors[{file,index,overridden,reason,head,suggestion}]}`（`:3664-3675`）：

- `head` = 旧锚点首个非空行，去 tab、截 200 字符；正则则序列化为源串（`anchorHead` `core.js:3566-3572`）。
- `suggestion` = `locateAnchor()`：从锚点抽 6+ 字符标识符、去掉 27 个停用词、按长度取前 8 个 token，逐行计命中数，取最高分行，输出 `{tokens,matched,tokenCount,line,snippet(<600B)}`（`signatureTokens` `:3586-3592`、`locateAnchor` `:3599-3621`）。**这是启发式，不是语义匹配。**
- 分桶原因：`anchor_not_found`（`:3668`）、`read_error`（`:3654`）、`partial_drift`（`:3681`）、`target_file_missing`（`:3677`）；`chainedAfter` 前置未打时进 `chained` 不算漂移（`:3640-3643`）；`settleWhenAbsent && skipped` 直接跳过（`:3638`）。
- `desktop_entry` 复用与自检相同的解析器（`:3686` → `:2433-2444`）。

闭环 `reanchor`（`bin/community.js:37-116`）：`list` 汇总漂移与当前覆盖（`:43-53`）→ `apply <id>` 取 `--index` 锚点 → 读文件、按 `--lines a-b` 或 suggestion 行 ±span 切片（`:74-88`）→ **唯一性断言** `occurrences !== 1` 即拒（`:90-91`）→ dry-run 预演 `applyReplacementsToText` 是否 `changed`（`:99-104`）→ `--yes` 才 `writeOverride` 并 `logAudit("reanchor",…)`（`:108-109`）→ `core.refreshAnchorOverrides()` 清缓存（`:111`，实现 `core/shared.mjs:226-228`）→ 立即回读 `patchStatus(host)[id]` 验证（`:112`）。覆盖只替换 `pattern`、不动 `replace`，并带 `overridden:true` 标记（`anchors.js:67-83`）；引擎侧在 `patchReplacements()` 里叠加（`core/shared.mjs:230-234`），`patchDrift` 会把 `overridden` 透出（`core.js:3667`）。`clear <id> [--index]` 删除覆盖即恢复出厂锚点（`anchors.js:54-64`）。覆盖文件 0600、目录 0700（`anchors.js:49-50`）。

### (d) 审计日志

- 位置：`$DSH_HOME/dsh-purge-community/audit.jsonl`（`audit.js:20-22`）；轮转阈值 1 MiB、保留 2 份（`:10-12`），`rotate()` 把 `file→.1`、`.1→.2`（`:43-52`）。
- 行格式：`{at:ISO8601, event, pid, ...data}` 单行 JSON 追加（`:105-106`）。
- 加固：拒绝符号链接（`:26-27`）、`O_NOFOLLOW|O_NONBLOCK`（`:28`）、必须是普通文件且 `nlink===1`（`:31`）、root 场景支持 `PURGE_AUDIT_UID/GID` 校验（`:60-72`）、Linux 用 `/proc/self/fd/<fd>` 钉住目录防路径替换（`:92`）、Windows 走退化分支（`:81`）。写失败只 warn 一次并返回 `false`，绝不打断主流程（`:110-121`）。
- 读取：跳半行、最多 500 条、倒序（`:124-144`）；CLI `audit --limit n`（`bin/community.js:34-36`），HTTP `GET /dsh-purge/audit`（`lib/index.js:2107-2119`）。
- **实际被记录的事件**：`apply{host,host_version,applied,already,failed,failed_ids,snapshot}`（`core.js:3511-3525`）、`revert{host,reverted,skipped,errors}`（`:2738-2743`）、`refusal_retry{chars,head,match}`（`refusal-retry.js:102`）、`refusal_retry_outcome`（`:107`）、`tuning_setting{key,from,to}`（`tuning.js:56-64`，只允许已知字段与布尔/枚举值）、`reanchor`（`bin/community.js:109`）、`patches_setting`（`:131`）。
- **没有记录**：boost 开关（`lib/index.js:2075-2076` 直接 `writeBoost`，无 `logAudit`）、probe 生成（`:2097`）、preset 安装、update-channel/token 写入、逐次工具调用放行——后者是设计边界，`audit.js:3-5` 明说“宿主补丁写进源码，运行时看不到某次调用被哪条补丁放行”。
- 敏感度：审计**没有集中式脱敏器**，靠调用点自觉；`refusal_retry.head` 实际会写入模型输出前 80 字符（`refusal-retry.js:102`），这是唯一可能带用户内容的字段。

| event | 写入点 | 字段 | 触发时机 |
|---|---|---|---|
| `apply` | `core.js:3511-3525` | host, host_version, applied, already, failed, failed_ids, snapshot | 写宿主补丁结束（成功与失败同一个形状） |
| `revert` | `core.js:2738-2743` | host, reverted, skipped, errors | 还原结束 |
| `reanchor` | `bin/community.js:109` | patch, index, host | `--yes` 写入覆盖后 |
| `patches_setting` | `bin/community.js:131` | action, ids, effective | enable/disable 可选补丁 |
| `tuning_setting` | `tuning.js:56-64` | key, from, to（按 key 白名单序列化） | 已知设置真的变化（重复保存不写） |
| `refusal_retry` | `refusal-retry.js:102` | chars, head(≤80), match(命中规则下标) | 命中拒绝特征、重试前 |
| `refusal_retry_outcome` | `refusal-retry.js:107` | 传输形态（text/tool_call/error…） | 重试流结束 |

### (e) 原子写 + 权限保持（#20）与 removeTreeNoFollow（#67）

`atomic-files.js`：`modeOf()` 先读旧文件 `mode & 0o777`（`:9-15`）；临时名 `file.pid.uuid.tmp`（`:16`），`wx` 独占写入（`:43`）；**关键**：`writeFile` 的 mode 会被 umask 削，因此发布前 `chmodSync(tmp, mode)` 显式恢复（`:44-46`，异步版 `:57-58`）；`renameSyncRetry` 对 `EPERM/EACCES/EBUSY` 退避 5 次（`:19-38`）；失败必须删临时文件再抛（`:48-51`）。`atomicCopyFileSync` 用 `COPYFILE_EXCL` 再 chmod 再 rename（`:65-76`）。`restore-backup.js` 是它的上层：备份必须是**非空普通文件**，长度一致，目标若是符号链接就拒（`:4-13`），否则原文件不动、错误里带备份路径（`:6,8,10`）。

`remove-tree.js`：**先 lstat 再判断**，永不 stat/realpath 删除目标（`:21-23`）；符号链接直接 `unlink` 不递归（`:23`）；目录用 `readdir + rmdir` 非递归，**没有原生 recursive rm 兜底**（`:26`）；拒绝文件系统根（`:11`）；`ENOENT` 幂等（`:18,28,32`）；可重试集合 `EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM`（`:14`），但默认 `maxRetries=0`（`:12`）→ 调用方必须显式传。注释强调函数自包含，因为 bootstrap/卸载助手会**内嵌这份函数体**（`:6-7`）。Windows junction 语义下 `lstat` 报 `isSymbolicLink()`，因此 junction 被 unlink 而不进入内部——这就是 #67 的根因修复。

`extract-asar.js` 的 `diskFs()` 同理关键：Electron 的 `fs` 会把 `resources/app` 映射进归档，写会 ENOENT，必须用 `original-fs`（`:9-32`）；写类方法自动让 asar 探针缓存失效（`:147-159`），探针 TTL 5s（`:51-52`）。

### (f) 快照格式与还原（manifest + objects/ 去重）

- `DEDUPE_MIN = 32 KiB`（`community.js:237`）：`≥` 阈值只存一份到 `base/objects/<sha256>`（`:260-271`，tmp+rename 原子落地 `:266-268`），`blobs[key] = sum`（`:270`）；小文件照旧复制 0600（`:273-275`）。目录拒绝符号链接（`:243`），排除 `node_modules/.git`（`:247`）。
- 快照目录 `$DSH_HOME/dsh-purge-community/backups/<id>/`，`id = ISO 时间戳(去:.) + 8hex`（`:497-500`）。内容：`plugins/<包名>`（`:513-515`，校验包名一致 `:512`）+ `settings/{profile-package,profile-config,profile-lock,prompt,purge-state,rules}`（`:517-527`）+ `manifest.json`。
- `manifest` schema 2 字段：`{schema,id,created_at,reason,host_version,profile,home,plugins[{name,version,folder}],sums(全文件 sha256),blobs(rel→sha),bundles,complete:true}`（`:529-544`），原子写（`:546`）；失败写 `failed.json` 再抛（`:552-558`）。`list()` 只认 `complete`（`:371-394`）。
- 校验 `verify(id)`：realpath 必须等于自身（`:563`）、`complete/schema∈{1,2}/id/home/profile` 全等（`:566-573`）、`treeHashes` 逐文件比 `sums`（`:574-583`，先把 `manifest.json` 从实际集合里删掉）、每个 blob 存在且哈希相符（`:584-588`）、插件路径必须是 `plugins/<name>`（`:589-595`）。
- 还原 `materializeTree()`：先递归复制小文件，再按 `blobs` 前缀写出去重对象（`:279-290`）。
- 回滚 `rollback(id)`：先 `verify` → `preflight` → **再拍一张 `before-rollback` 快照**（`:612-615`）→ 读迁移记录决定是否反向迁移包引用（`:616-625`）→ 把快照重打成 `.tgz` 交给 DSH CLI 安装（`:634-653`，`packRestoredPackage` `rollback-transaction.js:11-17`）→ `verifyInstalledPackage` 用**新进程** import 包入口并解析全部依赖（`rollback-transaction.js:19-34`）→ 原子写 `package.json` bundles（`:654-665`）→ 配置并发检查后写回（`:666-670`）→ `finishCleanup` 不致命（`:671-681`）→ 失败走 `checkpointProfile().restore()`（`:683-688`）。
- 保留策略 `prune()`：最近 5 份必留、其余每天 1 份最多 7 天、再按总大小 200 MiB 淘汰最旧（`:444-494`），删除走 `removeTreeNoFollowSync`（`:471,486`），最后 `gcObjects()` 回收无引用 blob（`:414-438`）。

```
$DSH_HOME/
├─ prompt-inject.md                         ← 被快照为 settings/prompt（只取证，回滚不还原）
├─ dsh-purge/{applied.json,installed-rev,tuning.json,anchor-overrides.json,settle-restart.guard}
└─ dsh-purge-community/
   ├─ audit.jsonl[.1][.2]
   ├─ maintenance.guard/<32hex>.json        ← 当前锁；maintenance.lock 硬链接指向同一 inode
   ├─ objects/<sha256>                      ← ≥32KiB 文件唯一副本
   ├─ backups/<id>/                         ← id = 2026-11-19T11-04-04-123Z-<8hex>
   │  ├─ manifest.json                      ← schema2 / sums / blobs / plugins / complete
   │  ├─ plugins/<pkg>/…                    ← <32KiB 原件
   │  └─ settings/{profile-package,profile-config,profile-lock,prompt,purge-state,rules}
   ├─ restored/<id>-<12hex>/…               ← 回滚时 materialize 出的不可变副本 + .tgz
   ├─ pkgs/<sha256>/<原文件名>.tgz          ← install 把 file: 路径固化成持久副本
   └─ migrations/<备份id>.json              ← 反向迁移记录（schema1 + changes[]）
```

- 回滚不在原 profile 上做 swap 式还原：先 `verify`，再 `materializeTree` 到 `restored/`，再打成 `.tgz` **交给 DSH CLI 安装**，最后 `verifyInstalledPackage` 用独立进程校验（`community.js:626-653`；`rollback-transaction.js:19-34`）。注释明确“never restore a whole profile/config file”（`:626`）。

### (g) reapply：重打什么、何时重打

`reapplyInstalled()`（`reapply.js:290-391`）序列：`gatherState()` 定位宿主（`:296-300`）→ 密封则 `openSealedDesktopHost({forApply:true})` 解包（`:301-313`）→ **先 `refreshStaleBaksForUpgrade()`**（DSH 自升级把源码换新但老 `.dshpurge.bak` 不变，直接 revert 会把新版写回旧版导致混码，`:318-332`）→ `revertAll()`（`:333`）→ `revertAllShims()`（`:334`）→ `applyPatchesAllHosts(ALL_PATCHES)`（`:335`）→ `patchAllShims()`（`:336`）→ `silenceCmdFlash()`（`:337`）→ 判定 `clean = 无 failed && (全部宿主已写 || 清洗 marker 在)`（`:339-341`）→ clean 则 `markPatchesApplied()` + 归档戳 + `seedPromptInjectAtBoot()`（`:360-371`）→ 需要换包时 `scheduleSealedDesktopRestart()`（`:372-376`）。失败且是本次新解包则 `restoreSealedExtract()` 放回上一份目录（`:345-359`）。

触发条件（`lib/index.js:962-1068`）：`config.autoApplyOnStart === true` 才允许写宿主（`:976-986`）；`settleMayReapply()` 在 desktop+sealed 时禁止（`settle-policy.js:40-43`）；`patchesMatchInstallStrict()` 已对齐就不重打（`reapply.js:164-168`）；`hostCleanEnoughToKeep()` 灰区直接补戳（`:174-186`）；官方升级标记存在时带 `upgrade:true` 重打并清标记（`index.js:999-1024`）；重启前查 `shouldSkipSettleRestart()`（180s 冷却，`reapply.js:266-275`）与 `settleMayRestart()`（`settle-policy.js:33-37`），打冷却戳 `markSettleRestart()`（`reapply.js:277-284`）。
`reapply-cli.js` 只是把它做成退出码（`:1-5`）。

## 数据流与状态

```
patch 定义(86) ──anchors.applyOverrides──> patchReplacements()  ← anchor-overrides.json
        │                                        │
        ├─ applyPatchesAllHosts ─> backupAll(.dshpurge.bak, wx 独占) ─> 写宿主 ─> logAudit("apply")
        │                                        └─ markPatchesApplied ─> applied.json{version,sha,at} + installed-rev
        ├─ patchStatusDetail ──> rollupLayers ──> selfCheck.state ──> CLI 退出码 / HTTP /dsh-purge/selfcheck
        └─ patchDrift ──> reanchor apply ──> anchor-overrides.json ──> refreshAnchorOverrides()
```

状态文件（全部在 `$DSH_HOME/dsh-purge*`）：`applied.json`、`installed-rev`、`settle-restart.guard`（`reapply.js:17-35`）、`tuning.json`（`tuning.js:9`）、`anchor-overrides.json`（`anchors.js:19-25`）、`dsh-purge-community/audit.jsonl`、`dsh-purge-community/{backups,objects,restored,pkgs,migrations}`（`community.js:339-341,627-632,698-701`）、维护锁 `maintenance.guard/` + 兼容 `maintenance.lock`（`maintenance-lock.js:56-57`）。
唯一缓存：asar 探针 5s（`extract-asar.js:51-60`）+ 覆盖文件快照（`core/shared.mjs:213-228`）；自检本身**每次现读**，无结果缓存。

## 真实能力清单

| 能力 | 入口 | 实现位置 | 真实现 | 证据 |
|---|---|---|---|---|
| 25 层自检 + 分层 note/hints | CLI `selfcheck`、HTTP `/dsh-purge/selfcheck` | `selfcheck.js:198-300`；`index.js:2045-2058` | 是 | 层清单 `:17-62`，`hints` `:284-299` |
| 聚合状态机 + 退出码 | 同上 | `selfcheck.js:126-171,258-277`；`bin/community.js:201` | 是 | broken→1，其余 0 |
| 补丁 tally（含 na/disabled/partial） | `selfcheck.patch` | `selfcheck.js:104-124` | 是 | `notApplicable` 白名单 |
| 漂移诊断（文件/行/旧首行/候选） | CLI `diagnose` | `core.js:3624-3687`、`3566-3621`；`bin/community.js:239-245` | 是 | `locateAnchor` 启发式 |
| 半自动重锚 + dry-run + 唯一性 | CLI `reanchor *` | `bin/community.js:37-116`；`anchors.js:38-83` | 是 | 唯一断言 `:90-91` |
| 审计写/读/轮转（1MiB×2） | `logAudit` / `audit` / HTTP | `audit.js:97-144` | 是 | 事件白名单见上 |
| 原子写 + 权限保持 | 所有写状态文件 | `atomic-files.js:39-88` | 是 | chmod 补偿 umask `:44-46` |
| 备份还原完整性校验 | `restoreBackupFile(Sync)` | `restore-backup.js:4-20` | 是 | 空/非普通/符号链接全拒 |
| junction 安全删除 | `removeTreeNoFollow(Sync)` | `remove-tree.js:8-66` | 是 | lstat 优先 `:21-23` |
| 快照（CAS 去重）+ 校验 + 回滚 | `backup/rollback/prune/usage` | `community.js:444-690`；`rollback-transaction.js:19-34` | 是 | manifest schema 2 `:529-544` |
| 维护互斥锁（含遗留 lock 兼容） | `Maintenance.locked` | `maintenance-lock.js:51-167`；`community.js:345-370` | 是 | 非空目录原子发布 `:108-112` |
| 旧包重打（先还原再打） | `reapplyInstalled` / settle | `reapply.js:290-391`；`index.js:962-1068` | 是 | 但受 `autoApplyOnStart` 门槛 |
| 版本戳/heal/冷却 | settle | `reapply.js:104-284` | 是 | 空 sha 不视为对齐 `:106-107` |
| ASAR 解包（越界/链接校验） | `extractAsar` | `extract-asar.js:253-274,456-504` | 是 | 先全量校验再写 `:466-480` |
| ZIP 解压（内置无 zip64） | `extractZipArchive` | `zip-extract.js:76-168` | 是 | 路径/重复/上限校验 `:84,87-89,99-102` |
| 逐层“未知”可见但**不计失败** | 状态机 | `selfcheck.js:146-147` | 是 | `unknown` 仍然 `ok:false` 但 state≠broken |

## 依赖与耦合

- `selfcheck.js` 依赖 5 个模块：`permission-state.js`（**硬依赖 `yaml`** `:1`）、`preset-diagnostic.js`（`yaml` `:3`）、`core.js`、`community.js`（只要 `compatibility` `:10`）、`instance.js`（`resolveProfile/diagnosticHost/hostSurface/desktopResourcesForHost` `:11`）、`extract-asar.js`（`diskFs` `:7`）。
- `anchors.js` **刻意不 import core**，自己重写 `dshHome()` 以避开循环依赖（`anchors.js:11-17`）；反向由 `core/shared.mjs` 导入 anchors。
- `community.js` → `maintenance-lock` + `remove-tree` + `rollback-transaction`；`rollback-transaction` → `remove-tree` + **外部 `tar.exe`**（`rollback-transaction.js:9`，Windows 取 `System32\tar.exe`）。
- `maintenance-lock` → **`powershell.exe` 取进程启动时间**（Windows，`maintenance-lock.js:21-22`）或 `/bin/ps -o lstart=`（`:24`）。
- `audit.js`/`remove-tree.js`/`atomic-files.js` 是叶子模块，可整块移植（`remove-tree` 甚至被字符串内嵌到引导脚本）。
- 与宿主耦合点：`patchStatus` 走 `withDesktopReadScope`（`core.js:3709-3716`）、`hostFs` 依 `app.asar` 影子自动选 fs（`extract-asar.js:137-183`）。

## 局限与缺陷

1. **30 条补丁的漂移不进状态机**：条件层只筛 `missing_file`（`selfcheck.js:215`），未分组补丁若 `drifted/unmatched/pattern_not_found`，`selfCheck.state` 仍可能是 `ok`，只在 `patch.applied/total` 数字上露头。这是“无证据=unknown”原则的**结构性漏洞**。
2. **reapply 反向 fail-open**：`hostPatchesStillPending()` 异常返回 `false`（`reapply.js:152-161`）、`hostStillHasAppliedPatches()` 找不到宿主返回 `true`（`:127-129`）——为防无限重启而牺牲了证据语义，与自检口径不一致。
3. **`selfcheck` 在无 `node_modules` 环境直接崩**：`permission-state.js:1` 顶层 `import { parseDocument } from "yaml"`。我实测 `node --input-type=module -e "import('./lib/selfcheck.js')"` → `ERR_MODULE_NOT_FOUND: Cannot find package 'yaml'`；`bin/community.js:197` 虽是懒加载，但一旦进入该分支即失败。与 `AGENTS.md:§17`“自检等运行时依赖应懒加载”的声明冲突。
4. **审计覆盖面与文档不一致**：`AGENTS.md:§3` 称记录 `apply/revert/boost/probe/preset/reanchor`，代码里 boost（`index.js:2075`）与 probe（`:2097`）完全没有 `logAudit`；`update-channel.json` 的 token 写入也无审计（好的一面：token 不会进日志）。
5. **审计无集中脱敏**：`refusal_retry` 落 `head: text.slice(0,80)`（`refusal-retry.js:102`），模型输出片段会进日志；`data` 原样入库（`audit.js:105`），靠调用点自律。
6. **轮转非原子**：`rotate()` 顺序 rename（`audit.js:47-51`），两个进程同时 append 时 `.1/.2` 可能互相覆盖或出现半行（`readAudit` 只能跳过坏行 `:136-140`）。
7. **快照含用户正文却不用**：`prompt/purge-state/rules` 进 `settings/*`（`community.js:517-527`），但 `rollback()` 只恢复 plugins + bundles + 配置迁移，从不 `materializeTree(settings)`（搜遍 `:610-690` 无 settings 分支）——快照里存了用户的 `prompt-inject.md` 原文，既不用于恢复，又扩大了备份体积/隐私面。
8. **`verify()` 的错误面**：`fs.realpathSync(folder) !== folder`（`:563`）在目录不存在时抛原始 `ENOENT`，不是“备份不存在”的语义错误；`treeHashes` 先算全部再 `delete actual["manifest.json"]`（`:574-575`），依赖文件名硬编码。
9. **`prune` 的“每天 1 份”按 ISO 字符串前 10 字符**（`:453-459`），跨时区/本地日界会偏；保护集合只认 `keepLast` 与显式 `protect`，`survivors[0]` 额外兜底（`:481`）。
10. **锁对 Windows 的依赖较重**：`ownerDead` 需 `powershell 5s 超时`取启动时间（`maintenance-lock.js:21-22`），取不到时 `NaN` → 一律视为“存活或归属未知”（`:42,130`），表现为 `MAINTENANCE_BUSY`；`createdAt+2000ms` 精度余量（`:42`）对秒级 `ps` 输出偏紧。
11. **`removeTreeNoFollow*` 默认零重试**（`remove-tree.js:12`），而 Windows AV 场景正是最需要重试的地方；调用点（`community.js:471,486`、`extract-asar.js:350,451`）多数没传 `maxRetries`。
12. **层 note 文案可能误报**：`rows.some(row => row.status === "not_needed")`（`selfcheck.js:166`）命中即写“#76 无需处理”，即使同层其他 id 已 broken（state 仍 broken，但 note 误导）。
13. **可选目标缺失静默通过**：`optional` 补丁 `missing_file` 被 `notApplicable` 排除（`:107`），于是“本来该有却被删掉”与“宿主确实没有”不可区分（如 30/31/64/65/82/83/84 整层缺席时层直接 `ok` + note“不适用”`:167`）。
14. **`zip-extract` 不支持 zip64/加密**（`:87-89`），且 PowerShell 分支靠环境变量传参（`:157-165`），失败只回第一行 stderr（`:117-122`），诊断粒度粗。
15. **`rollback-transaction.verifyInstalledPackage`** 以 `process.execPath` 起子进程（`:30-33`），在只有 Electron 可执行体的环境依赖 `ELECTRON_RUN_AS_NODE`（`:32`）；`tar.exe` 缺失时打包失败（`:9,14`）。
16. **本拷贝无测试**：`pkg/plugin-copy/dsh-purge-community` 下无 `test/` 目录（`Get-ChildItem test` 为空），上文所有契约在当前分发形态里**没有可执行回归**。

## 对 Purge+ 的启示

**值得继承（直接搬，接口照抄）**
1. “证据→状态”的显式值域与聚合公式（`selfcheck.js:144-147,270-271`）：`broken > unknown > pending > ok` 的优先级必须原样保留，且 `unknown` 永不折算为 `ok`。
2. 层清单 + `why` 字段：每一层回答“这层没了会发生什么”，这是可运维性的核心（`:17-62`）。
3. `patchDrift → reanchor` 闭环的三个护栏：候选片段**必须唯一**、默认 dry-run、写完立刻回读 `patchStatus` 验证（`bin/community.js:90-112`）。
4. 叶子件整块复用：`remove-tree.js`（含 lstat 优先、非递归 rmdir、根拒绝）、`atomic-files.js`（chmod 补偿 umask + busy 退避）、`restore-backup.js`（空/非普通/符号链接拒绝）、`anchors.js`。
5. 快照契约定型：`schema` 版本号 + `complete` 标记 + `sums` 全量哈希 + `blobs` 内容寻址 + `verify()` 四重一致性检查（`community.js:529-597`）。这是“可证明的备份”。

**必须重构**
1. **层清单外置为数据**（JSON/YAML），每层声明 `{id, title, why, selector(ids|predicate), evidence(fn)}`；同时把未分组的 30 条补丁归入 `misc` 层，彻底堵住“漂移不进状态机”。
2. **状态机纯函数化 + 三态化**：现 `rollupLayers` 已接近纯函数（可单测），但 `reapply` 侧的 `hostPatchesStillPending` 必须改成 `true|false|unknown` 并让 settle 对 `unknown` 走“不写盘、提示诊断”，而不是 fail-open。
3. **审计 schema 版本化 + 事件白名单 + 集中脱敏**：`{schema, at, event, pid, ...}`，事件名从常量表取，字段按白名单序列化（参考 `tuning.js:56-64` 的做法推广），把 `refusal_retry.head` 改成命中规则名 + 长度。
4. **快照与恢复对齐**：`settings/*` 要么在 manifest 里标 `restorable:false` 明确“仅取证”，要么真的支持 `materializeTree(settings)` 并在回滚中默认排除 `prompt`。
5. **锁改 OS 级文件锁**（`flock`/`LockFileEx`）替代“非空目录 + powershell 查启动时间”，把锁状态机缩到 3 个状态：`held/dead/unknown`。
6. **删除 `yaml` 硬依赖**：自检的权限层与 #76 预设层要能在零依赖下运行（自带最小标量解析，或把 yaml 作为可选 peer 并在缺失时明确 `unknown` 而不是崩溃）。
7. **测试化的契约**（建议直接写进 Purge+ 的 `test/`）：
   - `rollupLayers({}, true)` → 所有层 `unknown`；`rollupLayers({}, false)` → 所有层 `unlocated`；
   - `statusError` 存在 → 顶层 `state === "unknown"`、`summary.broken.layers === 0`、CLI 退出 0；
   - 任一层 `broken` → 退出 1；`pending` → `needsApply === true`；
   - `atomicWriteSync` 对 0600/0755 目标保持位不变；失败后临时文件不存在；
   - `removeTreeNoFollowSync` 对 junction/symlink 只删链接、目标内容字节不变；
   - `verify(id)` 对“删一个 blob / 改一个字节 / 换 profile”三种篡改都必须抛；
   - `reanchor apply` 对重复片段必须拒绝（`occurrences !== 1`）。

**应替换**
- `tar.exe`/`powershell.exe` 外部进程 → 纯 Node 实现（`zlib` + 自写 tar/zip 头），换取跨平台可测性。
- 现 `locateAnchor` 的 token 计分启发式 → 保留为 fallback，主路径改用 AST/结构签名（函数名 + 附近唯一常量），并把 `matched/tokenCount` 作为置信度暴露给调用方。
- 目录式“互斥锁” → 带 `pid+boottime+host` 的租约文件 + 原子 `rename` 单一 suffix，`.1/.2` 轮转由单写者进程负责。

**一句话**：这一层是全工程**最值得继承的资产**——它把“破甲是否成立”从信念变成了带行号的证据链；Purge+ 要做的是把它的**数据（层清单/事件/状态）外置**、把它的**fail-open 分支收口成三态**、把它的**外部进程依赖去掉**，其余契约原样保留。
