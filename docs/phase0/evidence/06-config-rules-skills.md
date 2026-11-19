# 06 · 配置 / 规则 / 技能 / 预设 / 回退 —— dsh-purge-community 1.6.91 原始实现切片

> 代码路径均相对项目根 `pkg/plugin-copy/dsh-purge-community/`。所有结论只来自实读文件，行号即证据。

## 职责

这一层解决四件事，全部是「用户面配置」而不是宿主补丁：

1. **规则集（rules）**：把用户的多套 AGENTS/CLAUDE 指令做成可切换的集合，同一时刻只有一个 active，激活时把内容写进 `$DSH_HOME/AGENTS.md` 或 `CLAUDE.md`（`lib/rules.js:50-64`、`266-284`）。
2. **技能库（skills）**：只负责把用户 Skill 落到 `$DSH_HOME/skills` 并做格式校验/备份，调用侧完全交给宿主原生 `skill` 工具（`lib/skills.js:25-43`，`lib/index.js:1447-1448`）。
3. **预设（presets）**：`unrestricted` / `redteam` 两套文件 + 一个 Cordis 插件把它注册进 `agentPresets`，并对旧宿主做 `toolFilter → agentPreset` 迁移（`lib/presets.js:32-56`、`lib/presets-plugin.js:30-91`、`lib/preset-compat.js:69-143`）。
4. **回退（rewind）**：在同一个会话内用 `surfaceOp: replace` 把上一轮「挖掉」，把被撤的那句放回输入框，不改会话、不 fork（`lib/rewind.js:516-569`），依赖 4 条宿主前端补丁（`lib/patches/new-tools.mjs:1660-2018`）。

同时提供命令注册冲突兜底、卸载语义、以及一批把「配置写入」做安全化的小件（原子写、备份、路径围栏）。

## 关键实现（带 file:line 证据）

### 1. 规则存储格式与 CRUD（a）

- 存储布局：`$DSH_HOME/rules/<id>.md`（正文）+ `<id>.json`（`{name,target}`）+ `state.json`（`{active}`）。`lib/rules.js:50-64`、`224-237`。
- ID 契约：`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`，名称截断 64 字符，正文上限 256KB。`lib/rules.js:17-19`、`86-93`、`163-165`。
- 目标文件白名单只有两个：`RULE_TARGETS = ["AGENTS.md","CLAUDE.md"]`，非法 target 直接抛错。`lib/rules.js:20`、`70-84`、`81-84`。
- `saveRule()` 是「正文 + meta 两文件事务」：先写 `.md`，再写 meta，写 meta 失败或保存的正是 active 规则时回滚正文/meta。`lib/rules.js:161-202`；active 时顺带 `activateRule()` 同步目标文件（`182-184`）。
- `activateRule()` 只在**首次**备份目标文件，且仅当现有内容不等于任何规则正文时才备份成 `<target>.dsh-purge-rule.bak`，避免把上一套规则的正文当"原件"。`lib/rules.js:21`、`271-280`。
- `resetToOriginal()` 先按 `.bak` 还原并删除 bak；没有 bak 时，只有目标文件内容与 active 规则正文逐字节相等才 unlink，否则记 `skipped`（人工改过的文件不动）。`lib/rules.js:299-338`。
- 列表与状态：`listRules()` 只认 `.md` 且 id 合法、按 id 排序；`rulesStatus()` 汇总 `active/active_target/agents_exists/agents_synced/rules_dir/cwd_candidates/workspace_policy`。`lib/rules.js:128-150`、`340-383`。

### 2. 规则如何到达模型（两条互不相干的通道）

- **通道 A（规则集本体）**：写进 `$DSH_HOME/AGENTS.md`/`CLAUDE.md`，由宿主 `@deepseek-ai/dsh-agent-instructions` 读取；预设里该行把 `maxBytes` 设为 65536（`presets/unrestricted/agent.cordis.yml:30-33`）。代码注释明确「规则集只改 agents 目标文件，不参与 system 注入链（#74）」（`lib/rules.js:239-242`）。
- **通道 B（Purge 注入正文）**：`resolveInjectText()` 三级优先：本进程框内提交 > `$DSH_HOME/prompt-inject.md` > 加密槽默认；磁盘内容等于默认 hash 时标 `source:"default"`。`lib/rules.js:243-257`、`lib/core.js:4245-4261`。
- 组装期落点：`rewriteLiveAssembly()` 取 `readInjectFallback()` → `refreshHungOperator()`（含 200ms mtime 缓存 + 磁盘同步 + `pinDshHome`）→ 生成 `dsh-purge` section；`installHungPromptGlobal()` 提供 4 级兜底（refresh/hung/disk/sealed），保证永不把空串交给宿主。`lib/index.js:186-221`、`223-260`、`483-511`、`561-626`。
- **cwd 本地规则**：扫 cwd→项目根（`.git/.hg/.svn` 为界，最大 32 层）的 `AGENTS.md`/`CLAUDE.md`/`AGENTS.local.md`/`CLAUDE.local.md`，候选带 `scope: cwd|ancestor|root`、160 字符预览。`lib/rules.js:25-29`、`396-458`。
- 勾选结果存 `dsh-purge/cwd-selections.json`（绝对路径去重），注入时**只接受仍在当前 cwd 扫描结果里的路径**，防跨目录穿越，并加 512KB 上限、块头 `<!-- dsh-purge:cwd-rule NAME -->`。`lib/rules.js:494-516`、`534-560`。
- 生效条件：只有主注入正文为空时才用勾选的 cwd 文件（`lib/index.js:579-584`）。
- 作用域策略 `fallback|strict|always`（`dsh-purge/workspace-policy.json`）决定是否丢弃宿主的 workspace baseline 段：`strict` 恒丢、`fallback` 有注入才丢、`always` 不丢。`lib/rules.js:27-28`、`460-477`；`lib/index.js:588-593`。
- 冲突语义：**同一时刻只有一个 active**（`state.json.active` 单值）、**每个规则只绑一个 target**；切换规则会覆盖目标文件，旧 target 不会自动清理（见缺陷 §6.2）。

### 3. 技能发现与 SKILL.md 解析（b）

- 双形态：`skills/<id>/SKILL.md`（bundle）优先，`skills/<id>.md`（flat）次之；`readSkill()` 还会兜底扫一遍所有子目录的 `SKILL.md`，按 frontmatter 的 `name` 匹配。`lib/skills.js:33-43`、`297-318`。
- 名称契约：kebab-case `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`，与官方 `@deepseek-ai/dsh-skill` 对齐。`lib/skills.js:12-23`。
- 解析器是自己写的**最小 YAML 子集**，不引 yaml 库：
  - `splitFrontmatter()` 去 BOM、要求 `---` 开头且紧跟换行、`\n---\n` 收尾（`lib/skills.js:105-117`）；
  - `yamlLineField()` 支持引号、行尾注释、以及块标量 `|`/`>`/`|-`/`|+`/`|2`（`179-197`、`130-177`）；
  - `yamlBoolField()` 接受 true/yes/on/1 与 false/no/off/0，非法值单独报错（`199-213`）。
- 校验规则：`name` 必须合法、`description` 必填；`disable-model-invocation` 与 `user-invocable` 必须是布尔，映射到 `modelInvocable`/`userInvocable`。`lib/skills.js:215-236`。
- 写回时会重排 frontmatter（`mergeSkillDocument` 保留官方 `whenToUse`/其它键，只改 name/description；无 frontmatter 时 `renderSkillDocument` 造一个），写前再 parse 一次做终检，正文上限 256KB。`lib/skills.js:238-261`、`411-447`。
- 列表：目录优先，`SKILL.md` 文件名本身被跳过，frontmatter 非法时退回目录名/文件名作 id，且按 id 去重。`lib/skills.js:320-352`。
- 对外展示脱敏：路径统一显示成 `$DSH_HOME/...`，不泄漏盘符。`lib/skills.js:45-62`；`skillsStatus()` 只回 id/description/kind/valid/error/size/path（`734-748`）。

### 4. 技能导入 / 校验 / 备份

- 归档导入：`.zip/.tgz/.tar.gz/.tar/.skill`，上限 12MB；用 `tar -tf` 列条目、`unzip -Z1` 或自带 `listZipFile` 兜底；条目含绝对路径/盘符/`..` 即拒；条目数上限 200；解压后总大小上限 50MB。`lib/skills.js:15-19`、`467-525`、`657-688`。
- 目录导入：`importFileTree()` 逐文件校验相对路径（拒 `..`、绝对路径、不安全条目），支持 base64，落临时目录后统一走 `installFoundSkills()`。`lib/skills.js:690-715`。
- 源围栏：`assertImportSourceOutsideSkills()` 拒绝从 `$DSH_HOME/skills` 自身导入；`pathsOverlap()` 本应用 realpath 判断软链重叠（实现有缺陷，见 §6.3）。`lib/skills.js:64-96`。
- 覆盖前必留备份：`$DSH_HOME/dsh-purge-backups/skills/<id>_<ISO时间>_<pid>-<rand>`，bundle 走递归复制（跳过 `.system/.git/node_modules/__MACOSX/._*` 与符号链接），flat 直接 copy；失败则 `restoreSkillFromBackup()` 回滚。`lib/skills.js:18`、`354-389`、`579-599`、`601-630`。
- 安装 bundle 时会修正 frontmatter 名称（`parsed.name !== id` 就 merge），完全没有 frontmatter 就补一个。`lib/skills.js:601-624`。
- 可用性检查不在 skills.js，而在红队子系统：`skillLibraryOf()` 用路径判定 `official|redteam`；`checkSkill()` 产出 `available|broken|unknown` 与 `file-missing/content-missing/env-missing/path-missing/placeholder/shadowed/file-stale` 问题项；`requiredEnvOf()` 从正文抽 `process.env.X`/`os.environ["X"]`（带默认值不算缺）/`${X:?}`；`pathCountsOnThisHost()` 按平台/架构剔除不可能存在的工具路径。`lib/redteam/skill-availability.js:55-108`、`149-159`、`252-350`。
- **外来技能适配方式**：只认 name/description/whenToUse/disable-model-invocation/user-invocable，其它键（例如随包红队技能里的 `role`/`enabled`）会被解析器忽略、并在 `mergeSkillDocument` 写回时被保留但不生效——即「适配 = 只做 frontmatter 归一化 + 落盘」，不注入任何宿主注册表。`lib/skills.js:215-236`、`255-261`；示例 `skills/redteam/web-fingerprint.md:1-7`。

### 5. 预设文件布局与注册（c）

- 布局：`presets/<name>/preset.yml`（`name/description/order`）+ `presets/<name>/agent.cordis.yml`（Cordis 组合行数组，`{id,name,config,disabled,group,isolate}`）。`presets/unrestricted/preset.yml:1-3`、`presets/redteam/preset.yml:1-3`、`presets/unrestricted/agent.cordis.yml:15-28`。
- `agent.cordis.yml` 的形态要点：persona 行 `@deepseek-ai/dsh-persona` + `prefix` 人设；工具行按 plane 注释区分；分组行 `cordis:group` + `group:true` + `isolate:{...}`；`disabled: !!js process.platform === 'win32'` 这种表达式保留为数据（`49-53`），`maxBytes:65536`（`30-33`），`skill-filesystem.config.includeDefaultRoots:true`（`94-102`），`tool-subagent` 用 `toolFilter.deny`（`199-216`），`tool-workflow/tool-ralph`（`264-271`），`tool-web.config.fetch:false`（`289-293`，注释说明由补丁 #24 打开，`285`）。
- 落盘：`installPreset({force:false})` 把两个文件 `COPYFILE_EXCL` 复制到 `$DSH_HOME/.agent-presets/<name>`（目录 0700）；已存在且未 force 返回 `kept`，绝不覆盖用户改过的版本。`lib/presets.js:32-43`。
- 首次落盘后立即套用补丁 #24 的替换，避免自检里 "#24 待应用" 误判成破甲失败。`lib/presets.js:44-54`。
- 注册：`presets-plugin.js` 作为独立 Cordis 插件（`package.json:17` 导出，`cordis.patch.yml:62-63` 插入），`registry()` 优先 `ctx.agentPresets`，退回 `ctx.get("agentPresets")`；没有就 500ms 重试最多 40 次。`lib/presets-plugin.js:17`、`35-57`。
- 若当前 profile 已用 `@deepseek-ai/dsh-agent-preset` 声明了同名预设，则**不重复注册**，交给宿主。`lib/preset-compat.js:259-268`；`lib/presets-plugin.js:59-62`。
- 注册流程：`readPresetDefinition(id,dir)` → `adaptListAgents()` → `migratePresetDefinition()` → `backupPresetMigration()` → `registerPresetDefinitions(withLegacyChildIds(...))`。`lib/presets-plugin.js:66-69`。
- 注册失败分类：`/already|duplicate|invalid/` 视为终态不再重试，否则 1s 重试。`lib/presets-plugin.js:73-79`。
- **只放文件不注册则下拉里看不到**（`AGENTS.md:127`），这是该层的核心不变量。
- 诊断：`inspectPresetText()` 只做静态数据检查（不执行 `!!js`、不解 alias），只有「唯一 persona 行 + 字面 prefix + 无模板变量」才敢给结论，其余一律 `unknown`；`refinePresetDiagnostic()` 只针对补丁 #76 的 `skipped` 做精化。`lib/preset-diagnostic.js:8-34`、`37-47`。
- 注入排除：`excludePresets` 按会话实际预设判定，子代理用自己的预设；未知预设 + 非空排除列表时**暂停注入**（保守）。`lib/preset-injection.js:5-20`、`66-75`；改写留痕用 `Symbol.for('dsh-purge.prompt-provenance.v1')`，只回滚自己写过的段。`lib/preset-injection.js:29-62`。

### 6. preset-compat：toolFilter → agentPreset + SHA256 私有备份

- 迁移只处理**能一一对应**的旧策略：必须 `provider === "spawn"`、没有 `agentPreset/allowedAgentPresets`、`toolFilter` 只有 `deny`、deny 全为不重复字符串且都能映射到本预设内的工具名（`subagent/workflow/ralph` 等）；任一不满足抛错并保留配置。`lib/preset-compat.js:69-104`。
- 产出：子预设克隆父预设，`id = <parent>-child-<sha256(identity) 前10位>`（`stableChildIds` 时按 id+deny 计算，保证跨次稳定），`name = "… · 子任务"`，`order = parent.order + 0.1`，从子预设里删掉被 deny 的行、删掉 `toolFilter`，然后把父行改成 `config.agentPreset = child.id`。`lib/preset-compat.js:105-143`。
- 多策略（>1 个独立 filtered spawn）直接拒绝，不做递归猜测。`lib/preset-compat.js:114-119`。
- 私有备份：`$DSH_HOME/dsh-purge-community/preset-migrations/<id>-<digest16>`，`digest = sha256(concat(name\0bytes))`；内容寻址——已存在则逐字节校验（含 manifest digest），不一致直接报错；新建走 `mkdtemp` staging + 0600 文件 + rename，再 `validate()`；`manifest.json` 带 `schema:1/id/digest/policies/files[].sha256/sourceUnchanged:true`。`lib/preset-compat.js:148-215`。
- 历史别名：`withLegacyChildIds()` 扫同前缀目录、校验 digest 与 policies，把旧 childId 作为别名额外注册（名称带「历史兼容」），使旧会话能继续解析。`lib/preset-compat.js:218-254`。
- 注册即审计：`register()` 成功后必须 `registry.resolve(id)` 且 `state.broken` 为空，否则回滚所有已注册项并抛错。`lib/preset-compat.js:271-292`。
- 新宿主适配：`adaptListAgents()` 仅在 `@deepseek-ai/dsh-tool-subagent-control` 的 manifest 名/版本恰好 `0.2.2-rc.1` 时，删掉已被 `apply()` 收编的 `.../list-agents` 行；其余布局保留原样让宿主自己报错。`lib/preset-compat.js:10-43`。
- 记录在案的旧宿主的失败模式：`toolFilter` 在 0.2.1 被拒、但不能简单删除（deny 是子任务工具策略），必须先备份再转换；未知工具/allow 策略/多策略/已有独立子预设 → 停止并诊断；注册 disposer ≠ 成功，必须查 `resolve().broken`。`AGENTS.md:216-222`。

### 7. 回退（rewind）（d）

- 语义：**留在当前会话**，把 `fromSeq` 起已发送的消息从 surface 与模型请求里一起拿掉，被撤的那句放回草稿；不新建会话/不 fork（`lib/rewind.js:516-519`）。上游曾用 `session.fork({atSeq})`（`docs/upstream/README.zh-CN.md:429`），本版改为原地 `surfaceOp:replace`。
- 主流程 `doRewindOneSession()`：读到开放 turn 先 cancel 并等关闭（8s 超时抛「回合还在进行」）→ `planRewind()` → `disarmRewoundSession()`（只 abort 回退开始时还在跑的那一轮，并移除 queued inbox 项）→ `wrapSessionDeriveMessages()` → `clearModelHistory()` → `resetRequestSeries()` → 记草稿。`lib/rewind.js:573-603`；`367-378`、`419-452`、`390-396`。
- 定位：只取**最近一个已关闭 turn 窗口**内最后一条 human/goal 提示（排除 plugin 源与 MNEMON 草稿），`fromSeq` 取该 turn 的 `turn/start`。`lib/rewind.js:83-123`、`198-217`。
- 落地：`session.append("user/message", {id:"rewind-<ts36>-<n>", content:[]}, {surfaceOp:{op:"replace",startSeq,endSeq}, sourceEventSeqs})`，随后三层自检（promptSeq 必须被覆盖、surface 里不能再有 shadowed、deriveMessages 里不能再出现该文本/该 message.id）。`lib/rewind.js:517-569`。
- 需要的宿主补丁（4 条、共 11 个锚点，全部带 `[dsh-purge]` marker）：
  - `#56 REWIND_HIDE_CUT_ONLY`（6 个替换，含单行压缩版锚点）让前端按 `surfaceOp.startSeq..endSeq` + 整轮 turn 窗口隐藏；`lib/patches/new-tools.mjs:1660-1866`；
  - `#77 REWIND_DROP_SENT_ON_APPEND`（3 个）在 `append()` 收到 rewind 标记时立刻用 `replaceWindow` 重建窗口；`1868-1921`；
  - `#75 REWIND_RESET_TODOS`（1 个）把 todo 状态整体改回 `pending`；`1922-1950`；
  - `#58 REWIND_SKIP_DERIVE`（1 个）让 `user/message` 的 rewind 标记不进模型 transcript；`2002-2018`。
  四条都 `optional:true` + `skipIfMarked`，缺一条就是「界面残留 / 下一轮仍带上旧消息 / todo 已完成态没回退」这类局部失效，而不是整体不可用。
- 状态与并发：`pendingDrafts` Map + `lastPending`，TTL 10 分钟；`getDraft/takeDraft/getPending` 读一次即取走；每会话一条 Promise 串行锁防连点。`lib/rewind.js:1-3`、`261-301`、`571-624`。
- 主/子代理：`analyzeRewind()` 判 kind；`round` 模式会先上溯到主会话，再对上一轮出现过的子会话逐个回退。`lib/rewind.js:141-144`、`460-475`、`626-673`。
- 可见性约束：服务端 `GET/POST /dsh-purge/rewind`（GET 无 sessionId 时返回 pending 草稿）+ `/dsh-purge/rewind/options`（`lib/index.js:2169-2226`）；前端 slot `conversation.input.right`、id `dsh-purge-rewind`、order 20（`client.js:14474-14489`），并 **每 1200ms 轮询** `/dsh-purge/rewind` 拉草稿（`client.js:14452-14472`）。开关 `tuning.rewind` 保存后返回 `restart_required:true`（`lib/index.js:2064-2072`），前端可见性仍需页面重载（`AGENTS.md:331`、`docs/maintenance-pr-58-61.md:12`）。

### 8. 命令注册与冲突兜底（e）

- `registerCommand(commands, definition, fallback)`：先注册原名；只有当异常消息以 `command "<name>" is already registered` 开头才退到 fallback；fallback 也被占则返回 `{registered:null, state:"conflict"}`，**不抛错、不影响其它命令/工具/HTTP**。`lib/command-registration.js:1-20`。
- 注册表（`lib/index.js:1830-1880`）：`purge → purge-community`、`rules → purge-rules`、`skills → purge-skills`、`rewind → purge-rewind`；每条的 `{name, registered, state}` 进 `diagnostics.commands`，`status.commands` 可查实际名字。
- `/rewind` 的提示语用**实际注册名**渲染（`lib/index.js:1862-1867`），所以占用时用户看到的是 `/purge-rewind once`。
- 历史事故：`/rewind` 与其它插件重名导致启动异常，修复方式是保留原持有者 + 备用名，而不是停用功能（`docs/MAINTENANCE.md:63`、`docs/releases/1.6.11.md:5`）。

### 9. 卸载语义与「故意保留」（f）

- 顺序与失败短路：`revertAll()` 撤宿主补丁 → 若本次确实 apply 过且撤销有错，**立刻中止且不清理**（`report.cleanup=[]`、`needRestart=false`）→ `revertAllShims()` → `revertCmdFlash()` → 删 `prompt-inject.md` → 还原并删规则 → 从各 profile `package.json` 剥掉本包 → 清 drill-grant → 生成清理计划。`lib/uninstall.js:203-289`。
- `stripPluginFromPackage()` 只删 `PURGE_PACKAGES` 名字：四个依赖字典 + `bundles`/`plugins`（含 `pkg.dsh.profile`），别的插件条目原样保留。`lib/uninstall.js:12-15`、`45-67`、`186-201`。
- 清理计划只收：profile 下 `node_modules/<本包>`（链接或确认属于本 home 的真实目录）、`$DSH_HOME/dsh-purge`（tuning/audit/anchor-overrides/drill-grant）、插件根目录。`lib/uninstall.js:146-184`。
- 删除实现是 `removeTreeNoFollow`（禁递归 rm、拒文件系统根），CLI 侧 `finishUninstallCleanup()` 带 8 次重试。`lib/uninstall.js:296-312`；独立助手 `lib/uninstall-restart.js:6-77` 会等端口释放后删目录并重新拉起宿主，且内嵌了一份同逻辑的 no-follow 删除（`79-110`）。
- 实际**被保留**：其它插件配置、用户 profile 其它字段、`$DSH_HOME/prompt-inject.md`… ——注意这条**不成立**：`removeOverride()` 会 unlink `$DSH_HOME/prompt-inject.md`（`lib/uninstall.js:133-137` + `lib/core.js:2327-2328`），`resetRules()` 会 `rm -rf $DSH_HOME/rules`（`lib/uninstall.js:139-144`）。真正保留的是 `$DSH_HOME/dsh-purge-community`（audit.jsonl、backups、preset-migrations），因为清理计划里没有它（`lib/uninstall.js:177-181`）。
- 与「应用/回滚不变量」的关系：`AGENTS.md:110` 声明 `prompt-inject.md`、规则集、其他插件配置在任何时候都不该被「应用」或「回滚」覆盖——卸载是第三条路径，代码里没有同等保护。

### 10. 加密默认正文槽（asset-table / table-key / table-read）

- `lib/asset-table.js:1-169` 是 165 行 base64 分片拼成的 `SLOT` 加 `MASK/TAG/IV`；`openSlot()` 用 AES-256-GCM 解密后 `inflateSync` 成明文（`lib/table-read.js:6-18`）。
- 密钥 = `sha256("cordis.slot.v2" \x1e "dsh-purge" \x1e "surface:web|desktop" \x1e "ov.table.1" \x1e MASK)`（`lib/table-key.js:4-13`），而 `MASK` 与密文一起躺在同一个文件里（`lib/asset-table.js:167`）——**这是混淆，不是保密**；`sealSlot()` 只是构建期工具（`lib/table-key.js:15-27`，`package.json:42` 的 `embed-prompt`）。
- 用途：出厂默认注入正文，`defaultOverrideText()` 解槽（`lib/core.js:4253-4257`），`syncPromptInjectOnDiskSync()` 在磁盘缺文件或仍是旧默认时把它同步到 `prompt-inject.md`（`lib/core.js:4380-4400`）。

### 11. 相邻小件

- `lib/apply-gate.js:12-26`：把 CLI 修复的 `ok` 与 `notApplicable` 拆开，只有两者皆假才阻止换包；面板状态 `repaired/not_applicable/failed/missing` 不与「成功」混用。
- `lib/settle-policy.js:3-61`：桌面 surface 的 settle 延迟 4000ms、桌面/密封包禁止自动重启与就地重打；`applyShouldRestart()` 的判定顺序是 sealed > complete/promptReady > appliedCount。
- `lib/drill-grant.js:9-49`：演练台授权存 `dsh-purge/drill-grant.json`，tmp+rename 原子写，卸载只删这一个文件。
- `lib/phase1-keep.js:1-21`：把官方 phase-1 白名单放宽到 `dsh-purge*` 与 `dshpg-*`，保留 CRLF。
- `lib/restore-backup.js:4-21`：宿主源码回滚要求备份是**非空普通文件**且大小稳定，拒绝对符号链接还原，保留原文件权限。
- `lib/desktop-cli.js:5-40`：从 `resources/{app.asar,app.asar.unpacked,app}` × `{dsh/node_modules,node_modules}/@deepseek-ai` 解析 Desktop CLI，既支持 legacy `dsh-desktop-host/lib/cli.js` 也支持 `@deepseek-ai/dsh` 的 `bin` 声明，并对入口做越界校验；`desktopPackageManager()` 复用同一实例内的 pnpm（`44-67`）。

### 12. 配置文件与键位清单（这一层的全部持久化面）

| 文件（相对 `$DSH_HOME`） | 内容 | 读写点 |
|---|---|---|
| `rules/<id>.md` / `rules/<id>.json` | 规则正文 / `{name,target}` | `lib/rules.js:58-64`、`95-108` |
| `rules/state.json` | `{active}` 单值 | `lib/rules.js:54-56`、`224-237` |
| `AGENTS.md` / `CLAUDE.md` / `.dsh-purge-rule.bak` | 激活后的宿主指令 / 首次备份 | `lib/rules.js:81-84`、`266-284` |
| `dsh-purge/cwd-selections.json` | `{paths:[绝对路径]}` | `lib/rules.js:38-40`、`494-516` |
| `dsh-purge/workspace-policy.json` | `{policy: fallback\|strict\|always}` | `lib/rules.js:42-44`、`460-477` |
| `dsh-purge/last-cwd.txt` | 最近 cwd（纯文本） | `lib/rules.js:46-48`、`518-532` |
| `dsh-purge/tuning.json` | `{boost,injectPosition,askNoBlock,rewind,refusalRetry,extraPatches}` | `lib/tuning.js:9-44` |
| `dsh-purge/override-state.json` | `{customized,hash,seedHash,updatedAt}`（判断"这是不是我们自己写的"） | `lib/core.js:4263-4294` |
| `prompt-inject.md` | 注入正文（默认来自加密槽） | `lib/core.js:2327-2340`、`4380-4400` |
| `skills/<id>/SKILL.md` 或 `skills/<id>.md` | 用户技能 | `lib/skills.js:33-43` |
| `dsh-purge-backups/skills/<id>_<stamp>_<pid-rand>/` | 覆盖前备份 | `lib/skills.js:29-31`、`367-389` |
| `.agent-presets/<name>/{preset.yml,agent.cordis.yml}` | 预设（0700 目录） | `lib/presets.js:21-56` |
| `dsh-purge-community/preset-migrations/<id>-<sha16>/` | 迁移私有备份 + manifest | `lib/preset-compat.js:165-215` |
| `dsh-purge/drill-grant.json` | 演练台授权 `{granted,at}` | `lib/drill-grant.js:9-42` |

插件配置本身只落在 profile 的 `cordis.patch.yml` insert 段（`cordis.patch.yml:34-73`），tuning 刻意不进 profile，避免"改行为要重启 profile"（`lib/tuning.js:1-3`）。

### 13. 对外接口最小集（规则/技能/回退）

- `GET|POST /dsh-purge/rules[/op]`：`op ∈ status|scan-cwd|toggle-cwd|set-policy|read|save|activate|delete|reset`，`op` 可由 path tail、body.op 或强制 op 提供（`lib/index.js:2628-2737`）。
- `GET|POST /dsh-purge/skills[/op]`：`status|read|save|delete|import`，body 上限 14MB，`op` 缺省按 `?id=` 推断成 `read`（`lib/index.js:2739-2800`）。
- `GET|POST /dsh-purge/rewind`、`GET /dsh-purge/rewind/options`、`GET /dsh-purge/last-user`（`lib/index.js:2151-2226`）。
- 命令面：`/rules`、`/skills`、`/rewind`、`/purge`，各自带备用名（`lib/index.js:1830-1880`）。

## 数据流与状态

```
[用户在面板/命令改配置]
  rules  ──write──> $DSH_HOME/rules/<id>.md|.json  ──activate──> $DSH_HOME/AGENTS.md|CLAUDE.md (+ .dsh-purge-rule.bak)
                                                     └─> state.json{active}
  cwd 勾选 ──> dsh-purge/cwd-selections.json ; 策略 ──> dsh-purge/workspace-policy.json
  skills ──write──> $DSH_HOME/skills/<id>/SKILL.md   (备份 dsh-purge-backups/skills/…)
  presets ──copy──> $DSH_HOME/.agent-presets/<name>/ ──register──> agentPresets 注册表
                                                   └─迁移备份─> dsh-purge-community/preset-migrations/<id>-<sha16>/
  tuning ──write──> dsh-purge/tuning.json (boost/injectPosition/rewind/refusalRetry/extraPatches)

[每轮请求]
  assemble → rewriteLiveAssembly → readInjectFallback → refreshHungOperator
     → resolveInjectText: committedOverride > prompt-inject.md > sealed slot
     → (+ 主注入为空时) readSelectedCwdInject(cwd)
     → injectionPolicy(excludePresets) → 允许则写 dsh-purge section，否则 withoutPurgeInjection 还原
  host 兜底 globalThis.__dshPurgeHungPrompt（4 级 fallback）

[回退]
  POST /dsh-purge/rewind {sessionId,mode} → applyRewind → cancel/wait → planRewind
     → surface.append(rewind marker, surfaceOp.replace) → 草稿 TTL 10min
  client: slot conversation.input.right + 1200ms 轮询 GET /dsh-purge/rewind → 填回输入框
```

状态全部是**文件**，没有数据库、没有内存持久化（除 `pendingDrafts` 与 `committedOverride`，都按设计仅进程内）。`findDshHome()` 是唯一入口，`pinDshHome()` 把结果钉进 `DSH_HOME` 以免重启换目录（`lib/core.js:2373-2379`）。

| 状态 | 归属 | 生命周期 | 证据 |
|---|---|---|---|
| `active` 规则 | 磁盘 `rules/state.json` | 跨进程持久；`ensureInitialState()` 在启动时清理指向不存在规则的 active | `lib/rules.js:286-297` |
| 注入正文 | 磁盘 `prompt-inject.md` + 进程内 `hungOperatorPrompt` + `committedOverride` | 每次 assemble 重解析；200ms mtime 缓存 | `lib/index.js:186-221`、`lib/core.js:2353-2370` |
| 用户是否改过正文 | `override-state.json` 的 `{customized,hash,seedHash}` | 保存时写；`isKeepableUserOverride()` 先比 hash 再比默认 | `lib/core.js:4304-4328` |
| 回退草稿 | 进程内 `pendingDrafts`/`lastPending` | 10 分钟 TTL，读一次即取走；重启即失 | `lib/rewind.js:1-3`、`261-301` |
| 预设迁移 | 磁盘 `preset-migrations/<id>-<sha16>` | 内容寻址、只增不减；卸载不清理 | `lib/preset-compat.js:165-215`、`lib/uninstall.js:177-181` |
| 技能备份 | 磁盘 `dsh-purge-backups/skills/` | 每次覆盖新增一份，无 GC | `lib/skills.js:367-389` |
| 注册结果 | 进程内 `diagnostics.commands` | effect 回收时清空 | `lib/index.js:1833-1834` |

**不可逆点有三处**：`activateRule` 覆盖宿主 `AGENTS.md`（只留一次 `.bak`，`lib/rules.js:271-281`）、`saveSkill` 覆盖同名技能（留备份但无版本化，`lib/skills.js:424-438`）、`uninstall` 删 `prompt-inject.md` 与 `rules/`（`lib/uninstall.js:133-144`）。

## 真实能力清单

| 能力 | 入口 | 实现位置 | 真实现 | 证据 |
|---|---|---|---|---|
| 规则 CRUD + 单活切换 | `/rules`、`/purge-rules`、面板、`/dsh-purge/rules` | `lib/rules.js:128-222`；`lib/index.js:1353-1442`、`2628-2737` | 是 | `.md`+`.json`+`state.json` 三件套齐全 |
| 规则写入宿主指令文件 | `activateRule` | `lib/rules.js:266-284` | 是 | 首次备份 + 原子写 + 回滚 |
| 规则还原/回滚 | `/rules reset`、`op:reset` | `lib/rules.js:299-338` | 是 | bak 还原 + 内容相等才删 |
| cwd 规则扫描/勾选注入 | 面板、`op:scan-cwd/toggle-cwd` | `lib/rules.js:396-458`、`534-560` | 是 | 仅在主注入为空时生效 |
| workspace 三档策略 | `op:set-policy` | `lib/rules.js:460-477`；`lib/index.js:588-593` | 是 | strict/fallback/always→baseline 丢弃 |
| 技能列表/读/存/删 | `/skills`、`/purge-skills`、`/dsh-purge/skills` | `lib/skills.js:297-352`、`411-456`；`lib/index.js:2739-2777` | 是 | 无 id 时按 GET 参数推断 op |
| 技能归档/目录导入 | `op:import`（base64/文件树） | `lib/skills.js:657-715`、`717-732` | 是 | 服务端路径导入被显式拒绝（`lib/index.js:2764-2766`） |
| 技能覆盖备份与失败回滚 | `backupExisting`/`restoreSkillFromBackup` | `lib/skills.js:367-389`、`579-599` | 是 | 时间戳+pid+rand 唯一目录 |
| 技能可用性/缺依赖诊断 | 红队自检 | `lib/redteam/skill-availability.js:252-350` | 是 | 6 类 issue + 3 态 status |
| 预设落盘（不覆盖用户版） | `preset install` / 自动 | `lib/presets.js:32-56` | 是 | `kept/installed/updated` 三态 |
| 预设注册进 agentPresets | 插件运行时 | `lib/presets-plugin.js:30-91` | 是 | 40 次重试 + disposer |
| 旧预设 toolFilter 迁移 | 注册时 | `lib/preset-compat.js:69-143` | 是（范围受限于单 spawn+纯 deny） | 其余情形抛错保留 |
| 迁移私有校验备份 | 注册前 | `lib/preset-compat.js:148-215` | 是 | 内容寻址 + manifest 校验 |
| 历史子预设 ID 兼容 | 注册时 | `lib/preset-compat.js:218-254` | 是 | 校验 digest 与 deny 集 |
| 0.2.2-rc.1 list-agents 搬移适配 | 注册时 | `lib/preset-compat.js:10-43` | 是（仅精确版本） | manifest name+version 双条件 |
| 预设静态诊断（#76） | selfcheck | `lib/preset-diagnostic.js:8-47` | 是 | 不执行 `!!js`，其余 unknown |
| 按预设排除注入 | config `excludePresets` | `lib/preset-injection.js:5-20`、`29-62` | 是 | 未知上下文保守暂停 |
| 回退一次 / 回退上一轮 | `/rewind`、`/purge-rewind`、输入框按钮、`POST /dsh-purge/rewind` | `lib/rewind.js:573-673`；`lib/index.js:1854-1879`、`2187-2226` | 是（依赖 4 条前端补丁） | 三层自检 + 串行锁 |
| 回退草稿回填 | `GET /dsh-purge/rewind` | `lib/rewind.js:261-301`；`client.js:14452-14489` | 是 | TTL 10min，1200ms 轮询 |
| 回退开关 | `purge-community rewind on/off`、`POST /dsh-purge/tuning` | `lib/tuning.js:12-19`；`lib/index.js:2064-2072` | 是（需重启+重载） | `restart_required:true` |
| 命令冲突兜底 | 四条命令 | `lib/command-registration.js:1-20`；`lib/index.js:1830-1880` | 是 | 三级状态 registered/fallback/conflict |
| 卸载清理与 profile 反注册 | `purge-community uninstall` | `lib/uninstall.js:203-312`；`lib/uninstall-restart.js:6-77` | 是 | 撤销失败即中止 |
| 出厂默认正文注入 | 运行时 | `lib/table-read.js:6-18`；`lib/core.js:4253-4257` | 是 | AES-GCM+deflate（混淆级） |

## 依赖与耦合

- **core.js 是总枢纽**：`findDshHome/atomicWriteFile/atomicCopyFile/normalizeOverride/hashOverride/defaultOverrideText/hangOperatorPrompt/applyReplacementsToText/ALL_PATCHES` 被 rules/skills/presets/uninstall 全部依赖（`lib/rules.js:3-15`、`lib/skills.js:7`、`lib/presets.js:9`、`lib/uninstall.js:5`）。任何拆分都得先拆 core。
- **index.js 是唯一编排层**：命令、HTTP、组装注入、rewind 钩子都在这里接线（`lib/index.js:16-34`、`1730-1881`、`2140-2230`、`2628-2800`），配置文件 `cordis.patch.yml:34-73` 决定插件行与配置默认值。
- **宿主契约（硬依赖）**：`commands.register` 的重名异常文案（`lib/command-registration.js:3-4`）、`agentPresets.register/resolve`（`lib/preset-compat.js:271-292`）、`sessions/sessionController/sessionQuery/agents` 四个服务（`lib/rewind.js:31-38`、`329-365`）、`session.append(...,{surfaceOp})` 与 `deriveMessages`（`lib/rewind.js:517-569`、`406-417`）、`ctx.slots.register("conversation.input.right")`（`client.js:14476-14487`）。
- **宿主版本敏感**：`peerDependencies: @deepseek-ai/cordis ^4.0.1`，兼容区间 `>=0.2.1-rc.1 <0.3.0`（`package.json:122-124`、`103-117`）。
- **外部进程**：`tar`/`unzip`（技能导入，`lib/skills.js:478-525`）、`yaml` 2.9.1（仅预设诊断用，`package.json:161` + `lib/preset-diagnostic.js:3`）。
- **红队子系统单向依赖**：预设注册借用 `lib/redteam/preset-composition.js` 的 `readPresetDefinition`（`lib/presets-plugin.js:9`），技能可用性借用 `lib/redteam/skill-availability.js`；反向没有依赖。

## 局限与缺陷（带证据）

1. **规则「注入 systemPrompt」的说法与实现不一致**。`/rules use` 与 HTTP `activate` 都宣称"并注入 systemPrompt"（`lib/index.js:1373`、`2694-2702`），但同一模块注释明确规则集不参与注入链（`lib/rules.js:239-242`）：真正的注入正文来自 `prompt-inject.md`/加密槽（`lib/rules.js:243-257`）。用户很容易以为两者联动。
2. **激活新规则不清理旧目标文件**。`activateRule()` 只写当前 `meta.target`，`state.json` 单值覆盖（`lib/rules.js:266-284`、`233-237`）。规则 A 写 `AGENTS.md`、规则 B 写 `CLAUDE.md` 后，`AGENTS.md` 仍是 A 的正文，宿主的 agent-instructions 会同时读到两份指令——没有互斥/冲突检测。
3. **skills.js 用了一个未导入的 `fs`**。`lib/skills.js:2` 只导入 `promises as fsp`，`80` 行却调用 `fs.realpathSync`；该语句在 `try` 内，任何 ReferenceError 都被吞成 `path.resolve`，于是 #54 想防的"软链重叠删空 skills"退化为普通路径比较。本会话 node v24.1 里存在惰性全局 `fs`（实测 `typeof fs === 'object'`，getter 形式），所以这条 bug 在部分运行时静默、在另一些运行时降级。
4. **规则正文大小与宿主读取上限不对齐**。规则允许 256KB（`lib/rules.js:18`），但预设把 agent-instructions 的 `maxBytes` 设为 65536（`presets/unrestricted/agent.cordis.yml:30-33`）：超过 64KB 的规则会被宿主截断，而 UI 侧仍显示"已同步"（`agents_synced` 只比文件内容，`lib/rules.js:351-356`）。
5. **卸载会删掉用户提示词与规则库**。`removeOverride()` 直接 unlink `$DSH_HOME/prompt-inject.md`（`lib/uninstall.js:133-137`、`lib/core.js:2327-2328`），`resetRules()` 删整个 `$DSH_HOME/rules`（`lib/uninstall.js:139-144`）；这与 `AGENTS.md:110` 的"任何情况下都不该被覆盖"表述冲突，且卸载不提供 dry-run 或保留开关。
6. **回退是"重度宿主耦合 + 静默降级"的组合**。#56/#77 各有非压缩与单行压缩两套锚点（`lib/patches/new-tools.mjs:1848-1864`、`1915-1918`），宿主改一次构建产物就可能只剩一半命中；四条全是 `optional:true`，缺一条不会报失败，只表现为界面残留或下一轮仍带旧消息。诊断只到"补丁是否命中"，没有"回退是否真的干净"的端到端断言。
7. **回退的可见性依赖轮询 + 页面重载**。`client.js:14452-14472` 每 1200ms 打一次 `/dsh-purge/rewind`；开关返回 `restart_required:true`（`lib/index.js:2071-2072`），文档也承认"rewind 前端可见性仍需重载"（`AGENTS.md:331`）。多标签页会各自轮询、`takeDraft` 先到先得（`lib/index.js:2196-2198`），没有会话级归属校验。
8. **迁移覆盖范围窄且"安全失败"成本高**。`toolFilter` 只支持单 spawn + 纯 deny + 全部工具名可解析（`lib/preset-compat.js:69-119`），其余一律抛错 → 预设注册失败 → 下拉里没有该预设，用户只能看日志（`lib/presets-plugin.js:73-79` 只写 logger.warn）。
9. **`agentPresets` 注册是 40×500ms 轮询 + 定时器**（`lib/presets-plugin.js:17`、`55`、`78`），没有 ready 事件；`stopped` 与 `release` 的竞态用 `84-91` 的 effect 回收兜住，但注册成功前摘插件仍可能泄漏一次 setTimeout。
10. **加密槽只是混淆**：`MASK` 与 `SLOT` 同文件（`lib/asset-table.js:1-169`）、密钥派生常量硬编码（`lib/table-key.js:4-9`），任何拿到插件包的人都能解出出厂默认正文。它防的是随手 grep，不是防逆向。
11. **重复代码**：`lib/uninstall-restart.js:79-110` 内嵌了一份 `removeTreeNoFollowSync` 的复制品（注释自称"BEGIN standalone no-follow cleanup (checked against lib/remove-tree.js)"），与 `lib/remove-tree.js` 双份维护；`lib/desktop-cli.js:4` 的注释也写着 "also embedded in lib/desktop-cli.js"（自指），说明是脚本化拼装产物。
12. **配置写入没有统一 schema/版本**。`tuning.json`（`lib/tuning.js:27-44`）、`cwd-selections.json`、`workspace-policy.json`、`state.json`、`override-state.json`、`drill-grant.json` 各自手写读写与容错，没有 schema 版本号；只有 `preset-migrations/manifest.json` 带 `schema:1`（`lib/preset-compat.js:190-206`）。
13. **"改动 → 生效"的时延不可预测**。规则说"新会话生效"（`lib/index.js:1373`、`2700`），技能完全不涉及生效（宿主发现），预设要重载才重新注册（`lib/presets-plugin.js:82`），rewind 要重启 + 重载（`lib/index.js:2071-2072`），tuning 多数下一轮生效。四个子系统四种时延，没有任何统一入口告诉用户「这次改动什么时候算数」。
14. **备份无配额、无回收**。`dsh-purge-backups/skills/`、`preset-migrations/` 都是只增不减，`uninstall` 也不清 `dsh-purge-community`（`lib/uninstall.js:177-181`）；`backup prune` 只针对 profile 快照（`AGENTS.md` §3 命令表），不覆盖这三类目录。
15. **扫描/解析开销按文件线性重复**。`listSkills()` 对每个 `SKILL.md` 先 `parseSkillDocument` 再 `skillFromFile` 又 parse 一次（`lib/skills.js:335-349`、`279-295`）；`rulesStatus()` 每次 status 都重扫 cwd 树并读每个候选文件前 160 字符（`lib/rules.js:340-361`、`426-458`），配合前端高频 status 轮询会重复 IO。
16. **`injectSnapshot()` 把注入来源回给前端**（`lib/index.js:325-329`），`overview` 里还会带 `skillsStatus`（`lib/index.js:2003`）；这对本机面板无害，但意味着任何能打 HTTP 的本机进程都能读到"当前注入来自哪个规则槽 + 技能清单"，Purge+ 若保留该接口需要显式的本机信任边界。

## 对 Purge+ 的启示

**值得继承（直接拿语义，重写实现）**

1. **单活 + 目标文件映射 + 首次备份的规则模型**（`lib/rules.js:266-284`）：`id → (content, meta{name,target})` + `state{active}` + `<target>.bak` 这套三件套足够表达"多套指令集"，并且天然可回滚。Purge+ 应保留语义，但把「激活」升级为**多槽位/优先级栈**以消除 §6.2 的双指令并存。
2. **cwd 规则"重新扫描后过滤"的防穿越做法**（`lib/rules.js:534-560`）：勾选只存绝对路径，注入时必须在当前扫描结果里重新命中才生效——这是最省事的跨目录隔离。
3. **frontmatter 归一化 + 只改 name/description 的写回策略**（`lib/skills.js:255-261`）：外来技能不改正文、只补元数据，能把"适配"成本压到零。
4. **内容寻址的迁移备份**（`lib/preset-compat.js:148-215`）：`<id>-<digest16>` + manifest 内逐文件 sha256 + `sourceUnchanged` + 存在即逐字节校验，是可复用的通用原语；Purge+ 应该把它抽成独立的 `ConfigBackupStore`，覆盖 tuning/rules/skills/presets 全部写入路径（现在只有 preset 迁移有）。
5. **命令冲突三级兜底**（`lib/command-registration.js:1-20`）：`原名 → 备用名 → 跳过并报警`，且提示语用实际注册名渲染（`lib/index.js:1862`）。这是插件共存的最低成本方案，几乎可以原样搬。
6. **"写前备份 + 失败即回滚 + 内容相等才删"的保守写入**（`lib/rules.js:161-202`、`299-338`、`lib/skills.js:367-389`）：所有破坏性操作都先留证据、再动、失败回滚，是这套代码里最值得抄的工程习惯。

**需要重构**

7. **配置存储层**：现在是 6 个手写 JSON + 各自的容错分支。Purge+ 应做成一个通用 config store：`{schemaVersion, migrate(from,to), read(), write(patch), atomic, backupBeforeWrite, audit}`，把 `lib/tuning.js:27-66` 的"默认值合并 + 归一化 + 审计"升级成通用能力（它的 `tuning_setting` 审计只记已知字段，是很好的起点）。
8. **规则/技能注册表**：把 `rules.js` + `skills.js` + `skill-availability.js` 统一成 `Registry<T>`：`list/read/validate/write/delete/import/backup/availability`，校验器可插拔（kebab 名称、字节上限、frontmatter 必填、路径围栏）。当前 §6.3 的未定义 `fs` 正是"围栏写在业务文件里、没有单测覆盖真实执行路径"的后果——重构时围栏必须是独立可测模块。
9. **预设注册 → 版本化迁移管线**：把 `preset-compat.js` 的"检测宿主版本 → 需要迁移吗 → 备份 → 变换 → 注册 → resolve 校验"抽象成 `Migration{detect, canApply, apply, backupKind, failureMode}`；`migratePresetDefinition` 的"只做能一一对应的变换，其余拒绝"应成为通用原则，但失败必须**可见**（现在只 `logger.warn`，`lib/presets-plugin.js:75`），Purge+ 需要一个注册状态接口 `{id, state, reason, backup}`。
10. **回退**：`rewind.js` 的算法（turn 窗口定位 + surfaceOp.replace + 三层自检 + 每会话串行锁，`lib/rewind.js:198-259`、`517-569`、`571-624`）是干净的，但它的成立前提是四条前端补丁同时在线。Purge+ 应把"前端可见性"从补丁改为**插件自有 slot 组件 + 事件推送**（当前是 1200ms 轮询 + `takeDraft` 先到先得），并把宿主契约收敛成单一适配器：一个"会话窗口裁剪"接口，有原生 API 就用原生，没有才退到 surface 改写。
11. **卸载**：需要显式的保留策略矩阵（`prompt-inject.md`/rules/skills/presets/backups/audit 各自 keep|delete|ask），而不是像现在这样把用户正文和规则库一起删（§6.5）。同时把 `uninstall-restart.js` 的"等端口 → 删目录 → 重拉"抽成通用 helper，删掉内嵌的删除复制品。
12. **统一的「生效时机」契约**：每个可写对象都带 `appliesAt: now|next-turn|next-session|requires-reload|requires-restart` 字段并回给前端（当前分散在四处的文案与 `restart_required` 布尔，见 §6.13）。这是这套实现里最容易被用户误解的地方，也是最容易在新产品里做对的地方。
13. **备份配额与 GC**：备份目录需要 owner、类别、原始 hash、可列举与可回收（当前三类备份目录都是只增不减，见 §6.14）。`preset-migrations` 的内容寻址 + manifest 是现成的好底子，直接推广到 rules/skills/tuning 即可。

**应当替换/删除**

12. **加密槽**（`lib/asset-table.js` + `lib/table-key.js` + `lib/table-read.js`）：混淆级保护，收益低、体积大（16KB 密文）、不可审计。Purge+ 改成明文的 `defaults/*.md` + 构建期 hash 即可，或用真正的用户级密钥。
13. **自研 YAML 子集解析**（`lib/skills.js:105-213`）：只为 frontmatter 服务却要维护块标量/chomp/indent 逻辑；Purge+ 直接依赖 `yaml`（项目已经依赖 2.9.1，`package.json:161`）并保留"只解析 frontmatter、不执行表达式"的约束。
14. **`fs` 未导入**、`desktop-cli.js` 自指注释、`uninstall-restart.js` 复制品这类痕迹：说明该仓库存在"脚本拼接/复制粘贴"的构建路径；Purge+ 必须用单一来源 + 生成校验（hash 比对）来避免同类退化。
