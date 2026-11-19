# 09 · 安装器 / 重启 / asar 换包（dsh-purge-community 1.6.91）

> 分析对象（只读，未修改）：
> - `KIT/` = `dsh-purge-install-kit`：`一键安装.bat`、`一键安装-修复版.bat`、`卸载还原.bat`、`卸载还原-修复版.bat`、`apply-driver.mjs`、`register-bundle.mjs`、`unregister-bundle.mjs`、`README.txt`
> - `PL/` = `KIT/pkg/plugin-copy/dsh-purge-community`：`lib/desktop.js`、`windows-asar-handoff.js`、`macos-asar-handoff.js`、`desktop-handoff.js`、`restart-desktop.js`、`restart-web.js`、`uninstall-restart.js`、`extract-asar.js`、`hide-console.js`、`child-process-hide.mjs`、`scripts/check-windows-job-handoff.ps1`
> 文中“实测”均为本机受控复现（Windows 11 / PowerShell 5.1.26100.9818 / pwsh 7 / node 24，全部在 `%TEMP%` 内，不触及真实 DSH 安装）。

## 职责

这一层解决一个物理问题：**插件要改的是宿主源码，而宿主源码被 Electron 打包在 `resources/app.asar` 里；Windows/macOS 上该文件被进程占用，必须等进程真正退出才能改名。** 因此职责被切成四块：

1. **装机**：把插件 tgz 装进 profile（`node_modules` + `package.json` 的 `dependencies` / `dsh.profile.bundles`），见 `KIT/一键安装.bat:48-61`、`KIT/register-bundle.mjs:22-32`。
2. **解包 + 打补丁**：把 `app.asar` 解到 `resources/app`，写入 86 条宿主补丁 + shim + 提示词，见 `KIT/apply-driver.mjs:44-104`、`PL/lib/core.js:2021-2079`、`PL/lib/core.js:1852-1894`。
3. **换包（asar hand-off）**：“把 `app.asar` 挪走，让 Electron 去加载解开的 `resources/app`”。这是全项目风险最高的一步，有两条互斥实现：
   - **安装器路径**：先 `taskkill` 再同步改名（`KIT/一键安装.bat:38-46` → `apply-driver.mjs:107-117`）。
   - **插件路径**：不杀进程，起外部助手等用户“完整退出”后改名（`PL/lib/windows-asar-handoff.js:120-201`、`PL/lib/macos-asar-handoff.js:196-300`）。
4. **状态、诊断、还原**：`.purge-handoff.json` + `.log` 状态机（`PL/lib/windows-asar-handoff.js:100-118`）、`host-status` 暴露（`PL/lib/host-layout.js:131`、`PL/lib/core.js:4621`）、卸载还原（`KIT/卸载还原-修复版.bat:26-56`、`PL/lib/uninstall.js:203-289`）。

**两个产品的行为在这里是矛盾的**：插件侧明确禁止定时退出/杀 Electron（`PL/AGENTS.md:186`），而安装器 bat 正是这么做的（`KIT/一键安装.bat:42`）。这条矛盾是后面所有风险的根源。

## 关键实现（带 file:line 证据）

### (a) Windows 端到端流程：bat 实际做了什么

`一键安装.bat` 的五步（`KIT/一键安装.bat:37-81`）：

| 步 | 动作 | 证据 |
| --- | --- | --- |
| 0 | 定位 DSH：默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，可用 `%1` 覆盖；exe 名硬编码 `DeepSeek Harness.exe` | `:13-21` |
| 0 | 定位宿主自带 node/pnpm，两套布局依次尝试：`resources\runtime\...` 与 `resources\app\runtime\...` | `:25-30` |
| 0 | `DSH_HOME` 默认 `%USERPROFILE%\.dsh`；`PROFILE=%DSH_HOME%\profiles\desktop`；`LOCAL_PLUGINS=%DSH_HOME%\local-plugins` | `:33-35` |
| 1 | `tasklist` 探测 → `taskkill /IM "DeepSeek Harness.exe" /F` → `timeout 3` | `:38-46` |
| 2 | 把 tgz 复制进 `local-plugins`；`node pnpm.cjs add --dir PROFILE --registry=https://registry.npmmirror.com file:...tgz`；失败则 `xcopy` 离线副本 `plugin-copy\dsh-purge-community` 与 `yaml` 到 `node_modules` | `:52-59` |
| 2 | `register-bundle.mjs PROFILE tgz` 写 profile 注册表 | `:60-61`、`KIT/register-bundle.mjs:22-32` |
| 3 | `apply-driver.mjs`（解包 + 补丁 + shim + 换包） | `:65-66` |
| 4 | 轮询等待 `resources\app.asar` 消失：30 次 × 2 s；超时**只打印提示然后继续** | `:70-77` |
| 5 | 无条件 `start "" "%DSH_EXE%"` | `:81` |

`register-bundle.mjs` 做两件事：`dependencies["dsh-purge-community"] = "file:<绝对路径>"`（`:22-24`，机器相关路径），`dsh.profile.bundles.push(...)`（`:25-30`），最后 `JSON.stringify(data, null, 2)` 覆盖写（`:32`）。
`apply-driver.mjs` 的五步与退出码（`:37-122`）：①`commitOverrideOnApply`（`:38`）②`resolveOfficialAiBase(..., { forApply: true })` → 归档会在此解包（`:47`、`:56`），解包后补写 stamp 防重复解包（`:59-62`）③`applyPatchesAllHosts(ALL_PATCHES)`（`:65-80`）④shim / cmd-flash / seed / CLI 修复，四步全是 `try{...}catch{warn}`（`:84-104`）⑤换包（`:107-117`）。**只有补丁失败才 `exit(1)`**（`:119-122`）：换包失败仅 `console.warn`（`:115-117`），bat 因此会打印“安装完成”。
`ALL_PATCHES` 实测为 86 条（`node` 导入 `PL/lib/patches/index.mjs` 计数，`dup_ids=0`），与 `PL/AGENTS.md:19` 一致。

**“修复版”的真实差别是行尾**：两份 bat 去掉行尾差异后 SHA256 完全相同（`一键安装.bat` = 97 个裸 LF、0 个 CRLF；`一键安装-修复版.bat` = 97 个 CRLF；`卸载还原` 同理 62 个）。裸 LF 在 cmd 里不是无害的：实测同一段含中文 `echo` 的 `if ... ( ... )` 块，LF 版被整块吞掉并回显 `'al' 不是内部或外部命令`、`'到' 不是…`，CRLF 版正常输出。而本包恰好有这种结构（`KIT/一键安装.bat:16-21`、`:40-46`、`:54-59`、`:76`），所以原版在这些分支上是**静默错行**的。

### (b) 换包状态机与工件（Windows）

状态机由 PowerShell 助手脚本写盘，JS 侧只读并派生两个“合成状态”。阶段产生点（`PL/lib/windows-asar-handoff.js:9-98`）：

| phase | 写者 | 含义 |
| --- | --- | --- |
| `starting` | JS `:132` | 只是“已发起请求”，不是助手已运行（`:199` 注释、`:200` 返回） |
| `ready` | PS1 `:49` | 助手进程真正执行了第一行 |
| `waiting_for_quit` | PS1 `:55` | 已记下归档哈希，开始等进程退出 |
| `already_unsealed` | PS1 `:62` | 等待期间发现归档已不在（别人挪走了），清锁退出 0 |
| `moving` | PS1 `:69` | 开始改名 |
| `waiting_for_unlock` | PS1 `:82` | `Move-Item` 抛共享/锁冲突（Win32 32/33），继续轮询 |
| `complete` | PS1 `:88` | 改名完成且备份哈希校验通过 |
| `expired` | PS1 `:92` | 1800 s 超时，保留原归档，`exit 2` |
| `failed` | PS1 `:95` / JS `:139` | 其它任何异常，含 broker 启动失败 |
| `helper_stopped` | JS 派生 `:110-112`、`:113-115` | `starting` 超过 30 s 无应答；或活动阶段且 pid 已死 > 10 s |

工件（全部落在 `resources` 旁，与安装目录同级）：

- `resources/app.asar.purge-handoff.json`：状态（`windows-asar-handoff.js:129`），原子写 = 写 `.tmp` 再 `Move-Item -Force`（PS1 `:43-45`）。
- `…purge-handoff.json.log`：逐阶段追加（PS1 `:19`、`:46`）。
- `…purge-handoff.json.broker.log`：broker 的 stdout/stderr（JS `:181-184`）。
- `…purge-handoff.json.launch.log` / `.error`：非 Job 分支 `Start-Process` 的重定向（JS `:143`、`:166`）。
- `resources/app.asar.rename-pending`：令牌锁，JS 写（`:133`），PS1 只在 `complete` / `already_unsealed` 时删（`:63`、`:89`）。
- 助手脚本本体：`%TEMP%\dsh-purge-handoff-<token>.ps1`（`:130-131`）。

**为什么必须有 broker + Job Object**：Electron 宿主通常是被 Job Object 管理的子进程；Windows 的 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（0x2000）会在 Job 最后一个句柄关闭时杀掉全部成员。实测复现见 `PL/scripts/check-windows-job-handoff.ps1:23-28`（自建 Job + `SetInformationJobObject`）、`:58`（把隔离 Electron 塞进 Job）、`:77-89`（断言旧版助手随 Job 消失、新版助手存活并把归档换完）；维护记录承认“已重建故障表现、但未证明用户现场同一机制”（`PL/docs/maintenance-issues-86-89.md:21-30`）。
因此 broker（`PL/lib/windows-asar-handoff.js:151-180`）先 `IsProcessInJob` 自检，若在 Job 内则用**本机 WMI** `Win32_Process.Create` 提交一次性助手以脱离 Job（`:158-164`），否则 `Start-Process -WindowStyle Hidden`（`:166`）；随后用 20 s 轮询状态文件确认助手“离开了 starting”（`:171-179`），而不是相信 PID 或 exit code。

### (c) “关窗口 ≠ 退出”与等待真实退出

助手只认“同 exe 路径的进程全部消失”：`Get-Process -Name <basename> | Where-Object { $_.Path -eq $ExePath }`（PS1 `:57-60`），500 ms 轮询（`:59`、`:15`），上限 1800 s（`:14`、`:56`）。用 `Path` 全等而不是映像名，避免误杀同名其它安装；JS 侧同名路径先 `realpathSync` 展开 8.3 短名（JS `:122`）。
退出后还要过三道闸：①归档仍存在（PS1 `:61`）；②owner token 未变（`:66-67`，被新一次尝试取代就 `exit 3`）；③哈希与等待开始时一致（`:68`），不一致即“官方更新替换了归档”，保留并报错。
只有这三道都过才 `Move-Item` 到唯一备份（`:71-72`），随后校验“归档不在 + 备份在”（`:86`）与备份哈希（`:87`）。
对比旧实现：`PL/lib/restart-desktop.js:184-197,262-271` 与 `PL/lib/desktop.js:1043` 走“按映像名杀 + 固定 `.bak`”，正是 `PL/AGENTS.md:186`（“不要把关闭窗口当成退出，也不要自行执行旧版重启脚本”）要淘汰的路径。

### (d) macOS ⌘Q 变体

`PL/lib/macos-asar-handoff.js:1` 的注释就是契约：“wait for the exact app to exit; never terminate or reopen it.”
- 调度：`exe` 必须 `realpath` 且形如 `*.app/Contents/MacOS/*`，`asar` 的父目录必须 `realpath` 等于 `<bundle>/Contents/Resources`（`:196-207`）。
- 锁纪律比 Windows 严：存在外来/遗留 `rename-pending` 且 token 不匹配时**直接抛错**，不并跑两个 mover（`:222-232`）。
- 助手是 `macHandoffWorker` 序列化成的独立 `.cjs`（`"(" + worker.toString() + ")();"`，`:269-276`），用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 起（`:277-286`）——插件被替换也不会被抽掉。
- 等待用 `ps -axo pid=,comm=` 只比可执行路径，避免把 prompt/文件名带进 argv（`:135-147`）；退出后重跑 `validate()`（`app/package.json` 的 `main` 必须落在 app 内，`:109-129`）。
- 备份用**硬链接**保 inode + `unlink` 原名（`:160-171`），校验 `ino`/`dev`/sha256（`:162-169`）。
- 只读侧额外多两个状态：`complete` 后归档又出现 → `archive_reappeared`；备份丢失 → `backup_missing`（`:17-32`）。**这两个状态 Windows 侧没有**（`windows-asar-handoff.js:100-118` 未实现），跨平台状态集合不一致。

### (e) 备份命名与 sealed / unpacked 两种宿主

- 唯一备份：`app.asar.purge-<token>.bak`（Windows `windows-asar-handoff.js:20`；macOS `macos-asar-handoff.js:241`），注释明确“A unique backup is never overwritten or deleted, even on retry”（`windows-asar-handoff.js:71`）。
- 固定 `.bak` 的旧路径仍在代码里且**会覆盖旧备份**：`PL/lib/extract-asar.js:200-203`（`rmSync(bak)` 再 rename）、`PL/lib/restart-desktop.js:280-283`、`PL/lib/desktop.js:1043`（wscript 里 `fso.DeleteFile(bak,true)`）、`PL/lib/desktop.js:836-838`（sh 版 `rm -f "$bak"`）。这是“第二次应用会毁掉唯一原版归档”的直接来源。
- sealed 判定：`sealedAsarHandoff()` 要求 `asarArchiveIsFile(asar)`（`PL/lib/core.js:1967-1975`）；`desktopAsarStillSealed()`（`:2267-2270`）；`isAsarSealedPath()`（`PL/lib/desktop.js:56`）。
- unpacked 判定：`resources/app` 下有 `@deepseek-ai` 才认（`aiBaseUnderAppDir`，`core.js:2027`、`:2047`）；决定是否再解包的纯函数 `shouldExtractAsar({usable, identity, recorded, upgrade})`（`PL/lib/extract-asar.js:244-251`），靠 `size+mtimeMs` 识别同一归档（`:221-237`）。
- 换包策略纯函数：`planApplyRestartAction({sealed, foreign, desktopPid})` → `swap` / `swap-foreign` / `manual` / `plain`（`core.js:2260-2265`），调用点 `PL/lib/index.js:1140-1167`。
- 设计前提：归档挪走后 Electron 才加载 `resources/app`（`PL/lib/desktop.js:878` 注释原文“等当前桌面进程退出后把 app.asar 挪走，再启动 exe。解开后的 resources/app 才会被加载”）。所以归档必须真的消失，`README.txt:31` 也这么写。

### (f) 解包本身的工程化（决定“坏一半”是否可恢复）

`PL/lib/extract-asar.js` 是这条链上质量最高的部分：
- 双 fs：Electron 的 `fs` 会把 `resources/app` 映射进仍在的 `app.asar`，写新文件会 ENOENT，故引入 `diskFs()`（`original-fs`，`:15-32`）与按路径自动路由的 `hostFs`（`:137-183`）；判定缓存 5 s TTL + 任何写操作立即失效（`:51-80`、`:147-159`）。
- 先全量校验再落盘：条目名/链接/数据范围全部验完才 `mkdir`（`:466-480`），符号链接最后建（`:492-499`），`safeArchiveName` 拒绝 `..`、ADS`:`、设备名（`:268-274`）。
- 原子提交：解到 `app.dshpurge-next` → 旧目录改名 `…-prev` → 新目录改名就位；失败则回滚旧目录并写 `<app>.dshpurge-recover.json` 保留 `next/prev` 路径（`extractAsarToSide :354-364`、`commitExtractedDir :377-409`、`restoreExtractedDir :434-454`）。
- `overlayAsarUnpacked` 把 `app.asar.unpacked` 里的原生模块补进解包目录（`:318-346`），PS1 侧还额外用 `robocopy` 兜一层（`PL/lib/desktop.js:1040`）。

### (g) 控制台隐藏与旧重启通道

- `PL/lib/hide-console.js:69-73`：只有 `win32 && !Electron` 才包装 builtin `child_process`（`windowsHide:true`），Electron 宿主整段跳过；`#46` 之后不再注册模块解析钩子（`:75-80`）。它还会往宿主 `lib/bin.js` 注入一行 `import "./dsh-purge-hide-console.js"` 并落 sidecar（`:233-270`），源码树只读不写（`:174-191`、`:241`），sealed 直接返回 `sealed_asar`（`:246`），回退见 `revertHideConsoleFromBin`（`:273-307`）。`child-process-hide.mjs` 就是被注入的 facade（`PL/lib/child-process-hide.mjs:12-64`）。
- `restart-desktop.js`：读 `DSH_PURGE_RESTART`（`:5-13`），等 pid / 杀同名进程 / 清目录 / 挪 asar / 重启；Windows 重启还追加 `--updated` argv（`:349-351`）并用 PowerShell `keybd_event`+`AttachThreadInput`+`SetForegroundWindow` 硬抢前台（`:371-417`）。asar 挪不动就不重启直接 `exit 1`（`:463-466`）。
- `restart-web.js`：等端口释放（`:52-67`）→ `taskkill /PID`（`:31-36`）→ 起新进程并从 stdout 抓 `dsh web: <url>` 再打开浏览器（`:81-93`）；抓不到 URL 就无浏览器（20 s 超时，`:94-98`）。

## 数据流与状态

```
[安装器路径 —— 离线、暴力]
双击 一键安装.bat
  ├ tasklist/taskkill /F  (关闭全部 "DeepSeek Harness.exe")
  ├ pnpm add file:tgz  ──失败──> xcopy plugin-copy (+yaml)
  ├ register-bundle.mjs  → profiles/desktop/package.json  (dependencies + dsh.profile.bundles)
  └ apply-driver.mjs
       ├ commitOverrideOnApply       → $DSH_HOME/prompt-inject.md（保留用户正文）
       ├ resolveOfficialAiBase(forApply) → 解包 resources/app (+stamp)
       ├ applyPatchesAllHosts(86)    → resources/app/** + *.dshpurge.bak
       ├ patchAllShims / silenceCmdFlash / seedPromptInject / repairOfficialCli
       └ scheduleSealedDesktopRestart → renameAsarAside 同步改名 .bak
              └ 改名 busy → scheduleWindowsAsarHandoff（见下）
  └ 等 app.asar 消失（≤60s，超时也继续）→ start exe

[插件路径 —— 用户手动完全退出]
POST /dsh-purge/apply (index.js:2306-2368)
  ├ 同上解包+补丁，cliRepairBlocksApply 闸门 (apply-gate.js:12-18)
  └ scheduleDesktopHandoff → PS1 助手 (starting→ready→waiting_for_quit→moving→complete)
        用户从托盘 ⌘Q / 完整退出 → 归档改名为 app.asar.purge-<token>.bak → 停
        返回 { restarting:false, manualQuit:true, handoff }  + boot_full_quit=true
```

状态读取链：`gatherState()` → `host_layout.handoff = readDesktopHandoff(resources/app.asar)`（`PL/lib/host-layout.js:131`）→ `asar_handoff`（`PL/lib/core.js:4621`）→ HTTP `asar_handoff`（`PL/lib/index.js:1968`）。缺失即 `{phase:"not_scheduled"}`；无 resources 即 `unknown_target`。

## 真实能力清单

| 能力 | 入口 | 实现位置 | 真实现 | 证据 |
| --- | --- | --- | --- | --- |
| 关闭 DSH | bat 第 1 步 | `KIT/一键安装.bat:38-46` | 是（粗暴） | `taskkill /IM ... /F`，无优雅退出 |
| 在线装插件 | bat 第 2 步 | `:52-53` | 是 | `pnpm add --dir ... file:tgz`，写死 npmmirror |
| 离线兜底装 | bat 第 2 步 | `:54-59` | 是（**与依赖声明不一致**） | 复制目录但 `package.json` 仍写 `file:tgz` |
| 注册 bundle | `register-bundle.mjs` | `:22-32` | 是（**非原子、可清空**） | 解析失败 `data={}` 后整体覆盖写 |
| 提示词注入 | 两条路径 | `PL/lib/core.js:4464-4476` | 是（保留用户正文） | `isKeepableUserOverride` 分支 |
| 解包 asar | `resolveOfficialAiBase` | `PL/lib/core.js:2021-2079` | 是 | side+commit+recover 三步 |
| 86 条补丁 | `applyPatchesAllHosts` | `PL/lib/core.js:1852-1894` | 是 | 逐宿主备份→打补丁→合并报告 |
| shim/cmd-flash/CLI 修复 | `apply-driver:84-104` | 同 | 是（best effort） | 四段全是 warn-only |
| 换包（安装器） | bat 第 3/4 步 | `apply-driver.mjs:107-117` | 是（进程未跑时同步改名） | `renameAsarAside` (`extract-asar.js:195-209`) |
| 换包（插件，Windows） | 面板/HTTP apply | `windows-asar-handoff.js:120-201` | **否 —— 助手起不来** | 见下文 §缺陷 A1（本机复现） |
| 换包（插件，macOS） | 同上 | `macos-asar-handoff.js:65-194` | 是（硬链接保 inode） | `:160-176` |
| 换包（旧 kill+重启） | `scheduleRestart` | `PL/lib/desktop.js:942-993` | 是（仍可被走到） | `:966-982`、`:1265-1277` |
| Web 重启 | `restart-web.js` | `:52-102` | 是 | 端口轮询 + stdout 抓 URL |
| 卸载还原 | bat | `KIT/卸载还原-修复版.bat:30-49` | 部分（**无校验**） | 见 §缺陷 D1-D4 |
| 状态诊断 | `host-status` / status | `host-layout.js:131`、`index.js:1968` | 是 | 9 个 phase + 2 个派生 |
| Job Object 复现 | `check-windows-job-handoff.ps1` | `:23-28,58,77-89` | 是（隔离 TEMP） | `-ExpectLegacyFailure` 双模 |
| 隐藏控制台 | `installHideConsole` | `hide-console.js:100-118` | 是（仅 win32 非 Electron） | `hideConsoleDecision` |

## 依赖与耦合

- **宿主运行时**：`package.json` 只有 `dependencies.yaml@2.9.1`、`peerDependencies.@deepseek-ai/cordis ^4.0.1`（`PL/package.json`）；`dsh.compatibility.dsh = ">=0.2.1-rc.1 <0.3.0"`。**安装器完全不校验宿主版本**（`KIT/apply-driver.mjs` 全文无 compat 检查），与 `PL/AGENTS.md:137-138`“其它宿主允许应用但标未验证、先看 `diagnose`”的取向相反：bat 装完只让用户跑 `purge_status` 看 `applied`（`KIT/一键安装.bat:86`），不做任何版本/兼容判定。
- **路径假设**：bat 写死 `profiles\desktop`（`:34`），DSH 若跑在 `web` profile 就装错地方；`register-bundle` 写 `file:` 绝对路径（`:22`），profile 迁移即断。
- **外部进程**：`powershell.exe` / `wscript.exe` / `cscript.exe`（`PL/lib/desktop.js:1138-1158`）、`tasklist`/`taskkill`/`robocopy`/`Get-Process`、macOS 的 `ps`/`osascript`/`defaults`/`plutil`（`restart-desktop.js:95-151`）。
- **宿主内部契约**：`--updated` argv 触发前台（`restart-desktop.js:344-351` 注释引用 main.js:11256）、`dsh web: <url>` 的 stdout 格式（`restart-web.js:84`）、`system-prompt` 文件的 marker（`desktop.js:1061-1082`）、`lib/bin.js` 的 import 注入点（`hide-console.js:243-269`）、`app/runtime/.../pnpm.mjs` 的 junction 布局（`windows-asar-handoff.js:52-53`）。**这些全是未版本化的隐式契约**，宿主改一行就断。
- **与其它层**：换包闸门依赖 `repairOfficialCliAfterUnpack` 的三值语义（`PL/lib/apply-gate.js:12-18`）；`selfcheck` 的“磁盘布局”层直接读同一份 handoff 状态（`PL/lib/selfcheck.js:184-196` 用的 `hostLayoutLayer`）。

## 局限与缺陷（带证据）

### A. 换包助手在 Windows 上根本起不来（最严重）

1. **参数拼接错误**：broker 把整串参数先整体单引号包裹（`windows-asar-handoff.js:150` `quote('-NoProfile ... -EncodedCommand ' + encoded(invoke))`），再原样塞进 `Win32_Process.Create`（`:161`）与 `Start-Process -ArgumentList`（`:166`）。单引号不是 Windows 命令行引号字符，powershell.exe 会把整串当成**一个表达式**。
   本机复现（Windows PowerShell 5.1.26100.9818，两份脚本均照抄插件写法）：
   - WMI 分支：`Win32_Process.Create` 返回 `ReturnValue=0`、给了 PID，但助手要写的标记文件**未出现**（`wmi_marker=False`）——函数返回值骗过了 `:164` 的 `ReturnValue -ne 0` 检查。
   - `Start-Process` 分支：重定向的 stdout 里出现整串原文 `-NoProfile -ExecutionPolicy Bypass -EncodedCommand UwBlAHQ...`，即被当作字符串求值并打印；标记文件同样未出现。
   对照组（同一 WMI 调用、参数不加外层单引号）立即写出 `WMI_OK`，证明 WMI 本身可用，问题就是这层引号。
   后果：`starting` 永远等不到应答 → broker 20 s 后抛错（`:177-180`）→ state 落 `failed`（JS `:192-197`）或派生 `helper_stopped`（`:110-115`）。**即面板侧在 Windows 密封宿主上永远无法完成换包**；而 `PL/AGENTS.md:187-189` 描述的是“读 `.broker.log` 排查”，实际是 100% 失败而非偶发。
2. **`.rename-pending` 残留**：PS1 只在 `complete`/`already_unsealed` 删锁（`:63`、`:89`），`failed`/`expired` 路径不清（`:92-96`）。Windows JS 侧创建前也不检查既有锁（`scheduleWindowsAsarHandoff` 全文无 `existsSync(lock)`），macOS 侧却会抛错（`macos-asar-handoff.js:222-232`）——同一语义两套行为。
3. **`ready` 记录里的 `archive_sha256` 永远是 null**：`Save-State` 用 `$expectedHash`（`:42`），但首个 `Save-State 'ready'` 在赋值之前（`:49` vs `:54`）。诊断者若拿 `ready` 记录当“原归档指纹”会拿到空值。

### B. 安装器把机器留在坏状态的具体路径

1. **先杀后验**：第 1 步就 `taskkill /F`（`KIT/一键安装.bat:42`），而 node/pnpm 检查在 `:29-30`、插件存在性检查在 `apply-driver.mjs:19-22`；任何后续失败都发生**DSH 已经关闭**之后，用户面对“程序被关掉且没有新版本”。
2. **换包失败的“假成功”**：`apply-driver.mjs:107-117` 只 `warn`，退出码只看补丁（`:119-122`）；bat 的等待循环超时后仍 `start`（`:76-81`）。结果：DSH 正常启动、面板可用、补丁全部未加载——用户以为装好了。
3. **半补丁宿主留在磁盘**：`resources/app` 在解包阶段就已经 commit 就位（`core.js:2052`），补丁是之后逐个写的；`failed>0` 时 bat `goto :fail`（`:66`）不清理，下次任何一次成功的“挪归档”都会把这份半成品变成运行版本。
4. **profile `package.json` 可能被清空**：`register-bundle.mjs:16-18` 解析失败即 `data = {}`，随后 `:32` 整体覆盖写；`unregister-bundle.mjs:14-24` 同样。仓库自己写着“原子写 + 备份”是硬要求（`PL/AGENTS.md` 1.6.69 段、`PL/lib/atomic-files.js`），安装器却完全不用。JSON 带注释、并发写、磁盘满任一情况都会把一个有十几个插件的 profile 变成只剩一项。
5. **离线兜底与声明不一致**：bat 复制目录（`:57-58`）但仍把 `dependencies` 指向 `file:%DSH_HOME%\local-plugins\*.tgz`（`register-bundle.mjs:22-24`）。tgz 被清理/移动后，下一次 `pnpm install`/宿主校验就会失败；同时 `node_modules` 里留双份来源。
6. **固定的 60 s 等待**：`:70-77` 的 30×2 s 与真实 rename 无关（同期 rename 是同步执行的），既不能证明换包完成，也不覆盖慢盘/杀软扫描。

### C. 备份与可回滚性

1. 唯一备份只在新助手路径上成立；**旧路径会删掉已有备份**：`extract-asar.js:200-203`、`restart-desktop.js:280-283`、`desktop.js:1043`、`desktop.js:836-838`。第二次“应用”若走到这些分支，原版归档永久消失。
2. 卸载只看目录枚举顺序挑备份：`for /f ... in ('dir /b app.asar.purge-*.bak') do set BAK=...`（`KIT/卸载还原-修复版.bat:32`）——多个 token 备份时取“列举到的最后一个”，与时间、版本、哈希都无关；`:33` 再回退固定 `app.asar.bak`。没有 `Get-FileHash` 对 `archive_sha256` 的校验，而文档明确要求这一步（`PL/docs/MAINTENANCE.md:51`）。跨官方版本恢复会把旧 asar 盖回新安装目录。
3. **卸载顺序本身是破坏性的**：先 `rmdir /S /Q resources\app`（`:36-39`），再 `move` 备份（`:40`）。`move` 一旦失败（占用/权限/AV 拦截），`resources` 下既没有 `app` 也没有 `app.asar`，DSH 无法启动，且脚本第 4 步仍会 `start`（`:52`）。
4. 旧重启通道的同名误杀：`restart-desktop.js:187` 固定 `["DeepSeek Harness.exe","DSH Desktop.exe"]`，`:262-271` 按映像名杀；bat 用 `taskkill /IM`（`:42`）。多安装/多 profile 机器上会打到别人。

### D. 卸载不彻底 / 与文档不符

1. `README.txt:37` 称“之后 DSH 与安装前完全一致”，实际至少残留：`$DSH_HOME\dsh-purge\`（tuning/probe/anchor-overrides/backups/update-*，`PL/AGENTS.md` §6 表）、`$DSH_HOME\local-plugins\*.tgz`（bat `:52` 复制后从不删）、`%PROFILE%\node_modules\yaml`（`:58` 复制后从不删）、`resources\app.asar.purge-handoff.json` 及三个日志、`resources\app.asar.rename-pending`、`%TEMP%\dsh-purge-*`。
2. `unregister-bundle.mjs` 只删 `dependencies` + `dsh.profile.bundles`（`:20-23`），不处理 `dsh.profile.plugins` / `devDependencies`；插件自己的 `stripPluginFromPackage`（`PL/lib/uninstall.js:45-67`）覆盖四种依赖段 + bundles + plugins。安装包用的是弱版本。
3. 故意保留的：`$DSH_HOME\prompt-inject.md`（`卸载还原-修复版.bat:49` 明示），设计上是“用户文件”（`PL/AGENTS.md` §6 不变量）。但 `resources/app` 内逐个文件的 `.dshpurge.bak`（`core.js:2509,2646-2658`）随目录一起被删，所以“只撤补丁、不换包”的回退路径在 bat 流程里不存在——只能整目录丢弃 + 还原归档。
4. 文档计数漂移：`PL/AGENTS.md:89` 写“补丁数不是 73/76（全量 84）”，`:19`/`:112` 写 86，`KIT/README.txt:24` 写“applied=65+”，实测 86。维护者自己的 §10 规则要求同步，尚未同步。

### E. 真机可能被留在坏状态的完整清单

| # | 触发条件 | 机器最终状态 | 证据 |
| --- | --- | --- | --- |
| L1 | 任意后续步骤失败 | DSH 已被 `taskkill /F` 关闭，不会自动重开（bat 只在成功路径 `:81` 启动） | `一键安装.bat:40-46` |
| L2 | 换包没成功（busy/助手失败） | DSH 启动、面板正常、补丁 0 生效，用户以为成功 | `apply-driver.mjs:107-122`、`一键安装.bat:76-81` |
| L3 | 补丁 `failed>0` | `resources/app` 留着半补丁宿主，下次挪归档即上线 | `core.js:2052`、`一键安装.bat:66` |
| L4 | profile `package.json` JSON 不合法 | 整份被重写成只剩 `dependencies`+`bundles`，其它插件全部掉线 | `register-bundle.mjs:16-18,32`；`unregister-bundle.mjs:14-24` |
| L5 | 第二次“应用”走到旧分支 | 原版 `app.asar.bak` 被删后重建，初始官方归档永久丢失 | `extract-asar.js:200-203`、`desktop.js:1043`、`restart-desktop.js:280-283` |
| L6 | 面板路径换包（Windows 密封） | 助手从未启动 → `failed`/`helper_stopped`；`.rename-pending` 残留 | `windows-asar-handoff.js:150,161,166`、PS1 `:63,89` |
| L7 | 卸载时 `move` 失败 | `resources` 既无 `app` 也无 `app.asar`，DSH 无法启动，且脚本仍 `start` | `卸载还原-修复版.bat:36-40,52` |
| L8 | 存在多个 token 备份 | 可能把**另一个官方版本**的 asar 盖回来，无任何哈希校验 | `卸载还原-修复版.bat:32-33`；要求见 `PL/docs/MAINTENANCE.md:51` |
| L9 | Escalation/权限不足（装在 Program Files 等非用户可写目录） | 解包/补丁/改名全部失败，但 DSH 已关闭；无 UAC 提升逻辑 | `一键安装.bat:42`、`apply-driver.mjs:47-51` |
| L10 | 多安装/多 profile 机器 | `taskkill /IM` 与映像名匹配会打到别的 DSH 实例 | `一键安装.bat:42`、`restart-desktop.js:187,262-271` |
| L11 | 磁盘满/断电发生在解包提交中间 | 留下 `app.dshpurge-next|prev|recover.json`，无自动恢复扫描，只能人工读 recover.json | `extract-asar.js:377-409`；唯一的自动放回在 `core.js:2012-2018` |
| L12 | `local-plugins\*.tgz` 被清理 | `dependencies` 仍指向该文件，后续 `pnpm install` / 宿主校验失败，插件静默消失 | `register-bundle.mjs:22-24`、`一键安装.bat:52` |

### F. 结构与可测性

1. 换包逻辑分散在 6 个文件（`desktop.js`、`desktop-handoff.js`、`windows-asar-handoff.js`、`macos-asar-handoff.js`、`restart-desktop.js`、`core.js`），phase 字面量在 4 处重复（`windows-asar-handoff.js:104`、`:125`、`:194`；`macos-asar-handoff.js:8`），没有单一状态定义源。
2. 唯一能测“真实 Electron 父进程退出后助手存活”的用例在 `scripts/check-windows-job-handoff.ps1`，而它验证的正是 A1 里那条跑不通的分支——**这份回归在 1.6.91 上不可能通过**（除非在别处修了引号）。`PL/AGENTS.md:189` 要求 `PURGE_ELECTRON_EXEC` + `test/windows-electron-handoff.test.mjs` 验证，说明作者知道需要真机，但产物与测试不同步。
3. 安装器与插件是两套代码（bat 不懂 handoff 状态机，`apply-driver` 不读 `.purge-handoff.json`），同一个动作有两种“成功”定义。

## 对 Purge+ 的启示

| 主题 | 继承 | 重构 | 替换 / 删除 |
| --- | --- | --- | --- |
| 解包 | `extract-asar.js` 的“先全量校验再落盘 + side/prev 原子提交 + recover.json”（`:466-480`、`:377-409`） | 把 commit 合约抽成独立模块并带自检入口 | — |
| 备份 | 唯一 token 命名 + 前后 sha256（`windows-asar-handoff.js:20,54,68,87`） | 备份名带 `size+mtime+sha256` 前缀，恢复前强制校验，统一一份实现（删掉三处固定 `.bak` 覆盖写） | 旧 `restart-desktop.js` / wscript 路径 |
| 等待退出 | “按可执行文件全路径匹配、不按映像名”（PS1 `:57-60`） | 用原生 exe（C#/Rust）以 argv 数组 `CreateProcess` 起助手，**不要**再拼 PowerShell 命令行；Job 成员检测保留思路 | PowerShell/WSH 整套胶水 |
| 状态机 | phase 命名与 `.json`+`.log`+broker/launch 四工件 | 单一 phase 枚举 + 每 phase 的“可判定证据”写进一张表，Windows/macOS 共用同一集合（补上 macOS 已有的 `archive_reappeared`/`backup_missing`） | JS 侧派生 `helper_stopped` 的隐式规则 |
| 安装顺序 | — | **先验证后关闭**：解包到旁路目录 → 校验 `app/package.json` + runtime link → 备份 profile `package.json` → 才允许 kill；任一步失败立即回滚并保持 DSH 可启动 | 现有“先 taskkill 再出错”的顺序 |
| profile 写 | 语义（dependencies + bundles + plugins 都动） | 原子写 + 前置备份 + 解析失败即中止（绝不 `data={}` 覆盖） | 现有两个 `.mjs` |
| 卸载 | “保留 `prompt-inject.md`”的不变量 | 恢复前校验哈希/版本；`rmdir` 与 `move` 顺序反转（先就位再删旧）；清单化残留并汇报 | 靠 `dir /b` 猜备份 |
| 宿主耦合 | `--updated` 前台、stdout 抓 URL 这类“能用但脆”的技巧可以保留为降级路径 | 换成宿主可声明的接口或环境变量；所有隐式契约集中登记并加版本探测 | 86 条源码文本补丁 + `bin.js` import 注入 + 前景窗口 hack 这一整条路线；Purge+ 应改为插件侧 API/Cordis 扩展，从根上取消“换包”这个动作 |
| 交付形态 | 离线兜底思路 | 单一安装器（幂等、可重入、带 `--dry-run`/`--repair`/`--rollback`、UAC 感知、结构化日志、退出码约定） | 四个 bat + 两份内容相同的“修复版” |

一句话总结：**这一层的价值不在“能换包”，而在它把“换包会失败”的每种姿势都写进了日志和状态机**；Purge+ 若继续走宿主改源码的路线，必须把助手做成一个可单测的原生程序、把 phase 定义成唯一数据源、并把安装器改成“验证成功才允许动用户进程”。而最省事的替代方案是取消换包：把能力做进插件运行时，就不需要等待退出、不需要 Job Object、也不需要 `app.asar.purge-<token>.bak`。
