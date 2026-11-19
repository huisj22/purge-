# 05 · 红队演练子系统（dsh-purge-community 1.6.91）逆向分析

分析对象：`D:\Purge+\_research\orig-zip\dsh-purge-一键安装包\dsh-purge-install-kit\pkg\plugin-copy\dsh-purge-community`（下称"项目根"）。
覆盖范围：`lib/redteam/*` 全部 19 个文件（合计 1,068,688 字节）、`presets/redteam/*`（3 个文件）、`skills/redteam/*.md`（23 个文件，137,137 字节）。
下文所有 `file:line` 均以 read 工具的 1-based 行号为准（部分文件末尾无换行，与 `wc -l` 会差 1）。

## 职责

这是一套"攻防演练指挥台"：把 DSH 的一个 agent 预设（`redteam`）与一个进程级 SQLite 事实库、一个 HTTP 面板、64 个模型可见工具绑定在一起，使主会话只做派活、五个执行角色做动作，所有成果（资产/漏洞/凭据/入口/隧道/得分/证据）落进同一个按靶标隔离的库。

四层职责划分清晰：

1. **数据层**（`store-core.js` + `schema.js` + `ip-utils.js` + `validate.js`）：靶标工作区目录、`node:sqlite` 事实库、知识库、路径边界校验。零外部依赖（`store.js:12` 明写"只用 node: 内置模块"）。
2. **工具层**（`tools.js`）：64 个 `redteam_*` 工具，全部通过 `ctx.tools.register` 注册（`tools.js:418` 起），是智能体唯一的写入通道（`tools.js:8` "智能体不直接碰 SQL"）。
3. **界面层**（`ui.js` host 侧 + `client.js` 浏览器侧）：`POST /redteam/api` 单端点 + 11 个页签的 React 单文件控制台（`client.js:4008-4015`）。
4. **编排层**（`index.js` 预设落地 + `preset-composition.js` + `role-section.js` + preset 的 YAML）：把 persona、工具行、锚点门、技能目录装进 DSH 的 agent-preset registry。

红线不是靠提示词，而是硬编码在数据层：`evidence` 必填（`store-core.js:1975`）、自建账号不计分（`store-core.js:1977`、`score-rules.js:187`）、隧道必须有目标侧入口（`score-rules.js:38-42`）。

## 关键实现（带 file:line 证据）

### 1. 数据模型与 schema 校验

**靶标（engagement）不是 DB 行，而是目录**。`openEngagement(name, scope, opts)` 用 `slugify(name)` 当 id，建 `agents/ runs/ reports/` 三个子目录，写 `engagement.yaml` 元数据，然后建库并播种得分点（`store-core.js:1048-1067`）。目录与 id 的绑定由 `dirOf/metaPathOf/dbPathOf/promptsDirOf` 四处强制走 `pathComponent()` + `assertNoLinkedDescendants()`（`store-core.js:972-975`），`pathComponent` 直接拒绝分隔符、`..`、Windows 设备名与 ADS 流（`store-core.js:932-938`）。这是整个子系统最重要的一道边界。

**事实库 20 张表**（`schema.js:67-360`）：`scan_run / segment / asset / asset_name / port / service / fingerprint / observation / edge / tag / vuln / score_point / stage / score_hit / credential / access_session / webshell / tunnel / http_evidence / attack_file / attack_step / shot`，加 2 个视图（`v_asset_summary`、`v_asset_service`，`schema.js:349-359`）与 40 余条索引（`schema.js:303-347`）。设计要点：

- 证据与实体分离：`observation`（任意实体的属性 + `provenance` passive/active + `raw_ref`，`schema.js:125-130`）与 `edge`（异构图，`UNIQUE(src_kind,src_id,dst_kind,dst_id,relation)`，`schema.js:132-139`）是所有采集结果的落地形态，`asset` 只是当前视图。
- 明文凭据是刻意设计：`credential.secret_value` 存明文口令，注释明写"面板直接显示，便于随时复用"并警告"禁止把库文件或导出内容提交到任何仓库"（`schema.js:221-230`）。
- `score_hit` 三列支撑"档位 × 倍率 × 口径"：`points`（本次档位分）、`multiplier`（G5/G6）、`port`（服务口径键）、`self_created`（`schema.js:202-219`）。
- `score_point` 六列是规则数据化：`rule`（上限分组）、`tier`（档位文案）、`cap`、`dedup_scope`、`legacy`、`builtin`（`schema.js:155-185`）。`builtin=1` 的注释点明了动机："判定内置必须看这个标志位，不能用 code 名单"（`schema.js:180-184`）。
- FTS5 是编译期能力，必须探测：`HAS_FTS5` 用内存库试建虚拟表，且提供 `REDTEAM_NO_FTS5=1` 强制降级（`schema.js:31-44`），两张 FTS 表 DDL 单独导出，避免 `USING fts5` 把整份 DDL 带崩（`schema.js:53-63`、`store-core.js:995`）。

**迁移策略**：`migrate()` 先 `PRAGMA table_info` 再 `ALTER TABLE ADD COLUMN`，可重复执行（`schema.js:466-597`）；`has()` 读取失败时返回 `false`（"没有这一列"），注释解释了为何不能返回 true（`schema.js:467-476`）。`migrateKnowledge()` 同一套模式，但异常时 `has()` 返回 `true`（`schema.js:606-610`），与文件头"读不到一律按没有这一列"的纪律相反 —— 两处口径不一致。

**schema 校验是"写入前规范化 + 抛错"，没有 JSON-Schema 式校验器**：`validate.js` 只负责枚举收敛（`normalizeShellType` 认冰蝎/哥斯拉/蚁剑/中文别名，认不出直接抛，`validate.js:20-31`；`normalizeShellStatus` 三态收敛，`validate.js:34-43`）与路径边界（`assertPathWithin` → `path-boundary.js`，`validate.js:58-60`）。`store-core.js:931-938` 的 `assertSourcePath` 是 `addAttackFile` 的读路径闸门，注释直接写了威胁模型：`path` 列是智能体自己写进去的不可信输入（`validate.js:49-52`）。

### 2. 64 个工具与 UI 的驱动方式

工具清单（`tools.js`，共 64 个 `name: 'redteam_*'` 注册点）：

| 组 | 工具 | 关键实现位置 |
|---|---|---|
| 会话 | `engagement_open` / `session_bind` / `session_info` | `tools.js:418-494` |
| 预检 | `preflight` | `tools.js:496-737`（200+ 行） |
| 并发 | `agent_slot`（status/acquire/release） | `tools.js:739-793` |
| 资产 | `asset_add/link/query/get/stats/graph/test/timeline/assess` | `tools.js:794-1046`、`1605-1623`、`2208` |
| 漏洞/凭据/入口 | `vuln_add/query/update`、`credential_add/list`、`access_add/list`、`webshell_add/list/update`、`tunnel_add/list/update`、`session_check` | `tools.js:1047-1436` |
| 角色稿 | `role_prompt` / `roles` / `role_prompt_reset` | `tools.js:988-1022`、`1252-1271` |
| 得分 | `score_list` / `score_hit` / `score_point_save` | `tools.js:1504-1603` |
| 证据/链路 | `http_evidence_add`、`chain_add`、`chain`、`attack_path`、`attack_chain` | `tools.js:1437-1466`、`1627-1696`、`1756-1782` |
| 账本 | `evidence_record/verify/upgrade/list`、`unverified_count`、`unknown_record/resolve/list` | `tools.js:1830-2018` |
| 知识库 | `poc_search/get/add/list/update/use` | `tools.js:2025-2207` |
| 报告 | `score_report`（推荐）、`report`（废弃）、`report_targets`（废弃） | `tools.js:1785-1816`、`1737-1754` |

三条跨工具不变量：

- **统一错误收敛**：`withStructuredErrors` 把 throw 变成 `{ok:false, error, error_kind: bad_input|failed, hint}`，让模型能区分"改参数重试"与"放弃"（`tools.js:352-374`）。这是全文件质量最高的一段工程。
- **靶标按根会话隔离**：`bindings` 是进程内 Map（cap 500，FIFO 淘汰，`tools.js:100-120`）；`resolveEngagement` 依次尝试显式参数 → 本会话/父链绑定 → 全局 `current` 指针，**若全局指针已被别的会话占用则抛错而不是静默串写**（`tools.js:196-225`）。根会话由 `parentSession` 逐级上溯解析并缓存整条链（`tools.js:154-185`）。
- **并发闸门不服软**：`used = max(注册表 running, 预留数)`，满了直接返回 `ok:false`（`tools.js:758-780`）；`subagent/end` 事件自动释放名额，注册表键对不上时按时间兜底清最早一条（`tools.js:397-416`）。

**UI 如何驱动**：浏览器侧只有一个函数 `api(req) => fetch('/redteam/api', {method:'POST', body: JSON.stringify(req)})`（`client.js:567-572`）。host 侧的 `POST /redteam/api` handler 是一条**分层短路链**（`ui.js:1079-1155`）：`handlePlatformOp` → `handleAgentsOp` → `handleUpdateOp` → `handleSkillOp` → `dispatchAsync(store, request)`，前四者返回 `undefined` 才落到通用 op 分发器。通用分发器 `dispatch()` 是 130 行的 op 大 if 链，覆盖约 60 个 op（`store-core.js:742-870`），无 op 时的读写判定靠正则 `/^(add|save|update|delete|import|assess|open)/` 猜（`store-core.js:805`）。`dispatchAsync` 只多一条 `probeSessions`（`store-core.js:876-889`）。

### 3. 计分子系统（score-rules.js）

被计的是 25 条得分点（`DEFAULT_SCORE_POINTS`，`score-rules.js:769-924`），严格对齐《突破入侵类得分规则（合并版）》：获取权限 18 条 + 边界突破 4 条 + 加成 3 条，`rule` 编号 1..25 连续唯一，`src` 保留原文序号用于对账（`score-rules.js:706-723` 注释解释了"历史上直接用原序号当分组键"导致的串吃上限问题）。分值区间 5（终端/台）到 30000（物理隔离核心生产网），每条带 `cap`（如服务器主机 600、Web 应用 2000、集权系统 4000，`score-rules.js:784-810`）。

**四类去重口径**（`dedup_scope`，`score-rules.js:706`）：`service`（同资产同端口算最高一条）、`system`（同系统的最高权限一次）、`target`（整个目标一次，边界突破）、`none`（按台/卡/节点累加）。

**唯一实现**是 `applyScoreCaps(rows, pointsByCode, nameByAsset)`（`score-rules.js:162-255`），两阶段：

1. 口径去重：按 `cap_group|service_key` 分桶，`pickBestHit` 取分最高、同分取 id 小（`score-rules.js:209-221`、`311-317`）。**拿不到服务键就不参与去重**（`score-rules.js:194-202`），注释记录了踩坑："62 条无 target 的 terminal-access 命中里 61 条被判 dedup 不计分……宁可少封顶也不能错封"。
2. 规则上限：按 `rule` 分组、按分值降序累计，超过 `cap` 的标 `capped_reason_kind='cap'`（`score-rules.js:223-253`）。

服务键构造刻意保守：`parseTargetPort` 解析不出端口就返回 `null`（"不要编造 80/443"，`score-rules.js:68-78`），`targetAuthority` 只在有协议时才补默认端口（`score-rules.js:94-110`），`systemKeyOf` 四层降级并在最后退到 `#hit<id>` 保证跨三处调用稳定（`score-rules.js:267-308`，注释明禁 `Math.random()`）。

**分值 = 档位分 × 倍率**：`hitPointsOf` 命中自带 `points` 优先，否则回落得分点默认值，再乘 `multiplier`（`score-rules.js:362-375`）；倍率来自 `scoreMultiplierOf`：IPv6 ×3（G6）、超大数据/知识库系统 ×2（G5），可叠加（`score-rules.js:407-420`）。IPv6 判定不手写正则，复用 `ip-utils.isIpv6`（`score-rules.js:14-15`、`385-396`），注释记录了"`2001:db8::1` 里的 db8 被漏判导致 ×3 不生效"的实测。

**写入侧的数值防御**：`addScoreHit` 对 `points` 做双向夹逼 —— 非有限数拒绝、`<=0` 拒绝、超过 `max(rule_cap, default×100, 1000)` 拒绝（`store-core.js:1988-2006`），注释说明"没有校验时 `points=999999999` 会把总分刷到 9 位数"。写完后重算整个 scoreboard，判断本条是"被封顶"（`cappedByService`）还是"把旧的顶掉了"（`demoted`），并生成中文 `warning`（`store-core.js:2015-2059`）。这一步把"记了分却没加分"从静默变成了可见事实。

**得分点播种**：`seedScorePoints` 每次 `listScorePoints` 都会跑（`store-core.js:1618`），做四件事 —— 按 code 名单回填 `builtin`、清掉旧体系残留（先导出到 `runs/legacy-score-<时间>.json` 存档，再删，`store-core.js:1537-1563`）、把内置点的 rule/cap/points 按规则同步（"分值/上限/口径由规则锁定，用户改不动"，`store-core.js:1565-1595`）、缺哪条补哪条（`store-core.js:1597-1602`）。

### 4. 证据账本：claimed / observed / derived / inferred

`evidence-ledger.mjs` 借用 REA 的 Evidence 思路但改成红队语义（`evidence-ledger.mjs:1-21`）：

- 四档置信度 `claimed / observed / derived / inferred`（`evidence-ledger.mjs:27`）+ 六种权威来源 `tool-output / database-record / screenshot / request-replay / subagent-report / operator-input`（`evidence-ledger.mjs:29-36`）。语义是"`claimed` = 子智能体口头报告，指挥绝不能直接信；`observed` = 你亲自验过"。
- **内容寻址**：`ev_id = 'ev_' + sha256(canonical(operation, parameters, result, confidence, authority, limitations, sorted(supporting_ev_ids)))`（`evidence-ledger.mjs:44-55`、`474-477`）。同内容必同 id，落库前先查重（`evidence-ledger.mjs:184-186`）。
- **读时完整性校验**：`parseEvidenceRow` 重算语义哈希，不等就抛 `evidence integrity mismatch`；`observed + subagent-report` 组合也抛（`evidence-ledger.mjs:479-487`）。这是真正有牙齿的防篡改，不是装饰。
- **写入时的组合约束**：`claimed` 或 `subagent-report` 必须带 `source_agent`；`observed` 不能来自 `subagent-report`（`evidence-ledger.mjs:176-181`）。
- **升级 = 新增 + 建链**：`upgrade` 在 `SAVEPOINT` 里插一条 `observed`（`supporting_ev_ids=[claimed_ev_id]`，`authority` 从 subagent-report 强制改为 tool-output）并写 `evidence_verification(claim_id, observation_id)`，失败 `ROLLBACK TO`（`evidence-ledger.mjs:241-277`）。
- **未闭环计数只认显式核实**：`countUnresolvedClaims` 用 UNION 查询把所有 claim/observation 一次读出，逐条校验 engagement 一致、observation 的 supporting 里确实含该 claim，任何不一致直接抛错（`evidence-ledger.mjs:303-328`）。注释："Generic citations and legacy upgrades are retained, but only explicit verifications close claims"（`evidence-ledger.mjs:302`）。
- **`withdrawn` 属于 `residual_unknown`，不属于 evidence**。`withdrawn` 是未解决问题的终态之一（`open/investigating/blocked/contradicted/resolved/withdrawn`，`evidence-ledger.mjs:88-89`），由 `UnknownRegistry.resolve(unk_id, disposition, resolution)` 写入（`evidence-ledger.mjs:406-423`）；加这个枚举值时要重建表 —— `migrateUnknownStatus` 用 `BEGIN IMMEDIATE` + 建临时表 + 拷数据 + 重建依赖索引/触发器（`evidence-ledger.mjs:452-472`），并且对"认不出旧 CHECK 约束"的情况直接抛错而非猜。

工具面很薄但语义正确：`evidence_record / verify / upgrade / list / unverified_count`（`tools.js:1830-1952`），`redteam_unverified_count` 明确要求"count>0 时汇报必须提醒未核实条数"（`tools.js:1949`）。

### 5. 技能可用性（skill-availability.js）与修复文案（skill-fixes.js）

判定与修复是**两个文件、一份判定**：`checkSkill()` 定状态（`skill-availability.js:252-347`），`fixesForIssue(issue)` 出中文修法（`skill-fixes.js:450-517`），后者文件头明写这个分工（`skill-fixes.js:4-9`）。

`checkSkill` 的四条判定维度（`skill-availability.js:13-21`）：

1. 正文能否加载 —— 只有"正文读不到 **且** 文件确实不在本机"才判 `broken`，其余 `unknown`（`skill-availability.js:268-284`）。
2. 环境变量 —— 从正文正则抽 `process.env.X`、`os.environ["X"]`（带默认值的 `get("X","…")` 不算）、`${X:?}`（`skill-availability.js:63-75`）。
3. 本机路径 —— 只认 `toolkit/bin/local` 下的绝对路径，并用 `pathCountsOnThisHost` 排除"另一平台/另一架构/文档文件"（`skill-availability.js:78-108`）。
4. 外部基础设施占位符 —— `<你的VPS_IP>` 等，且**先看 `REDTEAM_VPS_HOST` 再判占位符**，否则配好的机器永远显示 broken（`skill-availability.js:304-318`）。

关键设计取舍：**正文在手就等于能加载**，记录路径不存在只记一条非阻塞 `file-stale`（`skill-availability.js:286-289`），返回 `status: 'available'`。因此"可用性徽章"实际只表达"加载得到 + 还缺哪些资源"，不是"能跑"（`skill-availability.js:337-347` 与文件头 `skill-availability.js:22` 都承认不判语义/权限/可达性）。

`$DSH_HOME` 双来源是反复出现的坑：`dshHomeCandidates()` 同时探 `process.env.DSH_HOME` 与 `homedir()/.dsh`（`skill-availability.js:46-52`），`existsUnderAnyHome` 任一命中即算存在（`skill-availability.js:55-60`），`bundledSkillSummaries` 扫包内 `skills/redteam` + 两个 home（`skill-availability.js:111-146`）。平台侧还专门解释了为什么两处会分叉（`skill-availability.js:39-45`）。

修复文案的工程化程度值得单独说：`TOOL_FIXES` 覆盖 40+ 工具（`skill-fixes.js:40-276`），每条是 `{what, install}`，且刻意与 `scripts/redteam-setup.sh` 对齐；`toolNameOfPath` 从路径反推工具名（`toolkit/<工具>/…`、`/bin/`、裸文件名），剥扩展名/平台/架构后缀（`skill-fixes.js:369-418`）；`canonicalTool` 把 `impacket-wmiexec` 归到 `impacket`（`skill-fixes.js:421-426`）；`ENV_HINTS` 只给确定的取法，不确定的写"值由你自己提供"（`skill-fixes.js:428-434`）。文案里甚至写清了"工具箱附件里只有 README/技能/脚本，不含二进制"（`skill-fixes.js:24`），属于少见的诚实。

### 6. 预设组装与角色稿

**组装链**：`presets/redteam/agent.cordis.yml`（385 行）→ `preset-composition.js` 的 YAML 子集解析 → `index.js` 的 `installPreset()` 落盘到 `$DSH_HOME/.agent-presets/redteam/` → `registry.register()` 声明进模式下拉。

- YAML 解析器是自写的**fail-closed 子集**：支持块映射/序列、引号标量、单行 flow 序列、块标量、注释、`!!js`（保留为 `{__jsExpr}`）；锚点、别名、非 `!!js` 标签、嵌套 flow、多文档、Tab 缩进一律抛 `CompositionError`（`preset-composition.js:9-34`、`179-182`、`315-326`）。相对模块名解析成 file URL（`preset-composition.js:338-351`），理由是 registry 按声明方的 base 解析（`preset-composition.js:29-33`）。
- 落盘语义：目标不存在 → 完整安装；已存在 → **只自愈不覆盖**（占位符/失效技能路径改写成 `dshHomePath('redteam/skills')`、旧包名改名、摘掉 0.2.1 不再接受的 `toolFilter`、补 `disabled: false` 让原生 `subagent` 可用、补锚点门块）（`index.js:374-448`、`133-147`、`198-290`、`293-359`）。`force` 只有 `REDTEAM_PRESET_REFRESH=1` 才触发（`index.js:459-464`）。
- registry 声明是"软取 + 重试"：`softRegistry()` 先试 `ctx.agentPresets` 再 `ctx.get`，没有就 400ms 轮询、45s 超时，并全程写 `$DSH_HOME/redteam/preset-declare.json` 记录 `phase`（`apply-start / waiting-registry / registering / registered / registered-broken / register-failed / profile-owned / unconfirmed`）（`index.js:484-614`）。这份状态文件是"预设为什么没出现在下拉里"的唯一可诊断证据。

**Persona 组装**分两处：

1. 主会话人设写在 preset YAML 的 `persona.prefix` 里，114 行中文硬约束（`presets/redteam/agent.cordis.yml:29-114`）：指挥四职责、必用原生 `subagent` 而非 `spawn_teammate`（`:49`）、并发 ≤3 与 `redteamRole:` 首行约定（`:58-62`）、五角色索引与内网必须用 `gogo-intranet`/`fscan-intranet`（`:64-71`）、会话隔离（`:80-83`）、"没落库 = 没发生"（`:85-88`）、省 token 的汇报触发条件（`:90-108`）、四条红线（`:110-114`）。
2. 子会话角色稿是**三段拼接**：`DEFAULT_PROMPTS[role]` 落成 `agents/<role>.md`（`store-core.js:5337-5413`）→ 派活任务的 `redteamRole: <code>` 首行被 `agent/inbox/claimed` 钩子捕获（`role-section.js:137-178`）→ 系统提示词装配时读 `engagements/<id>/agents/<code>.md` 原文塞进 `roleText`（`role-section.js:117-135`，消费点在 `lib/index.js:594`）。
   - 角色正文 = 角色段 + 固定顺序的公共段：`COMMON_ENV`（环境）、`COMMON_BIND`（授权）、`COMMON_SCORE_RULES`（记分纪律）、`COMMON_DB_LOOKUP`（打前查库）、`COMMON_EVIDENCE`（落库溯源）、`COMMON_HANDOFF`（交付口径）（`store-core.js:402-467`，头部注明由 `gen-prompts.mjs` 生成、运行时只读 core.js，`store-core.js:404-406`）。
   - 默认提示词语义升级靠指纹 manifest：`agents/.defaults.json` 存上次写入默认的 sha1 前 12 位，命中才覆盖、否则视为用户自写并保留，覆盖前留 `.bak`（`store-core.js:5337-5370`、`5391-5412`）。
   - 角色集合硬编码 5 个执行角色 + 1 个指挥：`ROLE_ORDER = ['recon','assess','vuln-scan','exploit','internal']`、`PLANNER_ROLE='plan'`（`store-core.js:730-731`），`ROLE_TAG` 正则同样只认这五个（`role-section.js:14`）。

**锚点门**（`presets/redteam/anchor-gate.mjs`）是 bootstrap 阶段的输出上限器：首段 reasoning 含 `we` 且无 `let me` 才算"锚住"（`anchor-gate.mjs:21-34`），锚住或走满 `maxBootstrapSteps` 才放开 8192 token 上限（`presets/redteam/agent.cordis.yml:118-125`），并有"首轮必调工具、过 1 步就放开"的红队专用豁免（`anchor-gate.mjs:41-49`）。

### 7. 报告生成与复现

`scoreReport(id, {limit})` 是**单个约 1085 行的方法**（`store-core.js:2703-3787`），内部按注释分成 7 段：SQL 取数（`:2707-2715`）→ 与面板同一套 `evaluateScoreBoard` 计分（`enabledOnly: true`，`:2761-2762`）→ 剔除 `self_created`/被封顶/停用（`:2769-2771`）→ 逐条 `#hitTrace` 追溯动作（`:2781`）+ 原始请求、同资产 URL 逐级降级匹配（`:2784-2802`）→ 条目合并（同得分点 + 同动作、仅目标不同，`:3091`）→ 代表图按得分点最多 3 张（`:3142-3185`）→ 链路排序与前置推导（`:3192-3304`）→ markdown 五段式正文（摘要/复现前置/攻击链/逐条明细/得分点说明 + 附录，`:3391-3740`）。

复现入口由 `report-replay.js` 合成，三条底线写在文件头（`report-replay.js:8-13`）：合成必须标 `synthesized`、信息不足宁可留空、不编造。实现是纯函数：`parseTarget`（显式处理 IPv6 方括号，注释记录了把 host 解析成 `2001:db8:` 的实测事故，`report-replay.js:27-64`）、`parseCurl`（保守抽 URL/方法/头/Cookie，`report-replay.js:82-102`）、`buildHttpRequest`（补 UA/Accept/Content-Length/Connection，IPv6 Host 加方括号，`report-replay.js:109-136`）、`buildCurlCommand`（真实 curl 命令原样返回，`report-replay.js:142-160`）、`fillTemplate`（用已知 host/user/pass 填 `<占位符>`，剩下的原样保留并如实报告，`report-replay.js:174-207`）。这些函数被 `scoreReport` 直接调用（`store-core.js:2913-2990`）。

## 数据流与状态

```
用户给单位名
  → 主会话 redteam_engagement_open
      → slugify → engagements/<id>/{agents,runs,reports} + engagement.yaml
      → db(id,{create}) → DDL + migrate + FTS5 探测 → handles.set(id)
      → seedScorePoints(25 条) + savePrompt(6 角色)
      → bindings[root|session|chain...] = id        （tools.js:430-444）
  → subagent 派活（首行 redteamRole: recon）
      → agent/inbox/claimed → roleBySession 记角色   （role-section.js:58-65）
      → 子会话系统提示词 = 清洗稿 + agents/recon.md + 运行环境（lib/index.js:594-603）
      → 子会话工具调用 → bindings 命中同 id（父链继承）
  → 写入：asset/vuln/credential/webshell/tunnel/http_evidence/attack_step/score_hit/shot
      → score_hit 写入后立刻重算 board，回 warning（capped / demoted）
  → 证据：evidence_record(claimed, source_agent 必填)
      → evidence_upgrade(verified_result) → observed + evidence_verification
      → unverified_count > 0 ⇒ 汇报必须声明未核实
  → 面板/报告：/redteam/api op=scores|scoreChain|scoreReport（三处同一 evaluateScoreBoard）
```

**状态机清单**（都是显式枚举 + CHECK/白名单，不是散落字符串）：

| 实体 | 状态 | 证据 |
|---|---|---|
| 得分命中计分 | `counted` / `capped(dedup)` / `capped(cap)` / `self_created` / `disabled` | `score-rules.js:170-181`、`store-core.js:3861` |
| 证据置信度 | claimed → observed（单向，需 verified_result） | `evidence-ledger.mjs:241-277` |
| 未解决问题 | open / investigating / blocked / contradicted / resolved / withdrawn | `evidence-ledger.mjs:88-89` |
| 攻击阶段 | recon / internet / boundary / internal / target（只这 5 个合法） | `store-core.js:368`、`4195-4210` |
| 资产测试 | untested / testing / tested / blocked / abandoned / no_surface | `store-core.js:487`、`COMMON_DB_LOOKUP` `store-core.js:437` |
| 漏洞 | candidate / confirmed / false-positive / exploited / fixed | `store-core.js:92` |
| 马 / 隧道 | online / offline / dead / unknown；active / down | `validate.js:11`、`store-core.js:4061` |
| 预设声明 | waiting-registry → registering → registered / registered-broken / profile-owned / timeout | `index.js:484-614` |
| 并发名额 | 预留 Map + 注册表 running，`max()` 取值，`subagent/end` 释放 | `tools.js:300-325`、`397-416` |

持久化状态到处都是**混合形态**：权威数据在 SQLite，但 `current`（当前靶标指针）、`engagement.yaml`、`settings.json`、`config.json`、`preset-declare.json`、`agents/.defaults.json`、`runs/legacy-score-*.json` 都是旁路文件，且各自用不同写入方式（`settings.js` 走 `atomicWriteFileSync`，`store-core.js:966` 直接 `writeFileSync` 写 `current`）。

## 真实能力清单

| 能力 | 入口 | 实现位置 | 真实现 | 证据 |
|---|---|---|---|---|
| 靶标工作区创建/切换 | op `openEngagement` / `activateEngagement`；工具 `engagement_open` | `store-core.js:1048-1067`、`:963-968` | ✅ | 目录 + YAML + 建库 + 播种全做 |
| 资产/端口/服务/指纹落库 | 工具 `asset_add/link`（`tools.js:794-904`） | `store-core.js:1219-1290` | ✅ | `assetChildren`/`assetRow` 组装 |
| 资产检索（FTS5 + LIKE 降级） | op `assets`、工具 `asset_query` | `store-core.js:1291-1397`、`995` | ✅ | 无 FTS5 时走 LIKE（注释 `:991-993`） |
| 漏洞/凭据/入口 CRUD | 工具组 + op 组 | `store-core.js:2168-2494` | ✅ | 明文口令入库（`schema.js:221`） |
| WebShell/隧道连通性实测 | op `probeSessions`（唯一 async op） | `store-core.js:4002-4064` | ✅ | 真实 `fetch` + `net.connect`，回写 status/latency |
| 得分点播种与规则同步 | 隐式（每次 `listScorePoints`） | `store-core.js:1502-1611` | ✅ | 25 条、cap、dedup_scope、旧点归档后清理 |
| 计分口径（去重 + 上限 + 倍率） | 三处共用 `evaluateScoreBoard` | `score-rules.js:162-255`、`:435-464` | ✅ | 面板/报告/攻击链同源 |
| 记分写入的数值防御 | 工具 `score_hit` | `store-core.js:1988-2006` | ✅ | `points` 三向夹逼 + warning |
| 攻击链分阶段与得分分桶 | op `scoreChain`、工具 `attack_chain` | `store-core.js:3788-3972`、`:230-345` | ✅ | `DEFAULT_STAGES` 5 阶段 + 自动推导 `scoreStageOf` |
| 证据账本（哈希/去重/升级/一致性） | 工具 `evidence_*` | `evidence-ledger.mjs:121-329` | ✅ | 读时重算哈希并抛错 |
| 未解决问题注册表 | 工具 `unknown_*` | `evidence-ledger.mjs:333-439` | ✅ | 表重建迁移加 `withdrawn` |
| 知识库 POC/EXP + nuclei 模板检索 | 工具 `poc_*`、op `pocSearch` | `store-core.js:4620-4911`、`:4528-4616` | ✅ | 两层检索（库 + 模板库） |
| 报告 markdown + 可重放报文 | op `scoreReport`、工具 `score_report` | `store-core.js:2703-3787` + `report-replay.js` | ✅ | 1085 行单方法，合成标注来源 |
| 技能可用性自检 | 工具 `preflight`、op `skillCatalog` | `skill-availability.js:252-347` | ⚠️ 部分 | 正文可读即 `available`，不判"能跑"（`:22`） |
| 技能修复文案 | `fixesForIssue` | `skill-fixes.js:450-517` | ✅ | 40+ 工具逐条修法 |
| 环境适配（工具路径解析/分配） | op `platformConfigGet/Save`、`platformEnvAdaptStatus/Skip` | `platform-config.js:261-303`、`:533-593` | ✅ | 16 项 `TOOL_CATALOG`、PATH 与目录扫描 |
| 发送前环境门禁 | `agent/pre-step` reject | `ui.js:1028-1077` | ✅ | 首轮 turn≤1 step≤1 且 `!ready` 则 reject |
| 并发闸门（≤3，可配 1–10） | 工具 `agent_slot` + `subagent/end` | `tools.js:739-793`、`settings.js:56-62` | ✅ | 注册表 running × 预留取 max |
| 会话-靶标隔离绑定 | 进程内 `bindings` | `tools.js:154-225` | ⚠️ 部分 | 重启即失效（`tools.js:491` 自认） |
| 子会话角色稿注入 | `redteamRole:` 首行 | `role-section.js:117-178` + `lib/index.js:594` | ✅ | 读 `agents/<code>.md` 原文 |
| 面板 11 页签（资产/环境/智能体/会话/漏洞/链路/得分/报告/知识库/技能/测试） | `client.js` | `client.js:4008-4015`、各 `XxxTab` | ✅ | 4218 行单文件 React |
| 预设落地与自愈 | `installPreset` | `index.js:374-448` | ✅ | 6 类修复路径 |
| registry 声明与状态诊断 | `apply` + `preset-declare.json` | `index.js:484-614` | ✅ | 软取 + 400ms×45s 重试 |
| 锚点门 | preset 行 `./anchor-gate.mjs` | `presets/redteam/anchor-gate.mjs:21-49` | ✅ | reasoning 分类 + 4 步上限 |
| 插件版本/更新检查 | op `version` / `updateCheck` | `ui.js:956-1020`、`:437-486` | ✅ | 需外网 GitHub（`:357-436`） |
| 截图入库与尺寸校验 | 工具 `shot_add`、op `shotData` | `store-core.js:901-925`、`:4269-4374` | ✅ | 自己解 PNG/JPEG/WebP 头 |
| 跨靶标导入 | op `import` | `store-core.js:5226-5303` | ✅ | 事务 + `#edge` 幂等 |

## 依赖与耦合

**外部依赖为零**，这是刻意约束：`store.js:12`、`store-core.js` 头（"零 Cordis 依赖"）、`ui.js:11-13`（"为什么走 webServer 而不是 typert/@Remote：profile 下解析不到 node_modules"）、`evidence-ledger.mjs:20`。代价是每个能力都手写（YAML 解析器 404 行、图片头解析、HTTP 报文合成）。

**唯一的软依赖是 `@deepseek-ai/dsh-tools` 的 `defineTool`**，而且不能静态 import：`loadDefineTool()` 从 `process.argv[1]`、`PURGE_DSH_CLI`、`$DSH_HOME`、`profiles/{web,desktop,default}`、cwd、甚至硬编码 `D:\DeepSeek Harness\npm-global\...` 逐个 `createRequire` 试（`tools.js:37-90`，`:80` 就是写死的 Windows 路径）。解析失败整个 tools 平面不挂载 —— 注释说明了后果："预设行 fiber 为 undefined → 整份「红队模式」被下拉过滤"（`tools.js:33-35`）。

**Cordis 服务依赖**：

- `store.js`：`inject: []`，`provide('redteam')`（`store.js:23`、`:77`）。
- `tools.js`：`inject: ['tools']`，软取 `ctx.redteam`（`tools.js:98`、`377-393`），不可用时退化成会抛错的空 store。
- `ui.js`：`inject: ['redteam','webServer']`（`ui.js:155`），其余全软取（`softService`，`ui.js:631-648`）。
- `index.js`：`inject: []`，靠 `ctx.effect` 等 registry 出现（`index.js:38`、`497-506`）。
- 反向耦合：`role-section.js` 被 `lib/index.js`（主插件）调用，红队不再是可独立卸载的模块。

**模块内耦合**：`store-core.js` 是引力中心 —— 它 import 了 ip-utils / schema / validate / score-rules / report-replay / platform-config 六个模块，再把它们**全部原样 re-export**（`store-core.js:56-77`），所以"拆分"只改善了阅读，没有改善依赖方向。`tools.js` 同时依赖 store-core、skill-availability、skill-fixes、platform-config、settings、evidence-ledger 六个（`tools.js:20-30`）。`ui.js` 依赖 store-core 的 `dispatch`，即面板与工具走同一套 op 词汇 —— 这是优点（"界面看到的、命令行验的、智能体写的是同一条路径"，`store-core.js:736-737`）。

## 局限与缺陷（带证据）

1. **`schema.js` 里有两处对未定义标识符的引用，迁移代码静默失效**（已实测复现）。`migrate()` 使用 `SCOPE_SQL`（`schema.js:591`）与 `LEGACY_STAGE_MAP`（`schema.js:586`），但两者定义在 `store-core.js:157`、`:358`，`schema.js` 只 import 了 `parseTargetPort`（`schema.js:4`）。两处都在 `try{}catch{}` 里（`schema.js:583-592`），运行时 `ReferenceError` 被吞掉。我用 node v24 复现：建库 → `migrate` → 插入 `10.0.0.5`（scope NULL）与 `stage='exploit'` 的步骤 → 再 `migrate`，结果 `asset.scope = null`、`attack_step.stage_code = null`（应为 `internal` / `boundary`），而同段的 `discovered_at` 回填正常（`:593-596`）。后果：老库升级后资产内外网归属与步骤阶段回填全部缺失，只在新写入路径上才正确。

2. **`migrateKnowledge` 与 `migrate` 的错误语义相反**。文件头写"读不到表结构一律按没有这一列处理……反过来当成列已存在会让迁移被静默跳过"（`schema.js:13-15`），`migrate` 的 `has()` 返回 `false`（`schema.js:471-475`），但 `migrateKnowledge` 的 `has()` 返回 **`true`**（`schema.js:606-610`）。同一个文件里两种纪律。

3. **HTTP 端点只做 Origin 校验，且回环请求直接放行**。`ui.js:1090-1096`：`remote==='127.0.0.1'` 时 `originOk` 立刻为 `true`，完全跳过 Origin 比对。浏览器发往 localhost 的请求源地址就是回环，因此 Origin 检查在这里是空的；`content-type` 也从不校验（`ui.js:1116-1117` 直接 `JSON.parse` 请求体）。剩下唯一的障碍是"JSON 请求需预检、而 handler 对非 POST 返回 405"——但 `text/plain` 的表单类请求是简单请求，可绕过预检并写入状态（CORS 只挡住读取响应，不挡写入）。受影响的可写 op 包括 `savePrompt` / `addScoreHit` / `addCredential` / `pocSave` / `deleteScorePoint`（`store-core.js:844-865`、`:776-778`）。注意 `credentials` 读取返回明文 `secret_value`（`schema.js:221-229`），虽然读响应被 CORS 阻断，但设计上把"高价值读接口"放在同一个无认证端点上仍是结构性风险。

4. **三个巨文件是维护的主要成本**：`store-core.js` 5414 行 / 341,709 字节、`client.js` 4218 行 / 277,508 字节、`tools.js` 2232 行 / 135,571 字节，三者占 `lib/redteam` 的 75%。具体病灶：
   - `scoreReport` 单方法 1085 行（`store-core.js:2703-3787`），内部 7 段靠注释分隔，无子方法抽取；`scoreChain` 另有 185 行（`:3788-3972`）；两者又各自重算一遍 `effPoints`（`:2753-2760` vs `:3831-3835` vs `listScorePoints` `:1628-1631`），"唯一实现"只做到了 `applyScoreCaps` 层，档位/倍率解析仍有三份。
   - `client.js` 前 540 行是一整块 CSS 字符串常量（`client.js:23-562`），之后单文件内定义 15 个 `XxxTab` 组件、若干复用件（`Section`、`Clip`、`ShotStrip`、`useCollapse`）与几何拖拽逻辑，全部用 `h()` 手写 `createElement`，没有组件边界也没有 props 约定。

5. **`tools.js` 里 200 行的 `preflight` 把六件事塞进一个工具**：读 skills 服务、读 `$DSH_HOME/.env`（自己手写 dotenv 解析，`tools.js:512-528`）、读平台配置、扫 toolkit 目录、逐技能体检、生成 onboarding 文案（`tools.js:503-735`）。其中 `.env` 解析与 `platform-config` 的 `mergeConfigEnv` 职责重叠（`tools.js:510` vs `platform-config.js:307-318`）。

6. **重复实现散落各处**：目标归一化有 `targetKey`（`store-core.js:125-136`）与 `targetKeyOf`（`client.js:1489-1501`）两份；`$DSH_HOME` 候选团在 `skill-availability.js:46-52`、`ui.js:43-49`、`index.js:157-170`、`store.js:29-34` 各写一遍（语义略有差异）；`parseTarget`（`report-replay.js:27-64`）、`targetAuthority`（`score-rules.js:94-110`）、`parseTargetPort`（`score-rules.js:68-78`）三套 host/port 解析；`POC_CATEGORIES`（`schema.js:411-427`）与 `POC_CAT_NAME`（`client.js:597-604`）双份维护，注释自称"与 core.js 一致"（`client.js:596`）却只能靠人工同步。

7. **遗留死代码与自相矛盾的注释**：`ACCOUNT_POINT_CODES` / `SERVICE_CAPPED_POINT_CODES` 引用的是 v0.10 的 code（`score-rules.js:48`、`61`、`320-324`），这些 code 在 25 条新规则里已不存在（`score-rules.js:769-924`），`legacyCapGroup` 永远命中不到。`LEGACY_PROMPT_HASHES` 是空对象（`store-core.js:387`），注释说"旧提示词一律不沿用"（`:381-385`），于是老靶标的旧角色提示词会被判成"用户自写"永久保留。`COMMON_SCORE_RULES` 里仍写着"服务端会自动改派并返回 warning"（`store-core.js:425`），而 `addScoreHit` 的实现明确"不做静默改派"、直接抛错（`store-core.js:1957-1972`）——提示词与代码互相打脸，模型会照着错的文档试。

8. **固定 3 个并发 + 进程内状态**：`bindings` / `reservations` / `roleBySession` 都是模块级 Map（`tools.js:101`、`104`；`role-section.js:16`），重启即丢（`tools.js:491` 自认"绑定是进程内状态"）。`roleBySession` 用 FIFO 淘汰 400 条（`role-section.js:19-30`），长会话会丢角色。

9. **`index.js` 的自愈是文本级 YAML/半结构化字符串手术**：`repairToolFilter`（删 `toolFilter:` 段）、`repairDelegation`（把 `## 你是谁、你不做什么` 改名、往某个句子后面插一句、逐行找 `- id: tool-subagent` 补 `disabled: false`）、`syncAnchorGate`（按两个标记字符串切块替换）全靠 `indexOf`/正则（`index.js:210-227`、`233-290`、`297-359`）。用户一旦改了措辞或缩进，自愈要么静默不生效，要么把文件改花。

10. **测试不随包分发**：`package.json` 的 `test` 脚本列出 5 个 redteam 测试（`redteam-host` / `redteam-evidence-ledger` / `redteam-tools-contract` / `redteam-evidence-store` / `redteam-atomic-write`），但项目根没有 `test/` 目录，`files` 白名单也不含 `test`（`package.json:23-38`、`:42`）。因此使用者无法验证上述第 1 条这类迁移缺陷 —— 它是"看起来有测试、实际拿不到测试"的状态。

11. **面板与工具的能力不对等**：工具面有 `redteam_evidence_*`（6 个），面板没有证据账本页签（`client.js:4008-4015` 的 11 个页签里没有）；反过来面板有 `env`、`agents`、`skills` 三个页签的 op 不在 `dispatch` 里，而在 `ui.js` 的分支里。同一个"子系统"的能力面被拆成两套不一致的表。

## 对 Purge+ 的启示

**值得原样继承的（这是这套代码真正的资产）**

1. **计分骨架 = 数据驱动的去重口径 + 规则上限 + 档位分**。`dedup_scope ∈ {service,system,target,none}` + `rule/cap` + `hit.points` + `multiplier` 这四件事足以表达绝大多数"演练计分"规则，且不需要改代码就能加规则。必须保留的细节：拿不到口径键就**不去重**（`score-rules.js:194-202`）、同分取更早（`:311-317`）、`cap=0` 表示不设上限。
2. **证据账本的内容寻址 + 读时校验 + 单向升级**。`sha256(canonical(semantic))` 作为主键、读时重算、`claimed→observed` 只走 `evidence_verification` 建链 —— 这三条是"报告里的数字可信"的根基，`evidence-ledger.mjs` 的 516 行里有一半是这一件事的正确姿势，几乎可以整文件移植。
3. **靶标隔离按目录 + 会话绑定按根会话上溯**。"先 slug 成目录、路径四处强制 `pathComponent`、binding 沿 `parentSession` 上溯并拒绝在冲突时静默串写"（`store-core.js:972-975`、`tools.js:196-225`）是把多会话并行做成可用的关键，替换成本高、收益最高。
4. **写入侧的"可见即拒绝"哲学**：`evidence` 必填、`points` 夹逼、自建账号不计分、封顶/顶替必须回 warning（`store-core.js:1975`、`:1988-2006`、`:2034-2059`）。它把"记了分没加分"从静默故障变成模型可读的停止信号 —— 这是 prompt 工程做不到的。
5. **fail-closed 的 YAML 子集解析器**。`preset-composition.js` 用 404 行换"读不懂就抛而不是猜"（`preset-composition.js:9-34`），对任何"配置即产品"的系统都值得照抄思路。
6. **技能可用性 = 四维缺口清单 + 可执行修复文案**。"缺什么（env/path/placeholder/shadowed）+ 怎么修（单行、带命令）"这个结构（`skill-availability.js:246-251` + `skill-fixes.js:450-517`）比任何"健康检查"页都好用，可直接抽象成 Purge+ 的"能力前置条件"模型。

**应当重构的**

1. **把 `scoreReport` / `scoreChain` / `listScorePoints` 的档位与倍率解析收敛成一个函数**（现在三份，`store-core.js:1628`、`:2753`、`:3831`）。1085 行的方法必须按"取数 → 计分 → 合并 → 追溯 → 渲染"拆成 5 个纯函数，`markdown` 渲染独立成模板模块；否则任何报告格式改动都是在 341KB 文件里做手术。
2. **`store-core.js` 的 re-export 迷宫要拆掉**。现在 `store-core.js:56-77` 把 6 个模块的导出面原样再导出，导致"谁依赖谁"完全看不出来，也让循环依赖只差一步（`schema.js` 已经踩了未定义引用的坑）。Purge+ 应当让 schema 只依赖纯常量模块，把 `SCOPE_SQL` / `LEGACY_STAGE_MAP` 这类 SQL 片段与映射下沉到 schema 或独立常量文件。
3. **HTTP 桥接必须有认证，而不是 Origin 判断**。一条 `POST /redteam/api` 承载 60 个 op，其中包括明文凭据读取（op `credentials` → `listCredentials`，`store-core.js:820`）与任意状态写入。最小改法是启动时生成随机 token（写进 `preset-declare.json` 之类的本地文件 / 注入页面），请求头带 token；同时校验 `content-type: application/json`。这条在 1.6.91 里是缺失的（`ui.js:1083-1114`）。
4. **进程内状态要落盘或标注生命周期**。`bindings`、`reservations`、`roleBySession` 三张 Map 决定"攻击有没有串靶标"，却在重启后全丢、在 400/500 条后 FIFO 淘汰。Purge+ 至少应把绑定写进靶标目录（`bindings.json`）并在会话头里带 `engagement` 字段，而不是靠内存猜。
5. **面板与工具的能力表要收敛成一份 schema**。现在 64 个工具的 `parameters`（`tools.js`）、60 个 op（`store-core.js:742-870`）、11 个页签（`client.js:4008-4015`）三者各写一遍，任何字段改名要改三处。应把"实体 + 字段 + 状态枚举"定义为单一 manifest，工具/op/UI 都从它派生。
6. **`preflight` 拆成"探测原语 + 编排"**：把 `.env` 解析、toolkit 扫描、工具解析、技能体检各自成函数，`preflight` 只做汇总与文案；顺手消掉 `tools.js:512-528` 与 `platform-config.js:307-318` 的重复。

**建议替换的**

1. `skill-availability` 的"正文可读即 available"（`:286-289`）应替换为三态 `loadable / runnable / blocked`，把 env/path/placeholder 缺口升级成 `blocked` 的子原因，而不是混在 `available` 的 `issues` 里 —— 否则"可用性徽章"永远全绿。
2. `client.js` 的单文件 4218 行 + 540 行内联 CSS 应替换为真正的组件目录（每个页签一个文件 + 一份设计 token），并把 `api()` 换成带 schema 校验的客户端；拖拽/几何/未读红点这类横切逻辑提取成 hook 包。
3. `index.js` 的字符串级自愈（`repairDelegation`、`repairToolFilter`、`syncAnchorGate`）应替换为"结构化 preset AST + 版本化迁移"，否则每次 DSH 宿主升级都要再写一个正则手术。

**必须保住的 5 条不变量**（重写时用测试钉住）

1. `ev_id = sha256(canonical(semantic))`，读库时重算并抛错；`observed` 不得来自 `subagent-report`（`evidence-ledger.mjs:44-55`、`479-487`、`179-181`）。
2. 计分三处（面板/报告/攻击链）必须调用同一个 `applyScoreCaps`，且 `enabledOnly` 口径一致；被扣分的命中**不进正文但要在页脚计数**（`store-core.js:2747-2771`）。
3. 靶标 id 只能来自 `slugify`，任何拼路径都必须过 `pathComponent` + 根目录校验；读 `path` 列（不可信）必须过 `assertPathWithin`（`store-core.js:932-938`、`:927-929`）。
4. 自建账号（`self_created=1`）永不参与竞争、不占上限、不进报告（`score-rules.js:187`、`store-core.js:2034-2036`、`:2770`）。
5. 技能根顺序里用户目录必须排在随包目录之前，否则用户配好的 VPS 会被模板占位符盖住（`presets/redteam/agent.cordis.yml:191-201`、`skill-availability.js:321-335` 的 `shadowed` 判定）。
