# 08 · UI 面板（client.js / 槽位注入 / 面板 API）— dsh-purge-community 1.6.91

> 分析对象：`D:\Purge+\_research\orig-zip\dsh-purge-一键安装包\dsh-purge-install-kit\pkg\plugin-copy\dsh-purge-community`
> 下文所有 `file:line` 均相对该根目录。只读分析，未改动原件。
> **切片前提校验（重要）**：`packages/`、`src/`、`test/`、`market/`、`node_modules/` 在本发行包中**全部不存在**（逐目录 `Test-Path` 实测 False）。`package.json:43,46,47` 的 `build:client`/`test:ui`/`check:client` 均指向 `packages/purge-panel/*`，因此**面板源码与构建链不在本发行版内**，只有构建产物 `client.js`（662,513 B / 15,088 行）。

## 职责

本切片负责 DSH Web/Desktop 客户端里的**唯一人机界面**：一个通过 Cordis `ctx.slots` 注册进宿主 UI 的 React 面板，覆盖「宿主补丁状态 → 提示词/规则/技能编辑 → 红队演练台 → 维护（更新/备份/回滚/卸载）」。

1. **构建产物分发**：`client.js` 头两行自述 "Generated from src/ by npm run build. Do not edit."（`client.js:1-2`），说明交付物是已打包单文件，不是可维护源码。
2. **槽位注入**：由 manifest 的 `dsh.client.inject` 声明依赖的宿主客户端包（`package.json:87-96`），运行时再向 5 个 slot id 注册组件（见下）。
3. **薄前端 + 厚后端**：面板自身不实现业务，全部状态来自主插件注册的 21 条 `/dsh-purge/*` HTTP 路由（`lib/index.js:1945-2595`、`2832-2843`、`1578-1605`）以及演练台的单点 RPC `/redteam/api`（`lib/redteam/ui.js:1079-1150`）。
4. **不属于本切片**：`lib/web.js` 只做 web 宿主重启（导出 `restartNote`/`portFromRequest`/`restartArgv`/`scheduleRestart`，`lib/web.js:8-110`），**不提供面板静态资源**。面板作为 client 模块由 DSH 客户端加载器挂载，不经 `lib/web.js`。

## 关键实现（带 file:line 证据）

### (a) 构建与注入链

**清单层注入**：`package.json:83-118` 的 `dsh` 字段

| 键 | 值 | 位置 |
|---|---|---|
| `dsh.client.platform` | `"web"` | `package.json:88` |
| `dsh.client.inject` | `@deepseek-ai/dsh-client-connection` / `-runtime` / `-locale` / `-ui-slots` / `-ui-settings` / `-ui-sidebar-right` | `package.json:89-96` |
| `dsh.bundle.patch` | `./cordis.patch.yml` | `package.json:85` |
| `exports["./client"]` | `./client.js` | `package.json:11` |

`inject` 列的是**宿主客户端包名**（含 `ui-settings`、`ui-sidebar-right`），不是 slot id。面板真正使用的 slot id 只有 5 个：

| slot id | 注册 id / key | order | 组件 | 证据 |
|---|---|---|---|---|
| `shell.overlay` | `dsh-purge-panel-overlays` | 60 | `PanelOverlays`（welcome + 环境门禁 + 授权弹窗） | `client.js:15039-15049`、`15004-15018` |
| `sidebar.panellist` | `dsh-purge`（label `Purge`） | 30 | `PurgeGlyphIcon` | `client.js:15050-15062` |
| `main` | key `dsh-purge` | — | `PurgePage`（整页 6 tab） | `client.js:15063-15073` |
| `plugins.bundle.config` | key `dsh-purge-community` | — | `SettingsRoot`（插件设置页） | `client.js:15074-15084` |
| `conversation.input.right` | `dsh-purge-rewind` | 20 | `RewindSafe`（输入框右侧回退按钮） | `client.js:14476-14487` |

本版**不存在** `settings.section` 或 `sidebar-right` 槽位注册（对 `settings.section` 全文 grep = 0 命中）；这两者只出现在旧脚本的目标里（`scripts/patch-client-dock.mjs:391-398`），以及 manifest 注入的宿主包名中。回退按钮是后挂的：`apply()` 里通过 `ctx.inject(["sessions","uiWorkspace","conversation"], installRewindUi)` 注入（`client.js:15032-15035`）。

**打包模型**：`client.js:3-4` 用 `window.__ModuleLoader__.load({id:"dsh-purge-community", factory:(require)=>{...}})` 包住一个 CommonJS 工厂，`require("react")`（`client.js:46`）、`require("react-dom")`（`client.js:9115`、`13723`、`11071`），末尾 `return module.exports`（`15087`）。所以宿主只提供 React 运行时，其余全部内联。
模块分块以 `// src/xxx.js` 注释标出，可完整枚举（`client.js:34,45,50,53,56,59,97,271,8958,9114,9117,9892,10048,10220,10291,10970,10999,11070,11222,11288,12291,12354,12789,13177,13327,13610,13710,13722,13725,14068,14491,14494,14497,14594,14702,14981`）。

**双 target 残留**：构建带 `--community` 开关（`package.json:43`），产物里留下未折叠的三元：`name = true ? "dsh-purge-community" : "dsh-purge-panel"`（`client.js:14982`）、`15079` 同型；全文 `true ? ` 10 处、`false ? ` 8 处（如 `13207`、`13247`、`13294`、`13517`、`13605`、`15013`）。

**`scripts/build-market.mjs` 与面板无关**：它生成 DSH 官方 format-1 市场索引 `index.json` + `index.html`（`scripts/build-market.mjs:1`、`58-61`），插件图标是内联 SVG data URI（`28`），并从已发布 tag 的 `package.json` 校验 `name/version/dsh.bundle`（`12-17`）。它依赖 `../market/breeze-voice.json`、`../market/h3-video.json`（`55-56`），而 `market/` 目录在本发行包中同样**不存在** → 该脚本当前不可执行。这与面板构建链无关，仅说明"发行物里的 scripts 大量指向缺失的源码目录"。

**旧构建路径（已死，实测）**：`scripts/patch-client-dock.mjs`（454 行）原设计是：补 locale 键（`22-71`）→ 注入 `.dshp-dock` 一套 CSS（`76-126`）→ 注入浮动 dock + 授权门禁代码块（`138-378`）→ 把 `apply()` 里 `settings.section` 改成 `shell.overlay` + `PurgeDock`（`386-442`）→ 再调 `build-client.mjs`（`447-453`）。`scripts/build-client.mjs` 则从 `lib/redteam/client.js` 里按 `factory: (require) => {`（`19-21`）剪切工厂体，写进 `client.js` 的 `__DSH_PURGE_DRILL_BEGIN__/END` 标记之间（`15-16`、`55-73`）。
**实测结论**：对着本发行包的 `client.js`，`patch-client-dock.mjs` 在 `382` 行抛 `Error: installRewindUi not found`；`build-client.mjs` 在 `67` 行抛 "client.js missing drill markers"。标记字符串、`PURGE_CSS`、`function PurgeDock`、`dsh-purge-dock` 全文均为 0 命中；`REWIND_CSS` 存在但形如 `var REWIND_CSS = \``（`14069`），不匹配脚本要的 `\t\tconst REWIND_CSS`（`patch-client-dock.mjs:129`），即使前一步不抛也会在 `130` 行抛错。→ **两条脚本都是 1.1.x 时代的遗留，对 1.6.91 完全失效**。
这份遗留的动机写在脚本头：把上游 1.1.71 的"只有设置页一段"改成右侧双页签浮动 dock（清洗/演练台）+ 首次授权弹窗（`patch-client-dock.mjs:1-3`）。1.6.x 已改用原生槽位，dock 被 `ENTRY_CSS` 显式隐藏：`.dshp-launch,.dshp-hero-chip,.dshp-tab-chip,.dshp-dock{display:none!important}`（`client.js:13711-13719`）。

### (b) 页面/页签清单与它们调用的 HTTP API

**主页面 `PurgePage`**：页签常量 `TABS`（`client.js:13328-13335`）
`status 状态`（宿主兼容/补丁/破甲自检）、`prompt 提示词`（注入正文与破甲强化段）、`rules 规则`（规则集与工作区策略）、`skills 技能`、`drill 演练台`（红队 + 环境适配）、`more 更多`（服务器名单、更新与维护）。
懒挂载：`visited` 记录已打开页签，未访问过的页签不渲染（`13476-13481`、`13559-13574`）；`status` 页签进入即 `GET /dsh-purge/status`（`13485`）。

**设置页 `SettingsRoot`**：`status/prompt/rules/skills/more` 五项导航（`client.js:13254-13272`），`more` 里给"打开演练台"按钮切到 `drill`（`13287-13299`），`drill` 条件渲染演练台 Panel 并内联挂它自带的 CSS（`13305-13322`）。

**演练台（vendored）页签**：`assets 资产测绘`、`env 环境适配`、`agents 智能体`、`sessions 会话隧道`、`findings 漏洞战果`、`chain 攻击链`、`scores 得分目标`、`report 报告`、`knowledge 知识库`、`skills 技能库`（`lib/redteam/client.js:4008-4014`），另有隐藏 `prompts` 分支复用 `AgentsTab`（`4042`），以及整窗模式 `#redteam-full`（`4015-4034`）。

**面板调用的接口与真实响应形状**（左侧为面板调用点，右侧为服务端 handler）：

| 端点 | 方法 | 请求体 / 参数 | 响应（可证字段） | 证据 |
|---|---|---|---|---|
| `/dsh-purge/status` | GET | — | `ai_base, surface, host_layout, asar_still_sealed, asar_handoff, patches_applied, patches_pending, patches_skipped, patches_ready, patches_na, patches_total, patches_total_all, patch_status, patch_files, patches[{id,ids,layer,status}], patch_names, shim_*, override_*, dsh_home, plugin_version, compatibility, asar…, skills[], …channelPublic()` | `lib/index.js:1945-2009` |
| `/dsh-purge/selfcheck` | GET | — | `{ok:true, ...selfCheck()}` → `layers[{title,state,ok,applicable,applied,required,pending[],note}]` | `lib/index.js:2043-2058` + 消费 `client.js:10334-10391` |
| `/dsh-purge/boost` | GET/POST | GET —；POST `{enabled}` 或 `{rewind}` | `{enabled, rewind}` / `{ok, enabled|rewind, restart_required:true}` | `lib/index.js:2059-2085`、`client.js:10311-10319` |
| `/dsh-purge/probe` | GET/POST | POST `{}` | `{ok, active, nonce}` / `{ok, nonce, message}` | `lib/index.js:2086-2106`、`client.js:10406-10411` |
| `/dsh-purge/audit` | GET | `?limit=n`（默认 20） | `{ok, entries[{at,event,pid,...}]}` | `lib/index.js:2107-2119`、`client.js:10862-10872` |
| `/dsh-purge/hooks-deny` | GET/POST | POST `{hooksDenyBypass:boolean}` | `{ok, hooksDenyBypass}`；非布尔 → 400 | `lib/index.js:2120-2150`、`client.js:11000+` |
| `/dsh-purge/override` | GET/POST | POST `{content:string}` | `{ok, content, defaultContent, customized, usingDefault, path, ...injectSnapshot}`；空正文 → 400 `needPrompt` | `lib/index.js:2466-2521` |
| `/dsh-purge/own-servers` | GET/POST | POST `{content:string}` | `{ok, content, dropped}` | `lib/index.js:2522-2549` |
| `/dsh-purge/apply` | POST | `{content?}` | `{ok, complete, failed, failed_items[], report[], host_written, hook_restore_failed, cmd_flash, cli_repair, asar_handoff…, needs_full_quit, applied, already}`；缺正文 → 400 `needPrompt` | `lib/index.js:2254-2395`、`client.js:11972-12044` |
| `/dsh-purge/revert` | POST | — | `{ok, reverted, errors, shim, note}` | `lib/index.js:2396-2419` |
| `/dsh-purge/uninstall` | POST | — | `{ok, surface, fullApp, cleanup[], note}` | `lib/index.js:2420-2448` |
| `/dsh-purge/restart` | POST | `{}` | `{ok, restarting, surface, manualQuit, error, pending[]}` | `lib/index.js:2552-2595`、`client.js:11163-11202` |
| `/dsh-purge/update` | GET/POST | POST `{ref?}` | `{ok, channel, versions[], localVersion, remoteVersion, hasUpdate, pinned, needRestart/restart_required, release{version}, cleanup_warnings[]}` | `lib/index.js:2227-2253`、`client.js:11388-11400` |
| `/dsh-purge/community` | GET/POST | POST `{op:"preferences"|"backup"|"rollback"|"prune"|"check"|"update", value|id|ref}` | GET `{name,version,repository,compatibility,profile,backups[],backup_usage,update_preferences,update_status}`；POST `{ok,...}` | `lib/index.js:1578-1605`、`client.js:10765-10834` |
| `/dsh-purge/rules` | prefix，GET/POST | `{op:"status"|"scan-cwd"|"toggle-cwd"|"set-policy"|"read"|"save"|"activate"|"delete"|"reset", id, content, cwd, target, policy}` | `{ok, rules[], active, ...}` | `lib/index.js:2832-2843` → `2628-2716`、`client.js:12409` |
| `/dsh-purge/skills`（`/skill` 兜底） | prefix，GET/POST | `{op:"status"|"read"|"save"|"delete"|"import", id, content, description, data(base64)|files[]}`，体积上限 14MB | `{ok, skills[]}` / `{ok, id, name, content, description,…}` | `lib/index.js:2814-2830` → `2739-2778`、`client.js:259-269` |
| `/dsh-purge/drill-grant` | GET/POST | POST `{}` | `{ok, granted,…}` | `lib/index.js:2449-2465`、`client.js:8986-9042` |
| `/dsh-purge/rewind` | GET/POST | GET `?sessionId`；POST `{sessionId, mode:"round"|"once"}` | `{ok, ...draft|pending}` / `result`（失败 409） | `lib/index.js:2187-2226` |
| `/dsh-purge/last-user` | GET | `?sessionId` | `{ok, text…}` | `lib/index.js:2151-2168` |
| `/redteam/api` | POST（唯一动作） | `{op:"assets"|"env"|"agents"|"sessions"|"findings"|"chain"|"scores"|"report"|"knowledge"|"skills"|"platformEnvAdaptStatus"|…}`，客户端全文共出现 51 个不同的 `op:"…"` 字面量（部分属于 `/dsh-purge/*` 调用点）；分派顺序 platform → agents → update → skill → dispatchAsync | `{ok,...}` | `lib/redteam/ui.js:1079-1150`、`client.js:828-850` |

**客户端网络层三个关键机制**（都被真实问题驱动过）：
1. **子路径部署**：`apiUrl()` 从 `document.currentScript.src` 找 `/plugins/` 前缀反推站点基址，避免请求打到根目录（`client.js:124-151`，对应 1.6.61 #106）。
2. **按端点分档超时**：`status` 60s、`apply` 240s、`community POST` 600s、`uninstall` 90s、默认 20s；abort 统一转成 `Error("timeout")`（`client.js:152-167`、`223`）。
3. **in-flight 去重**：只对无参 `GET /dsh-purge/status` 做单飞复用（`client.js:175-188`），其余端点不去重 → 设置页与主页同时挂载时会各自打一次。

## 数据流与状态

```
DSH 客户端加载 client.js → __ModuleLoader__.load(id, factory)
   ↓ apply(ctx): ctx.effect(legacy visibility) → inject(sessions/uiWorkspace) → inject(remote.agentPresets)
   ↓ ctx.effect(startGrantSync)  —— GET /dsh-purge/drill-grant，失败重试 5×400ms
   ↓ ctx.effect(ctx.locale.register(NS,{zh,en})) → t = ctx.locale.bind(NS) → setTranslate(t)
   ↓ ctx.slots.inject ×4（shell.overlay / sidebar.panellist / main / plugins.bundle.config）
   ↓ inject(["sessions","uiWorkspace","conversation"]) → slots.inject("conversation.input.right")
```

- **全局可变单例**：`translate`（`client.js:9119-9125`）、`dockBus` + `listeners`（`9044-9065`）、`drillGrantState`、`nativeSidebar = null`（`9112`，全文件再无赋值 —— 侧栏 `openTab` 联动是空实现，`9053-9058`）。
- **状态回落语义**：接口失败被折叠成 `unavailableStatus(error) → {ok:false,error}`（`189-194`），页面再按 `info.ok === false` 显示"状态读取失败：…当前宿主与补丁状态未知"（`13457-13464`），不把失败当空值。
- **轮询**：只有换包进行中才每 2s 拉 status，条件为 `asar_handoff.phase ∈ {starting, ready, waiting_for_quit, waiting_for_unlock, moving}`（`client.js:13487-13499`）；selfcheck 只在挂载时拉一次（`10308-10310`），靠"重测"按钮手动刷新（`10324-10333`）。
- **写入即重读**：维护类操作成功后统一 `load()` 重拉列表而不是本地拼状态（`10830`）；规则/技能操作成功后 `loadStatus()`（`12414`、`12858`）。
- **重启后自愈**：`waitForRestart()` 每 500ms ping status，见过一次失败（`sawDown`）再见到 `ok && ready !== false` 才 `location.reload()`，上限 90s（`client.js:11113-11141`）。
- **主题**：`detectHostTheme()` 读 `documentElement` 的 `data-ds-dark-theme`/`color-scheme`/`prefers-color-scheme`，产出 `white|dusk`（`11204-11220`）。

## 真实能力清单

| 能力 | 入口 | 实现位置 | 真实现 | 证据 |
|---|---|---|---|---|
| 整页面板（6 tab） | 左侧栏 `Purge` → `main` | `client.js:13327-13608` | 是 | `TABS` 13328-13335；懒挂载 13559-13574 |
| 插件设置页（5 tab） | 插件详情 → `plugins.bundle.config` | `client.js:13222-13325` | 是 | 13254-13284 |
| 侧栏图标入口 | `sidebar.panellist` | `client.js:15050-15062` | 是 | label `Purge` |
| 补丁逐条状态 + 分组计数 | 状态 → 补丁明细 | `client.js:10120-10218` | 是 | `patch_status`/`patch_files` 消费于 10083-10210 |
| 单条补丁 部分命中 明细（n/m 目标） | 同上 | `client.js:10201-10210` | 是 | `status.partialDetail` |
| 破甲自检逐层（含 不适用/宿主推导/未确认） | 状态 → 破甲自检 | `client.js:10299-10442` | 是 | 层状态映射 10334-10391 |
| 一次性探针 | 状态 → 探针按钮 | `client.js:10399-10418` | 是 | POST probe 10406 |
| 强化段开关 | 状态 → 破甲强化段 | `client.js:10420-10440` | 是 | GET/POST boost 10304-10322 |
| 提示词正文编辑/保存 | 提示词 tab | `client.js:11288+`（PurgifySection）| 是 | `/override` GET/POST 2470-2516 |
| 规则集 CRUD + 激活 + 工作区策略 + cwd 扫描 | 规则 tab | `client.js:12361-12788` | 是 | `handleRulesOp` 2628-2716 |
| 技能库 CRUD + zip/文件夹导入 | 技能 tab | `client.js:12803-13176` | 是（带版本门禁） | 12790-12802、12898-12920 |
| 演练台（10 tab） | 演练台 tab / 独立窗 `#redteam-full` | `client.js:271-8957`（vendor） | 是 | `lib/redteam/client.js:4008-4014` |
| 演练台授权门禁（10s 倒计时 + 滚到底 + 3 勾选） | 首次进演练台 | `client.js:9894-10047` | 是 | 授权写 localStorage + 服务端 grant 双写 8980-8997 |
| 环境适配发送门禁 | 发送前（shell.overlay） | `client.js:14736-14980` | 是 | `platformEnvAdaptStatus` 14704-14708 |
| 回退（回填上一句） | 输入框右侧按钮 | `client.js:13722-14490` | 是 | slot `conversation.input.right` 14476-14487 |
| 更新检查/选版本安装/通道（代理·镜像·token） | 更多/设置 → 维护 | `client.js:10473-10660`、`10759-10968` | 是 | POST `/community` op=preferences/check/update 10489-10493、10807-10811 |
| 本机备份列表/回滚/清理 | 维护 | `client.js:10911-10954` | 是 | listState 状态机 10761-10783 |
| 卸载（二次确认） | 状态 → 卸载 | `client.js:12020-12028` | 是 | POST `/uninstall` |
| 宿主换包阶段展示（15 种 phase 文案） | 状态 → LayoutNotice | `client.js:13408-13456` | 是 | phase 字典 13419 |
| 版本不一致提示（界面 vs 后端） | 状态 → VersionNotice | `client.js:13457-13472` | 是 | 但界面上限被硬编码为 `1.6.91`（13470） |
| 锚点漂移诊断 UI | — | — | **否** | `GET /dsh-purge/diagnose`（`lib/index.js:2010-2042`）在 client.js 中 **0 引用** |
| 回退候选分析 UI（rewind options） | — | — | **否** | `/dsh-purge/rewind/options`（`lib/index.js:2169-2186`）在 client.js 中 0 引用 |

## 依赖与耦合

1. **宿主客户端包**：6 个 `@deepseek-ai/dsh-client-*`（`package.json:89-96`）。宿主侧任一包改名/移除，`apply()` 里对应的 `ctx.inject([...])` 就静默不执行。
2. **Cordis 契约**：`ctx.slots.inject(name, fn)` + `ctx.slots.register({name,id,key,order,label,inject}, Component)`（`client.js:15039-15084`）；`ctx.locale.register/bind`（`15036-15037`）；`ctx.effect(fn, label)`（`15020`）；`ctx.inject([...], cb)`（`15021`）。宿主 slot 名就是硬编码字符串，无版本协商。
3. **宿主状态仓库**：`sessions.list.getSnapshot()`、`uiWorkspace.selection.getSnapshot()`、`sessions.scope()`/`sessionOf()`（`client.js:12302-12352`）；`conversation`（回退）与 `remote.agentPresets.list()`（预设菜单，`15026-15029`）。这些是未公开文档的内部结构，`readSessionCwd` 写了三层回退（`projectionValues.cwd → sess.cwd → header.cwd`，`12314-12331`）。
4. **HTTP 面耦合**：21 条 `/dsh-purge/*` + `/redteam/api`。服务端注册依赖宿主 `webServer.register({kind:"exact"|"prefix", path, handler})` 返回 disposer（`lib/index.js:2858-2872`），全部包在 `host.effect(() => {...})` 里以便重载时撤销（`1930-1944`）。
5. **浏览器 API 依赖**：`localStorage`（`8959-8979`）、`sessionStorage`（`13726-13742`）、`document.head` 样式注入（`13715`、`13310`）、`<dialog>.showModal()`（`14717-14719`）、`react-dom.createPortal`（`11103-11105`、`14150`）、`window.confirm/alert`（`10795-10802`、`241`）。
6. **样式耦合宿主 token**：`--dsw-alias-*`（`client.js:51`、`57`）、`body[data-ds-dark-theme]`（`14076`）。宿主改 token 名 → 面板配色塌陷。
7. **构建期耦合**：版本号写死在产物里（`13247`、`13404`、`13470`、`13520`），与 `package.json:3` 只能靠发版时人工同步（`AGENTS.md` §10 要求 `check:docs` 校验，但本包内 `scripts/check-docs.mjs` 依赖的 `test/` 缺失）。

## 局限与缺陷（带证据）

1. **不可重建**：`packages/purge-panel`、`src/`、`test/` 全部缺失，`build:client`/`test:ui`/`check:client` 三条 npm script 直接失效（`package.json:43,46,47`）；`npm test` 引用的 70+ 个 `test/*.mjs` 也不存在（`package.json:45`）。改一个文案都要手改 662KB 产物。
2. **两条死构建脚本仍在发行包里**：`patch-client-dock.mjs` 与本包 `client.js` 不兼容（实测 `382` 行抛 `installRewindUi not found`），`build-client.mjs` 抛缺 marker（`build-client.mjs:66-67` 实测）。它们保留着 1.1.x 的 `PURGE_CSS`/`REWIND_CSS`/dock 假设（`patch-client-dock.mjs:129-134`），是纯粹的误导源。
3. **单文件巨石**：662,513 B / 15,088 行，其中 vendored 演练台占 339,616 B（**51.3%**，`client.js:271-8957`）；CSS 以巨型单行字符串内联（`base.css` 27,141 B 一行 = `51`，`page.css` 16,328 B = `57`），无 sourcemap、无模块边界、无 tree-shaking。
4. **状态色板不完整**：`statusKind()` 会返回 `"muted"`（`client.js:10055`，用于 `disabled` 可选关闭），但 CSS 只定义了 `is-ok/is-wait/is-miss/is-bad`（`client.js:51`，实测 `.dshpp-pill.is-muted` 无规则）→ 「可选关闭」胶囊无专用配色，与 `is-miss` 之外的状态无法区分。
5. **诊断能力在后端有、前端无**：`/dsh-purge/diagnose` 返回 `drifted/optionalDrift/chained/missing`（`lib/index.js:2030-2037`），client.js 0 引用；用户只能从补丁行的 `drifted` 胶囊间接感知漂移，看不到锚点行号与候选片段。
6. **i18n 半成品**：`NS` 与字典齐全（`client.js:9118`、`9131-9510` zh、`9511-9891` en），但大量中文直接写死在 JSX 里：主页页签标签（`13329-13334`）、破甲自检文案（`10359-10417`）、hero 提示（`12042`）、维护提示（`10452-10471`）、`notice` 文案（`10319`）；`en` 字典缺键时 `t()` 原样返回 key（`10296`），所以英文环境会出现裸 key。
7. **重复挂载导致重复请求**：`PurgifySection` 同时被主页（`13552`）和设置页（`13280`）安装，`CommunityMaintenance` 同理（`13554` / `13276`）；只有 `GET /status` 做了去重（`179-187`），`/community`、`/selfcheck` 会各打一次（`13183`、`10305`）。
8. **死代码与不可达分支**：`CompatibilityNote` 首行 `if (true) return h(CommunityCompatibilityNote);`（`13207`）使其后十余行（`13208-13221`）永不可达；`beta` 通道选版逻辑仍在（`11338-11344`）但被 `keepListedVersion` 全部过滤（`11262-11266`）；locale 里 `dock.clean/dock.close/auth.*`（`9133-9166`）对应的 `PurgeDock` 已不存在，`t("dock.*")` 0 调用点。
9. **授权双源真相**：授权同时写 `localStorage` 与服务端 grant（`8964-8997`），同步失败会 5 次重试后放行本地值（`9036-9041`）——服务端撤销授权后，本地仍可能保持已授权状态直到下次 `syncDrillGrant`。
10. **演练台 CSS 挂载点分散**：主页内联（`13579`）与设置页内联（`13310`）两处条件挂 `<style data-dsh-purge-drill>`，源注释自承"旧版由 dock 注入 `<head>`，重构时丢了，结果面板完全没样式"（`13308-13309`）——同类回归容易再犯。
11. **版本号硬编码三处**：`13247`（设置页徽标）、`13404`（`StatusStrip` 兜底）、`13470`（不一致提示的"界面 1.6.91"）、`13520`（页面副标题）。发版漏改会导致"界面版本 ≠ 后端版本"提示自身错乱。
12. **交互一致性**：回滚/更新用 `window.confirm` 原生弹窗（`10795-10802`），卸载用自绘确认态（`12025`），重启用 `react-dom` portal 弹窗（`11102-11109`）——三套确认交互并存。
13. **预览资产过期**：`screenshots.json`（`screenshots.json:2-8`）与 `docs/preview/settings.png` 仍是 1.1.x 形态（指标卡 `31/32`、`提示词 8/9`），而 `docs/preview/next-host/01-status.png` 已是 1.6.67 的 StatusStrip + 6 tab 形态；`docs/banner.svg` 只是仓库横幅（`docs/banner.svg:1`），与面板无关。截图与真实 UI 不同源。

## 对 Purge+ 的启示

**值得原样继承（信息架构与词汇表，可直接复用）**

1. **5 槽位挂载模型**：侧栏图标（`sidebar.panellist`）+ 整页（`main`）+ 设置页（插件 config 槽）+ 覆盖层弹窗（`shell.overlay`）+ 输入框内联按钮（`conversation.input.right`）。这是"重型面板 + 轻量入口"的正确切分。
2. **6 页签 IA**：`状态 / 提示词 / 规则 / 技能 / 演练台 / 更多`（`13328-13335`），以及设置页同名 5 页签 + 演练台入口（`13254-13299`）。页签名即用户心智模型，无需重设计。
3. **补丁状态词汇表**（最有价值的可复用资产，`client.js:10049-10074`）：
   - 原始态：`applied | already | pending | unmatched | partial | drifted | disabled | skipped | missing_file | unlocated | na | off`
   - 呈现类：`ok | wait | bad | miss | muted`
   - 中文标签：`已应用 / 待应用 / 没对上 / 部分命中 / 锚点漂移 / 可选关闭 / 跳过 / 未定位 / 本端不需要 / 已关闭`
   - 分档规则：`applied|already|na → ok`；`pending → wait`；`unmatched|partial|drifted → bad`；`disabled → muted`；`missing_file|skipped|unlocated|off → miss`；其余 → `bad`（兜底严格）。
4. **自检层词汇表**：`ok / pending / inferred（宿主推导）/ unknown（未确认）/ broken`，外加 `applicable:false → 不适用`（`10334-10391`）；聚合文案公式 `N 层未生效 / N 条待应用 / N 层需确认 / N 层全部在位 / 检测中…`，且明确"pending 不是故障"。
5. **计数口径三件套**：`patches_applied / patches_total`（分母只算本机适用）+ `patches_na`（目标插件未装）+ `patches_total_all`（全量），并在 UI 上并列显示（`13387-13399`）。这套分母语义要保留，否则状态页永远"假绿"或"假红"。
6. **换包 phase 枚举 + 人话映射**：`not_scheduled / unknown_target / unreadable / starting / ready / waiting_for_quit / waiting_for_unlock / moving / complete / already_unsealed / archive_reappeared / backup_missing / failed / expired / helper_stopped`（`13419`），并区分"未安排"≠"等待"、"磁盘已写"≠"进程已加载"。
7. **"失败不伪装成空"**：`listState = loading|ready|error`（`10761-10783`）与 `unavailableStatus`（`189-194`）的写法直接沿用。
8. **重启自愈轮询**：`sawDown → ok&&ready → reload`，90s 上限（`11113-11141`）。

**必须重构/替换**

1. **构建模型**：废弃"字符串切割 + 标记注入 + 手改产物"（`patch-client-dock.mjs`、`build-client.mjs`），改为仓库内可复现的 ESM 源码 + 标准打包器（Vite/esbuild 配置入库），产物只由 CI 生成；`src/` 与 `test/` 必须随发行物或至少随源码仓库同版本可用。
2. **单文件巨石**：拆成多个 chunk，并把演练台（51.3%）做成**懒加载独立 chunk**（它只在 `drill` 页签需要）；CSS 抽成真实 `.css` 资产而不是 27KB 单行字符串（`51`/`57`）。
3. **i18n**：把全局 `translate` 单例（`9119-9125`）换成 React context/provider；`t` 缺键必须回退到 zh 而非裸 key（`10296` 现状）；把写死中文全部搬进字典。
4. **设计令牌**：给 `muted` 补真实样式（`10055` vs `51`），把 `ok/wait/bad/miss/muted` 五态在胶囊、圆点、行三处统一；把 3 套确认交互（confirm/自绘态/portal 弹窗）收敛成一套 Dialog 组件。
5. **版本单一来源**：`1.6.91` 四处硬编码（`13247/13404/13470/13520`）改为从 `plugin_version` 或构建期注入常量读取；"界面版本 ≠ 后端版本"提示逻辑可保留，但比较基准不能写死。
6. **数据层**：引入统一 query 缓存（同 key 去重 + 失效重取），消除主页/设置页重复挂载造成的重复请求（`13552` vs `13280`、`13183`、`10305`）；保留现有"写后重读"策略（`10830`、`12414`）。
7. **补上缺失的 UI**：把 `/dsh-purge/diagnose` 的 `drifted/optionalDrift/chained/missing`（`lib/index.js:2030-2037`）做成"锚点漂移"页/抽屉，展示文件、行号、候选片段；把 `patch_files` 做成补丁行可展开的逐文件表（数据已返回，`lib/index.js:1980`，UI 只在 `partial` 时用了计数）。
8. **授权单一真相**：服务端 grant 为唯一权威，`localStorage` 只做离线提示缓存，撤销后必须立刻失效（改 `8964-9042`）。

**一句话结论**：这套 UI 的**信息架构、状态词汇、计数口径和"不假装成功"的表达习惯**是它真正的资产；**构建方式（切割注入 + 662KB 单文件 + 手写死版本号）是必须整体替换的负债**。Purge+ 应该照抄它的词汇表，重写它的流水线。
