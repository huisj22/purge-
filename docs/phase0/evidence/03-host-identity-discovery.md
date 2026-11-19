# 03 · 宿主发现与实例身份（host discovery / instance identity）

> 目标项目：`dsh-purge-community` v1.6.91（ESM / Cordis 插件）
> 项目根：`D:\Purge+\_research\orig-zip\dsh-purge-一键安装包\dsh-purge-install-kit\pkg\plugin-copy\dsh-purge-community`
> 切片文件：`lib/instance.js`、`lib/surface.js`、`lib/host.js`、`lib/host-layout.js`、`lib/runtime-layout.js`、`lib/path-boundary.js`、`lib/desktop-identity.js`、`lib/desktop-entry.js`、`lib/desktop-read-scope.js`、`lib/next-host.js`、`lib/official-update.js`、`lib/web.js`、`lib/identity.js`
> 全部结论以实际读取的源码为准，只读，未改动原项目。

## 职责

这一层负责回答四个问题，并把答案压缩成一个「宿主描述对象」供补丁引擎、自检、面板、CLI 共用：

1. **这是哪个安装？** 从显式选择器（`DSH_BASE` / `PURGE_DSH_CLI`）或当前进程入口（`argv[1]`、`--app-path`、Electron `app.getAppPath()`）反推出 `@deepseek-ai` 插件根，绝不扫 PATH / 家目录 / 邻装（`lib/instance.js:256-260` 的注释即契约）。
2. **它是什么形态？** Electron 桌面（`resources/app.asar` 封包 / `resources/app` 解包 / `app.asar.unpacked` 旁路）、npm/Node Web 宿主、Tauri 托管归档、第三方 NEXT 壳。
3. **它属于哪个家族、版本是否被逐条回归过？** `compatibility()` 把「内核版本命中清单」与「桌面壳家族被验证过」拆成两层（`lib/community.js:109-145`）。
4. **磁盘状态与已加载状态是否一致？** `hostLayoutEvidence()` 只回答「当前进程的启动入口指向哪」，并显式声明这不等于磁盘内容已被加载（`lib/host-layout.js:2,121-128`）。

**重要更正**：本切片名单里的 `lib/identity.js`（985 行 / 42KB）与宿主发现**无关**。它对 `process.env` / `node:fs` / `resourcesPath` / `DSH_BASE` / `aiBase` 的引用数为 **0**（grep 全文无匹配），内容是 **agent 人格身份**的手术刀：剥掉官方身份句（`lib/identity.js:106-190`）、置顶注入段（`lib/identity.js:330-380`）、ChatML/项目标签信封修复（`lib/identity.js:44-67`）。宿主身份实际住在 `lib/instance.js` + `lib/desktop.js`。这是「同名词不同义」的真实命门，重实现必须换名。

## 关键实现（带 file:line 证据）

### (a) 如何找到 DSH 安装：候选清单与顺序

三层，越靠前越「显式」，越靠后越「启发式」：

**(1) 显式选择器（最强）** — `currentHost()` 顺序固定：
```
options.aiBase → env.DSH_BASE → env.PURGE_DSH_CLI → packageAbove(argv[1]) → ""
```
证据：`lib/instance.js:227-254`。`PURGE_DSH_CLI` 分支专门处理 Desktop 随包启动器 `resources/runtime/cli/bin/dsh`，在 `app.asar` → `app.asar.unpacked` → `app` 三个 layout 里找 `dsh/node_modules/@deepseek-ai`（`lib/instance.js:236-249`）。

**(2) 进程入口反推**：`packageAbove()` 从 `argv[1]` 向上最多爬 8 层，只认 `name ∈ {@deepseek-ai/dsh, @deepseek-ai/dsh-desktop-host}` 的 `package.json`（`lib/instance.js:128-148`）；`installationOf()` 再区分「发布安装用 scope 目录」与「workspace link 用 apps/cli」（`lib/instance.js:151-158`）。

**(3) Electron 桌面兜底**（只在当前进程确认是打包 Electron 时启用）：`diagnosticHost()` 在 `!selected` 分支要求 `process.versions.electron` + `process.resourcesPath` 是绝对路径 + `desktopIdentity(resources)` 有包证据，然后按 `app` → `app.asar.unpacked` 顺序检查（`lib/instance.js:334-379`）。关键判定：**`app.asar` 仍在时，`app.asar.unpacked` 只是原生模块旁路，不是宿主**（`lib/instance.js:351-359`）。

**桌面安装根候选（`commonDesktopInstallDirs`）**跨平台写死，`lib/desktop.js:499-532`：
- Windows：`%LOCALAPPDATA%\Programs\DeepSeek Harness`、`...\Programs\DSH Desktop`、`%LOCALAPPDATA%\DeepSeek Harness`、`%ProgramFiles%\{DeepSeek Harness, DSH Desktop}`、`%ProgramFiles(x86)%\...`（`lib/desktop.js:509-517`）
- macOS：`/Applications/DeepSeek Harness.app`、`/Applications/DSH Desktop.app`、`~/Applications/...`（`:518-521`）
- Linux：`/opt/DeepSeek Harness`、`/opt/deepseek-harness`、`/usr/lib/...`、`/usr/share/deepseek-harness`、`~/.local/share/...`、`/opt/DSH Desktop`、`/usr/lib/dsh-desktop`（`:522-530`）
- 前置插入：`DSH_DESKTOP_INSTALL` 环境变量（按 `path.delimiter` 切分，`:291-296`，需 `trustedInstallDir` 校验 `:298-308`）
- **只有 `discover === true`** 才追加注册表卸载登记（`lib/desktop.js:347-382`，PowerShell 15s 超时）与「正在运行的官方 exe / 快捷方式」（`:393-480`、`:490-496`）。默认路径**不碰**注册表和进程枚举（`:498` 注释、`:624`）。

**resources 目录推导**是纯结构式的，不看安装目录名：`resourceDirCandidates()` 按 basename 判断 `macos` → `../Resources`+`../resources`；`contents` → `Resources`+`resources`；`*.app` → `Contents/Resources`；`resources` → 自身；否则 `resources`+`Resources`（`lib/desktop.js:183-201`）。`resourcesDirForExecutable()` 优先「真存在 `app.asar` 的那个」，其次「存在的目录」，最后才用首选名（`:204-213`）——即 asar 存在性优先于目录命名。

**路径 → 安装根的反推**：`inferDesktopInstallDir()` 只认三个结构标记 `/resources/app.asar.unpacked/`、`/resources/app/`、`/contents/resources/`（`lib/desktop.js:274-289`）。`APP_SCRIPT_RE = /(desktop-cli|host-process-entry)\.js$/i`（`:261`）允许从 argv 里的宿主脚本反推 `lib/app/resources/install` 四层（`:263-271`）。

**插件根本身如何算「可用」**：`probeAiBase()` 要求 `<base>/dsh-agent-instructions/lib` 是目录；只有 `ENOENT/ENOTDIR` 算「缺席」，`EACCES/EIO` 必须把错误码带出去（`lib/instance.js:164-184`）。

### (b) currentHost() vs diagnosticHost() vs normalizeHostBase()

| 函数 | 语义 | 证据 |
| --- | --- | --- |
| `currentHost()` | **安装定位 / 启动语义**。回答「应该对哪一份安装负责」，给 installer、CLI launcher、`Maintenance` 用 | `lib/instance.js:227-254`；消费点 `lib/index.js:1577`、`lib/update.js:885`、`bin/community.js:22` |
| `diagnosticHost()` | **组件检查语义**。把选中的安装映射到「物理上可读的插件根」，`app.asar` 入口会被改写成 `resources/app` 或 `app.asar.unpacked` | `lib/instance.js:328-399`；注释 `:328-330` 明确「保持 currentHost 不变，它还给 installer/CLI 用」 |
| `normalizeHostBase()` | **形状归一**。只认 3 种已知嵌套：`start`、`start/node_modules/@deepseek-ai`、`start/dsh/node_modules/@deepseek-ai` | `lib/instance.js:208-225` |

为什么必须两个都存在（源码里已写明理由，`lib/instance.js:304-309`）：`DSH_BASE` 若指向归档内的宿主，直接 `describe(raw)` 会让 `status/diagnose` 读 `app.asar`、而 `selfcheck` 读物理 `app/`，**两套依据互相打架**。所以 `resolveInstance()` 用 `pinned()` 先过一遍 `diagnosticHost({aiBase: raw})` 再描述（`:308-319`）。同时 `normalizeHostBase` 刻意**不要求组件齐全**：只要 `dsh-agent-loop` / `dsh-system-prompt` / `dsh-agent-instructions` 任一有 `package.json` 就锁定该根，缺件由上层报错（`:216-223` 注释：「Requiring all components here would hide missing files behind another root」）。

`diagnosticHost()` 的 sealed 归档改写规则（`:380-398`）：命中 `^(.*/resources)/app\.asar/((?:dsh/)?node_modules/@deepseek-ai)$` 后，在 `app` / `app.asar.unpacked` 中取**第一个存在的根**，且「残缺的 app 目录不得被更健康的兄弟目录顶替」（`:385-395`），两端都不存在时返回 `app/...` 的预期路径，让上层继续报缺件（`:396-398`）。

### (c) hostSurface / detectSurface：desktop vs web 及其行为后果

`detectSurface()`：`DSH_SURFACE` 强制优先（`desktop|web|gui|tui`，`lib/surface.js:77-83`）；否则 `isDesktopSurface()` 判定，最终回退 `web`。`adapterFor()` 把 `gui/tui` 都折叠到 `web`（`:86-88`）。

`isDesktopSurface()` 的判据是**resources 里有桌面包身份**，不是 exe 名字：`resourcesLookLikeDesktopInstall = hasDesktopIdentity(resources)`（`lib/surface.js:58-60`），而 `hasDesktopIdentity` 读 asar 或解包目录里的真实 `package.json`（`lib/desktop-identity.js:101-103`）。`pathLooksDesktop()` 仍是名字启发式（`lib/surface.js:16-40`），但**不再参与 surface 判定**，只在别处当辅助。

`hostSurface(host)` 是另一条判据，基于插件根路径形状（`lib/instance.js:196-203`）：
- 正则 `^(.*/resources)/(app|app.asar|app.asar.unpacked)/(dsh/)?node_modules/@deepseek-ai$` 命中 → `desktop`
- 否则若 `host/{dsh,dsh-agent-loop,dsh-system-prompt}/package.json` 存在 → `web`
- 否则 `unknown`

**surface 改变什么**（全部有据）：
- 补丁目标白名单：桌面只许动「本机桌面树 + 桌面 profile + shared」，Web 反过来禁止桌面树（`lib/core.js:934-950`）。`pathZone()` 用 `/profiles/desktop/`、`/profiles/web/`、`/npm-global` 切分（`:924-932`）。
- 密封换包：`sealedAsarHandoff()` 非桌面直接返回 `null`（`lib/core.js:1947-1949`），跨面场景由 `sealedDesktopHandoffAnySurface()` 强制 `surface:"desktop"` 兜底（`:2246-2252`）。
- 启动自愈：桌面不重启不杀进程（`lib/settle-policy.js:32-43`），桌面 settle 延迟 4000ms（`:3,28-30`）。
- 重启路径：`hostAdapter()` 选 `desktop.js` / `web.js` 两套实现（`lib/host.js:5-16`）。
- shim 补丁：桌面跳过（`lib/index.js:947-948`）。
- 自检布局层：`web` 直接判 `na`，`unknown` 判 `unknown`（`lib/selfcheck.js:184-196`）。

### (d) profile 与 DSH_HOME 解析

`resolveProfile(home, {env, argv, reader, profile})` 的优先级严格有序（`lib/instance.js:39-125`）：
1. 显式 `profile` 参数（绝对路径或名字）→ 2. `PURGE_PROFILE_DIR` → 3. argv 中**父目录 realpath 等于 `<home>/profiles`** 的绝对路径（多个直接抛错）→ 4. argv 中形如 `.../profiles/<x>` 但不属于当前 home → **抛错，不换目录**（`:67-78`）→ 5. `--profile` / `--profile=`（多个抛错）→ 6. `dsh web` / `dsh <profile>` 位置简写，**但必须先验证 argv[1] 确实是 `@deepseek-ai/dsh` 的 bin**（`:91-104`）→ 7. `DSH_PROFILE` → 8. `profiles/` 下唯一一个含 `package.json` 的目录 → 9. `null` 抛错。
profile 名受 `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` 约束（`:22-26`）。名字里 `desktop` / `web` 的语义差异只体现在 `pathZone()`（`lib/core.js:928-929`）和桌面重启用 `DSH_PROFILE=desktop` 默认值（`lib/restart-desktop.js:40`）。

`findDshHome()`（`lib/core.js:1625-1652`）路径：
```
DSH_HOME → [desktop: desktopHomeCandidates() 里含 harness 数据的] → ~/.dsh(含数据)
        → [web: portableHomeFromLauncher(shimDir, prefix)] → ~/.dsh → WSL /mnt/c/Users/*/.dsh → ~/.dsh
```
`isDshHomeDir()` 只认 basename 为 `.dsh` 或 `dsh-home`（`:1545-1549`）；`homeHasHarnessData()` 认 `prompt-inject.md` / `profiles/` / `cordis.patch.yml` 任一（`:1551-1556`）。桌面候选来自 exe 所在目录、`process.resourcesPath` 的父目录、`listDesktopInstallRoots()`、以及按平台的 `desktopDshHomeGuesses()`（macOS `~/Library/Application Support/DeepSeek Harness/dsh-home`；Windows `%APPDATA%`/`%LOCALAPPDATA%\DeepSeek Harness\dsh-home`；**Linux 返回空数组**）（`:1558-1621`）。`findWslWindowsDshHome()` 只在 Linux 且存在 `/mnt/c/Users` 时扫 Windows 用户目录（`:1654-1672`）。

### (e) 版本检测、hostFamilyOf、兼容矩阵

- `readVersion(reader, aiBase, pkg)` 直接读 `<aiBase>/<pkg>/package.json` 的 `version`，失败返回空串（`lib/community.js:83-91`）。`version` 取 `dsh-agent-loop`，`promptVersion` 取 `dsh-system-prompt`（`:125-126`）。
- sealed 归档里读不到物理文件时，走 `sealedHostEvidence()` 直接解析 asar 头部拿版本（`lib/desktop-identity.js:117-130`）。
- `QUALIFIED_HOST_VERSIONS = ["0.2.2-rc.1","0.2.1-rc.1","0.2.1-rc.2","0.2.1-rc.3","0.2.1-rc.5"]`（`lib/community.js:81`），注释要求「新增条目必须同时提供原始宿主源码回归证据」（`:73-80`）。
- `hostFamilyOf(aiBase)`：`desktopResourcesForHost()` 拿不到 resources 就返回空串；否则返回 `desktopIdentity(resources).kind`，异常返回空串（`lib/community.js:93-102`）。
- 判定拆两层（`:138-149`）：
  - `kernelQualified = !mixed && version && version===promptVersion && QUALIFIED_HOST_VERSIONS.includes(version)`
  - `familyQualified = family !== "next" && family !== "bundled-cli"`
  - `qualified = kernelQualified && familyQualified`
  - `level ∈ {mixed, sealed, no-host, qualified, kernel-verified, unverified}`（`:165-174`）
  - **写入闸门只有** `patchWritesAllowed = layout && !sealed`（`:148`）——版本未知、家族未验证都**不阻断**写入（`:104-113` 注释即设计声明）。`requirePatchCompatibility()` 只在「找不到宿主」和「归档仍封着」抛错（`:191-199`）。

### (f) 运行进程身份：pid / entry_layout / matches_target / 磁盘≠已加载

`hostLayoutEvidence(host, options)`（`lib/host-layout.js:25-136`）：
- 桌面磁盘证据：`archive_exists = statSync(resources/app.asar).isFile()`、`unpacked_exists = statSync(resources/app).isDirectory()`（`:73-76`）。
- 进程入口证据来源顺序：`--app-path=` → `--app-path <v>` → `argv[1]`（非 `-` 开头）→ `app.getAppPath()`（仅当 `process.versions.electron && process.type === "browser"`）（`:79-102`）。**绝不遍历全部 argv**，理由写在 `:77-78`（提示词/文件参数不是入口证据）。
- `layout`：入口命中 `^(.*/resources)/(app\.asar|app\.asar\.unpacked|app)(/|$)`，`app.asar` → `archive`，其余 → `unpacked`（`:103-107`）；`matches_target = normalize(match[1]) === normalize(resources)`，Windows 下转小写（`:108-114`）。
- `state` 优先级：`errors → unreadable` › `matches_target===false → different_instance` › `layout unknown → unknown_runtime` › `!resources → unknown_target` › `archive_entry` / `unpacked_entry`（`:116-120`），每个 state 都配一句「不能据此证明已加载」的说明（`:121-128`）。
- Tauri 分支更早返回：入口匹配 `dsh-tauri/dependencies/dsh/deepseek-harness-pkg-(windows|macos-*)\.asar/node_modules/@deepseek-ai/dsh/lib/bin.js`，且平台与归档后缀一致才认（`:47-49`）；随后**用宿主自己的虚拟 FS** 读归档里的 `package.json`（`name==="@deepseek-ai/dsh"`、`bin ∈ {lib/bin.js, ./lib/bin.js}`、`lib/bin.js` 是文件，`lib/host-layout.js:12-23`），state 为 `managed_archive_entry | cli_unverified | archive_missing | different_instance | unreadable`（`:59-62`）。
- 「磁盘 ≠ 已加载」被写成制度：`hostLayoutLayer()` 注释「仅检查目标磁盘的 app.asar，不证明当前进程加载来源」（`lib/selfcheck.js:195`）；AGENTS §19/§25 也要求调用方必须读 `state` 而非退出码。

### (g) 路径安全（path-boundary.js）与 Windows junction/symlink

`within(root, target)`：`path.relative` 为空串或非绝对且不以 `..` 开头（`lib/path-boundary.js:5-8`）。
`realDestination(target)`：从目标逐级向上 `lstat`，遇到 `ENOENT` 记录缺失段，直到能解析的一级，再 `realpathSync` 拼回缺失段（`:10-30`）；**悬空链接不被当成缺失目录**，`realpathSync` 必须显式失败（`:24-28` 及 `:26` 的 `ENOTDIR`）。
`assertWithinRoots(target, allowedRoots)`：先做**字面** `within` 过滤，再对目标与每个候选根各自 `realDestination` 后比较（`:32-42`）；拒绝非法字符串与 `\0`（`:33`）。
`assertNoLinkedDescendants(root, target)`：逐级 `lstat`，任一级是符号链接即抛错，**即使链接指向内部也不放行**（`:44-57`）。被解包/审计路径大量使用（`lib/extract-asar.js:324-332,468-496`、`lib/redteam/store-core.js:972-975`）。

Windows 上的 junction 处理集中在三处：
- **创建**：`ensureAppRuntimeLink()` 在 win32 传 **绝对目标** 的 `junction`，非 Windows 传相对 `dir` 链接，注释明确「Windows junction targets resolve against cwd, not the link's parent」（`lib/runtime-layout.js:76-80`）；成功后必须 `canonical(link) === canonical(target)` 且 `link/primary-runtime/.../pnpm.mjs` 是文件才认成功（`:79`）。
- **不覆盖活链接**：已存在真实目录 → 完整则 `already`，不完整则 `runtime_conflict` 保留（`:32-36`）；已存在链接指向别处 → 只有「同安装 runtime → 架构子目录」这一种已知迁移，且需两侧 realpath 都在安装内（`:49-63`）。
- **删除**：`removeTreeNoFollowSync()` 先 `lstat`，符号链接（含 junction）只 `unlink` 本体，目录用非递归 `rmdir`，**没有原生 recursive rm 回退**（`lib/remove-tree.js:15-29`，注释 `:21` 说明「never stat / realpath a deletion target」）。
- 另有一层「asar 内路径不可写」判定：路径任一段以 `.asar` 结尾但非 `.asar.unpacked` → 视为 sealed（`lib/desktop.js:56-63`），`isFile/isDir` 直接返回 false。

### (h) NEXT 家族如何被识别

`lib/next-host.js` 三件事：
- `NEXT_FAMILY = {id:"dsh-desktop-next", product:"DSH NEXT", qualified:false}`（`:13-18`）。
- `isNextPackage(meta)` 只看 `meta.name === "dsh-desktop-next"`，**明确不看 exe 文件名**（`:5-6,21-23`）；`nextIdentity()` 输出 `{kind:"next", family, product, package, version}`（`:26-35`）。
- 布局差异：NEXT 的 `@deepseek-ai` 在应用根 `node_modules/`，**没有** `dsh/node_modules/` 前缀（`nextAiBaseCandidates()`，`:38-44`）；也没有官方 `runtime/cli/bin/dsh` shim（`nextCliShim()`，`:47-49`），因此 `nextCliRepairVerdict()` 在「没有 shim」时返回 `{ok:false, notApplicable:true, status:"not_applicable"}`，在「竟然有 shim」时返回 `ok:false, status:"unsupported_family"`——**绝不用 `ok:true` 表达跳过**（`:51-71`）。

消费点只有三处：`desktop-identity.js:76-77`（identity 判定，`kind:"next"`）、`desktop.js:1462-1465`（CLI 修复结论）、`community.js:144`（`familyQualified = false`）。`apply-gate.js` 则用 `notApplicable` 与 `ok` 的分离来决定是否放行换包（`lib/apply-gate.js:12-25`）。

## 数据流与状态

```
                        ┌── DSH_BASE / PURGE_DSH_CLI / options.aiBase ──┐
discover ──── 显式? ────┤                                               │
                        └── argv[1] → packageAbove → installationOf ────┤
                             └ Electron: resourcesPath + desktopIdentity │
                                                                         ▼
identify ──→ desktopIdentity(resources)  ── 读 app.asar (自解析 ASAR 头) 或 app/ + app.asar.unpacked/
             └─ kind ∈ {bundled-host, bundled-cli, community, next}       │
                                                                         ▼
validate ──→ normalizeHostBase(3 形状) → probeAiBase(dsh-agent-instructions/lib) → usable/missing/unreadable
                                                                         ▼
classify ──→ hostSurface(desktop|web|unknown) + hostFamilyOf(kind) + 版本(kernel/prompt)
             → compatibility.level ∈ {mixed,sealed,no-host,qualified,kernel-verified,unverified}
             → patchWritesAllowed = layout && !sealed
                                                                         ▼
runtime evidence ──→ hostLayoutEvidence: state ∈ {archive_entry,unpacked_entry,different_instance,
                     unknown_runtime,unknown_target,unreadable,managed_archive_entry,archive_missing,cli_unverified}
```

状态与缓存的三种生命周期（互相独立、需要人工衔接）：
| 缓存 | 生命周期 | 证据 |
| --- | --- | --- |
| `core.memo`（prefix/shim/desktopShim/ai） | **整进程**，空值不缓存，靠 `resetPathMemo()` 手工清 | `lib/core.js:116-140` |
| `desktop-read-scope` | **单次只读诊断**（AsyncLocalStorage），失败/未知不缓存，上限 8192 项 | `lib/desktop-read-scope.js:8-33` |
| asar 探针缓存 | **5 秒 TTL**，任何经 `hostFs` 的写操作立即失效 | `lib/extract-asar.js:51-69,155-157` |
`resetPathMemo()` 同时调用 `clearDesktopReadScope()`（`lib/core.js:132-140`），是唯一把两套接起来的地方。

## 真实能力清单

| 能力 | 入口 | 实现位置 | 真实现 | 证据 |
| --- | --- | --- | --- | --- |
| 显式实例选择 | `DSH_BASE` / `PURGE_DSH_CLI` / `options.aiBase` | `lib/instance.js:227-254` | 是 | 三级 fallback，显式失败不回落他装（`:336-337`） |
| 从进程入口反推安装 | `argv[1]` → `packageAbove` | `lib/instance.js:128-158` | 是（受限于 argv 形态） | 只认两个包名，爬 8 层 |
| Electron resources 兜底 | `process.resourcesPath` + `desktopIdentity` | `lib/instance.js:334-379` | 是 | 要求 electron 版本 + 绝对路径 + 包证据三连 |
| Windows 注册表/快捷方式发现 | `registryInstallDirs()` / `shortcutOfficialExecutables()` | `lib/desktop.js:347-382,452-480` | 是（仅 `discover:true`） | 默认路径显式跳过（`:624`） |
| 跨平台常见安装根 | `commonDesktopInstallDirs()` | `lib/desktop.js:499-532` | 是 | Win/mac/Linux 三套字面路径 |
| asar 不解包直读身份 | `archiveReader()` | `lib/desktop-identity.js:23-55` | 是 | 自解析 ASAR header，校验 magic=4、size ≤32MB、offset 边界、`link` 递归（深度 ≤8） |
| sealed 归档版本探测 | `sealedHostEvidence()` | `lib/desktop-identity.js:117-130` | 是 | 在归档内找 `dsh-agent-instructions/package.json` 再取两个版本 |
| 桌面壳家族分类 | `desktopIdentity().kind` | `lib/desktop-identity.js:56-81` | 是 | 四类：`bundled-host`/`bundled-cli`/`community`/`next` |
| NEXT 家族识别 | `isNextPackage()` / `nextIdentity()` | `lib/next-host.js:21-35` | 是（覆盖窄） | 只认 `name==="dsh-desktop-next"` |
| Tauri 托管归档识别 | `hostLayoutEvidence()` 早返回分支 | `lib/host-layout.js:42-72` | 是（只读诊断） | 用宿主 virtual FS 校验 `bin/lib/bin.js` |
| 实例诊断目标映射（asar→app） | `diagnosticHost()` | `lib/instance.js:331-399` | 是 | 残缺 app 不被兄弟目录顶替（`:385-395`） |
| 桌面壳入口解析 | `resolveDesktopEntry()` | `lib/desktop-entry.js:12-81` | 是 | `package.main` 优先，未知则四个已知布局，多命中报 `ambiguous_entry` |
| 兼容性矩阵 | `compatibility()` | `lib/community.js:115-185` | 是 | kernel/family 双层 + 6 档 level |
| 写入闸门 | `patchWritesAllowed` / `requirePatchCompatibility()` | `lib/community.js:148,191-199` | 是（刻意宽松） | 只有 no-host / sealed 拦截 |
| 运行入口证据（磁盘≠已加载） | `host-status` CLI | `lib/host-layout.js:25-136` | 是 | 9 种 state + 逐一 note |
| profile 解析 | `resolveProfile()` | `lib/instance.js:27-126` | 是 | 9 级优先级，冲突即抛错 |
| DSH_HOME 解析 | `findDshHome()` | `lib/core.js:1625-1652` | 是 | 桌面/Web 两条不同候选链 + WSL 兜底 |
| surface 检测 | `detectSurface()` | `lib/surface.js:62-88` | 是 | 基于包身份，`DSH_SURFACE` 可强制 |
| 路径围栏 | `path-boundary.js` 三函数 | `lib/path-boundary.js:5-57` | 是 | 含悬空链接与「内部链接也拒」 |
| Windows runtime junction 修复 | `ensureAppRuntimeLink()` | `lib/runtime-layout.js:20-103` | 是 | 绝对目标 junction + realpath 校验 + 不动活链接 |
| 更新后回写标记 | `upgradeMarkerPath()` | `lib/official-update.js:8-38` | 是（名字判定） | 只认 `deepseek harness.exe` / `deepseek-harness.exe` |
| Web 重启 argv 重建 | `restartArgv()` | `lib/web.js:24-53` | 是 | 补 `web --port` 与 `--no-open`，按 `.cmd` 名字找 bin.js |

## 依赖与耦合

- **`lib/instance.js` 是枢纽**：`surface.js` 依赖 `desktop-identity.js`；`host-layout.js`、`selfcheck.js`、`community.js`、`update.js`、`bin/community.js` 全部 import 它（`lib/host-layout.js:8`、`lib/selfcheck.js:11`、`lib/community.js:11`、`lib/update.js:24`、`bin/community.js:7`）。
- **`core.js` 有一整套平行的旧发现体系**，与 `instance.js` 并存：`findAiBase()` 分 surface 派发（`lib/core.js:2272-2277`），`findAiBaseWeb()` 又依赖 `resolveInstance()`（`:1773-1778`），而 `core.js` 顶部同时 import `instance.js`、`host-layout.js`、`community.js`、`desktop.js`、`surface.js`（`lib/core.js:1-42`）——单向依赖无环，但方向固定：**`instance.js` 用不到 `core.js` 的路径工具**，于是同一逻辑被抄了两份（`core.js:1738-1743` 的 `pathIsUnder` 与 `desktop.js:105-111` 的 `isSubPath` 几乎逐行等价，只差 desktop 版多一条 `r === "/"` 拒绝）。`findAiBaseRecursive()` 会做最多 6 层、跨设备保护、realpath 防环的目录扫描（`lib/core.js:2279-2325`），与「绝不扫描别的安装」的契约相反，只是被 `findAiBaseWeb()` 的守卫条件挡住。
- **`desktop.js` 是事实上的第二大身份层**：`isInsideDesktopInstall()`（`:583-593`）、`listDesktopPackageRoots()`（`:646-689`）、`isOfficialHarnessExecutable()`（`:178-180`）被 `core.js` 的 `pathZone()` / `allowTargetPath()`（`lib/core.js:924-950`）与 `findAiBaseDesktop()`（`:1745-1771`）直接消费。
- **`hostFs` / `diskFs` 是隐式全局依赖**：`diskFs()` 拿 Electron `original-fs`，失败退 `node:fs`（`lib/extract-asar.js:15-32`）；所有读宿主文件的模块都经 `hostFs`（`:168-183`）。这意味着「能否读 asar」取决于运行形态，不是代码路径。
- **`next-host.js` 只被 3 处消费**，`nextAiBaseCandidates()` 定义了但**无任何调用点**（grep 仅命中定义处 `lib/next-host.js:38`），属死代码。
- **`desktop-entry.js` 的 `hostFs` 默认参数**与 `host-layout.js` 的 `diskFs()` 不一致（`lib/desktop-entry.js:12` vs `lib/host-layout.js:26`）。

## 局限与缺陷（带证据）

1. **两套发现体系并存，同一台机器可能给出两个答案。** `instance.js` 只认 3 种形状（`lib/instance.js:211-215`），`core.js` 认 11 种含 pnpm 虚拟store（`lib/core.js:194-210`）。`selfcheck` 走 `diagnosticHost`（`lib/selfcheck.js:179-181`），`apply` 走 `enumeratePatchAiBases`（`lib/core.js:1781-1810`），两条路径的「插件根」定义不同。
2. **surface 词表与 family 词表分裂，Tauri 没有 surface 归属。** `hostSurface()` 没有 tauri 分支（`lib/instance.js:196-203`）；按静态读法，Tauri 宿主路径不含 `/resources/`，只要 `dsh/package.json` 存在就会落到 `web`，而同一份 `hostLayoutEvidence()` 对 Tauri 硬写 `disk.surface: "desktop"`（`lib/host-layout.js:65`）。family 词表散落三处：`bundled-host|bundled-cli|community|next`（`lib/desktop-identity.js:60,68,74,77`）、`tauri`（`lib/host-layout.js:64`）、`next`（`lib/next-host.js:29`）。
3. **名字启发式仍有残留，与「只看包证据」的设计自相矛盾。** `harnessExeName()` 只认两个文件名才能定位更新回写标记（`lib/official-update.js:8-16`）；`pathLooksDesktop()` 一整套名字正则仍在（`lib/surface.js:16-40`）；`web.js` 靠 `.cmd/.bat` 文件名猜 `node_modules` 位置（`lib/web.js:42-50`）。
4. **`currentHost()` 在裸 CLI 下必然返回空串。** `bin/community.js:198-200` 的注释直接承认「`node bin/community.js` 时 argv 指向插件自身，currentHost() 认不出宿主」，只能靠 `DSH_BASE`/`PURGE_DSH_CLI` 或 selfCheck 自己的解析，于是 `status`/`diagnose`（走 `diagnosticHost`，`bin/community.js:240-247`）与 `selfcheck`（走 `selfCheck`，`:195-201`）在同一进程里可能指向不同目标。
5. **`hostLayoutEvidence()` 的 state 优先级把 `different_instance` 吞掉。** 只要有读取错误就报 `unreadable`（`lib/host-layout.js:116-117`），即使 `matches_target` 已算成 `false`；调用方会以为是权限问题而不是「装错实例」。
6. **入口层有两套互不校验的实现。** `host-layout.js` 认为宿主 CLI 一定是 `@deepseek-ai/dsh/lib/bin.js`（`lib/host-layout.js:19-21`），`desktop-entry.js` 认的是桌面壳 `package.main` / 四个布局（`lib/desktop-entry.js:5-10`），`desktop-cli.js` 认的是 `dsh-desktop-host/lib/cli.js` 或 `@deepseek-ai/dsh` 的 bin（`lib/desktop-cli.js:11-38`）。三者结论无交叉验证。
7. **缓存三套语义，失效靠人工。** `core.memo` 是整进程（`lib/core.js:116-130`），`desktop-read-scope` 是单次诊断（`lib/desktop-read-scope.js:8-20`），asar 探针是 5 秒 TTL（`lib/extract-asar.js:51-62`）。`core.js:113` 的 `resetPathMemo` 与 `desktop-read-scope` 的 `generation` 只有在显式调用时才同步（`lib/core.js:132-140`），任何忘了调用的新代码路径都会读到过期身份。
8. **`assertWithinRoots()` 的两步语义不一致。** 第一步用未 realpath 的字面路径做 `within` 过滤（`lib/path-boundary.js:36`），第二步才 `realDestination`；同一个目标经 junction 与字面路径会得到不同的候选集，字面过滤可能先淘汰掉唯一合法的根。
9. **`findDshHome()` 在 Linux 上无桌面候选。** `desktopDshHomeGuesses()` 对 linux 返回 `[]`（`lib/core.js:1619-1620`），注释也写明「官方桌面壳没有 linux 官方分发」，但 `commonDesktopInstallDirs()` 又列了 7 条 Linux 安装路径（`lib/desktop.js:522-530`）——发现能力与 home 解析不对齐。
10. **`resolveProfile()` 在多 profile 机器上会硬失败。** 除 `desktop`/`web` 外若还有第三个 `profiles/<x>` 且 argv 无 `--profile`，直接抛「无法唯一确定当前 profile」（`lib/instance.js:121-125`）；Electron GUI 进程通常不带 `--profile`，因此这条在真实桌面场景很容易触发。
11. **`compatibility()` 的「已解包」判定只看目录存在。** `lstatSync(resources/app)` 成功即认为不是 sealed（`lib/community.js:119-124`），换包中途留下的空/残缺 `app/` 会让 `patchWritesAllowed=true`，接着按预期路径写补丁并报 `missing_file`，而不是报「安装不完整」。
12. **`nextAiBaseCandidates()` 是死代码，NEXT 的实际插件根仍靠通用正则。** 定义在 `lib/next-host.js:38-44`，全库无调用点；`hostSurface()` 靠 `(dsh/)?` 可选段碰巧匹配 NEXT 的 `app/node_modules/@deepseek-ai`（`lib/instance.js:191`），即 NEXT 的布局差异并没有真正被利用。
13. **`lib/identity.js` 与宿主身份同名不同义**，是本切片最大的命名陷阱（证据：该文件对 fs/env 引用为 0，全部内容为人格手术，`lib/identity.js:106-190,330-380`）。

## 对 Purge+ 的启示（继承 / 重构 / 替换）

**值得继承（照着抄）**
- **四段式管线 `discover → identify → validate → classify`**：`discover` 只产出候选（显式优先、绝不跨实例搜索）；`identify` 只读包证据（`desktop-identity.js` 的 ASAR 直读是模范实现，含 magic/大小/偏移/链接深度全套校验）；`validate` 只问「这个根是否具备最小结构标记」（`probeAiBase` 的三态 `usable/missing/unreadable` 比布尔值强得多）；`classify` 只输出枚举，不夹带副作用。
- **「磁盘 ≠ 已加载」作为一等公民**：`hostLayoutEvidence()` 的 state 机 + 每态一句不可推断声明（`lib/host-layout.js:121-128`）必须原样继承。任何产品化宿主管家的自检都该分成 `disk` 与 `runtime` 两个独立维度。
- **三层缓存生命周期**（进程级 / 单次诊断 / TTL）的思路正确，AsyncLocalStorage 的只读作用域（`desktop-read-scope.js`）尤其适合「一次诊断内复用证据、诊断后立刻过期」。
- **`path-boundary.js` 与 `remove-tree.js` 可直接复用**：悬空链接显式失败、内部链接也拒、junction 只 unlink 本体、无原生递归 rm 回退——这三条是 Windows 上删/写宿主的硬要求。
- **NEXT 的三态修复结论 `ok / notApplicable / failed`**（`next-host.js:57-71` + `apply-gate.js`）是跨家族扩展的正确姿势：不适用 ≠ 成功，绝不用 `ok:true` 表示跳过。

**需要重构（保留思想，换实现）**
- **把 `currentHost/diagnosticHost/normalizeHostBase` 合成一个带模式的 `resolveHost({mode:'locate'|'inspect'})`**，返回结构体 `{selectedBy, root, shape, surface, family, probe}`。现状三个函数都只返回裸字符串，语义差别只能靠注释传达，调用方拿到 string 无法判断它是「安装根」还是「可读插件根」。
- **建立唯一的族谱表**：`family × layout × entryPattern × cliResolver × versionSource`。现状是 `bundled-host/bundled-cli/community/next/tauri` 五个 kind 分散在四个文件，且 `hostSurface` 不认识 tauri。新实现应当让「加一个新宿主家族」= 加一行表项，而不是改四处正则。
- **宿主适配器接口化**：`host.js` 现在只把 `desktop|web` 映射到两个模块（`lib/host.js:5-16`），`gui/tui` 直接折叠（`lib/surface.js:86-88`）。应改成 `HostAdapter { discover, identify, entry, cli, repair, restart, settle }`，让 NEXT/Tauri 各自实现，而不是在 `desktop.js`（1519 行）里靠 `hasDesktopIdentity(..., "next")` 这类单点分支硬接（实例：`lib/desktop.js:1462-1465`）。
- **统一候选枚举与插件根归一**：用一份 `knownShapes[]`（含 pnpm 虚拟store、`app/node_modules`、`dsh/node_modules`、`resources/runtime`）同时喂给 `normalizeHostBase` 和旧 `aiBaseGuessesAround`，消除 `instance.js` 与 `core.js` 的两套答案。
- **profile 解析加「运行形态」维度**：Electron GUI 必须能从 `resourcesPath`/userData 推导默认 profile（现状只能靠唯一目录或 `DSH_PROFILE`），并把「多 profile 且无显式选择」从抛错降级为「返回 candidates 让上层提示选择」。

**应当替换（明确不要继承）**
- 全部**文件名/目录名启发式**：`harnessExeName`（`official-update.js:8-11`）、`pathLooksDesktop`（`surface.js:16-40`）、`web.js` 的 `.cmd` 猜路径（`web.js:42-50`）。用「包 manifest 名 + bin 指向 + 结构标记」替代。
- `core.js` 里的**递归目录扫描** `findAiBaseRecursive`（`core.js:2279-2325`）：与「不扫其他安装」契约冲突，且成本真实——源码注释自陈同规模的兜底扫描在 6 万目录下裸 `node:fs` 6.2s、经 asar 探针 94s（`lib/extract-asar.js:39-41`）。
- `core.memo` 的**整进程记忆 + 手工 reset**：改成显式 `HostRegistry`，所有身份对象带 `observedAt` 与 `source`，读不到就返回 `unknown` 而不是缓存旧值。
- `compatibility()` 的**宽松写入闸门**要保留「版本未知也允许写」的运维弹性，但必须把 `sealed` 判定从「`app/` 目录是否存在」升级为「`app/` 内最小结构标记是否齐全」，否则换包中断会把残缺目录当成可写目标（`community.js:119-124`）。
- `lib/identity.js` 这个**名字**：人格身份与宿主身份必须分文件分名（建议 `persona-*.js` vs `host-*.js`），否则下一位维护者会重复本切片踩的坑。

**给 Purge+ 的一句话模式**：把宿主当成「可插拔的运行时目标」，用**显式选择器 > 进程入口 > 单一 Electron 兜底**的三级发现、**纯包证据**的识别、**最小结构标记**的校验、**family × kernel 双层**的分类，配一条独立于磁盘状态的 `runtime_evidence` 通道 —— 这样加第二个、第三个 agent 宿主时，只需要新增一个适配器条目，而不是新增一套 if。
