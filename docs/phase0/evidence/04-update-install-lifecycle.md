# 04 · 安装 / 更新 / 迁移生命周期（dsh-purge-community 1.6.91）

分析对象：`pkg/plugin-copy/dsh-purge-community`（只读）。切片文件：`lib/update.js`(1427 行)、`update-http.js`(195)、`update-net.js`(235)、`update-policy.js`(330)、`update-state.js`(235)、`update-install.js`(354)、`update-integrity.js`(49)、`update-mirror.js`(20)、`update-download.js`(24)、`update-socks.js`(49)、`update-secrets.js`(133)、`update-system-proxy.js`(42)、`update-targets.js`(24)、`lib/community.js`(973)、`market-migration.js`(71)、`installed-package.js`(37)、`install-registry.js`(68)、`maintenance-lock.js`(167)、`rollback-transaction.js`(94)、`scripts/bootstrap-install.mjs`(422)、`scripts/install.ps1`(80)、`scripts/install.sh`(72)、`bin/community.js`(274)。

## 职责

这一层负责"插件自己怎么被装上、怎么被换成新版本、换坏了怎么退回来"，不是宿主补丁层：

1. **发现安装位置**：多 profile × 多包名（`dsh-purge` / `dsh-purge-panel` / `dsh-purge-community`）的真实落盘目录，含正在运行的这份代码（`update.js:197-311`）。
2. **列版本**：以本 fork 的 GitHub Releases（tgz + `SHA256SUMS.txt`）为正式通道，上游分支/tag 只作 legacy 只读参考（`update.js:105-108`、`update.js:110-112`）。
3. **受控安装**：验证发行包身份与哈希 → 快照 → 调 `dsh` CLI 安装 → 版本/入口校验 → 迁移配置引用 → 失败回滚（`community.js:691-774`）。
4. **状态与偏好**：把"检查/安装开关"与"代理/镜像/token"分成不同文件，把频道 pin、历史、guard 戳、上游状态分文件落盘（`update-policy.js:11-17`、`update-state.js:18-40`）。
5. **互斥与回滚事务**：非空互斥目录 + `maintenance.lock` 硬链接双名一 inode；快照/校验/回滚/清理/GC（`maintenance-lock.js:51-167`、`community.js:444-690`）。
6. **独立引导器**：在 `node_modules` 尚不存在时完成 下载 → SHA256 → 解包校验 → 调 `migrate`（`scripts/bootstrap-install.mjs:322-373`）。

## 关键实现（带 file:line 证据）

### 1. 更新通道与安装位置

- 通道表把 stable 定义为 fork 自己的 `releases`（无 ref，走发行包），beta 走上游 `beta` 分支并标 `legacy:true`：`update.js:105-108`。
- `findPurgeProfiles()` 只扫 `$DSH_HOME/profiles/*/package.json`，按 `dependencies|devDependencies|optionalDependencies` 命中 `PURGE_PACKAGES`：`update.js:197-224`；`PURGE_PACKAGES` 定义在 `community.js:27`。
- `specTarget()` 区分 `file:`/`link:` 是目录还是 tgz（`update.js:237-250`），避免把 `.tgz` 当目录拼接路径（同类防护另见 `update-install.js:261-279` 的 `filterDirs`）。
- `detectInstallSites()` 三条来源：link 目录、`node_modules/<pkg>` 实路径、正在运行的 `PLUGIN_ROOT`（覆盖不到时补一条 `running:true`）：`update.js:253-311`。
- `planUpdates()` 产出 `git|zip|dsh` 三类作业，并把跳过项写进 `jobs.skipped` 且带原因文案（`update.js:326-367`）。

### 2. 网络传输层（唯一出口）

- 所有更新请求走 `requestUpdate()`：先校验原始 URL 必须是 https、无凭证、host ∈ `UPDATE_HOSTS`，再做镜像改写，最后逐跳校验跳转目标：`update-http.js:156-163`、`update-http.js:168-184`。
- `UPDATE_HOSTS` 白名单 7 个域名（含 `cdn.jsdelivr.net`）：`update-http.js:15`。
- 代理选择顺序 `PURGE_HTTPS_PROXY → https_proxy → HTTPS_PROXY → http_proxy → HTTP_PROXY`，否则只读 Windows 系统代理：`update-http.js:45-54`。
- `NO_PROXY`/`no_proxy` 由 `bypassProxy()` 处理，支持 `*`、`<local>`、可选端口、后缀匹配：`update-http.js:18-29`。
- 系统代理只读：`reg.exe query HKCU\...\Internet Settings`，失败再退 PowerShell；PAC 场景显式报错而不猜：`update-http.js:37-44`、`update-system-proxy.js:24-42`。
- SOCKS5 走代理侧域名解析（ATYP=3 写域名，不做本地 DNS）：`update-socks.js:3-49`；HTTPS CONNECT 与 socks 分支都在 `proxyAgent()`：`update-http.js:73-107`。
- GitHub token 只在 `https://api.github.com` 上附加，且请求前删除调用方塞进来的 `authorization`/`proxy-authorization`：`update-http.js:55-61`；走镜像时显式清空 token：`update-http.js:173`。
- 瞬时网络错误（ECONNRESET/ETIMEDOUT/…）最多重试 2 次，且共用一个原始 deadline、不切换代理/直连：`update-http.js:151-179`、`update-http.js:189-193`。
- 列表类调用一律套 `withBudget()`，超时返回降级值而不是抛到宿主：`update-net.js:49-59`、`update-net.js:10-16`。

### 3. 列版本与降级链

- `listForkReleases()` 60s 进程内缓存（`update.js:501-503`），API 失败 → `releases.atom` 兜底 → 逐个核对 `SHA256SUMS.txt` 里确有本包 tgz 才算可装（`update.js:537-546`、`update.js:567-585`）→ 仍失败则沿用 10 分钟内的旧列表并标记 `stale`（`update.js:582-584`）。
- `checkUpdate()` 显式"永不抛"：列版本异常被吞成 `ok:false + error`（`update.js:774-786`），警告聚合进 `warnings`（`update.js:792-799`），并把面板唯一渲染的 `error` 填成可读原因（`update.js:837-838`）。
- 每个 profile 的磁盘版本单独核对：`profileVersions()` 要求 `pkg.name === 'dsh-purge-community'`（`update-targets.js:5-15`），`summarizeProfileUpdates()` 推出 `hasUpdate` 与 `retryIncomplete`（半成功安装）：`update-targets.js:16-23`。

### 4. 受控安装（stable 通道主路径）

`installForkRelease()`（`update.js:869-988`）——全部失败模式在写盘前拦住：

1. 发行列表为空 / 命中不到 ref → 直接抛（`update.js:870-877`）。
2. 没有已安装目标 → "先用 dsh plugin add 安装社区版"（`update.js:879-882`）。
3. 每个目标：磁盘版本已等于目标则 `skipped:"current"`（`update.js:891-895`）。
4. **先网络+完整性，再备份**：`prepareRelease(manager, release)` 失败时不进入安装也不回滚（注释与代码：`update.js:906-907`）。
5. `manager.backup("before-release-update")` 失败即中止（`update.js:908-909`）。
6. `manager.install(prepared)`（`update.js:910`）→ 内部再 `validateArchive` + 再快照（`community.js:693`、`community.js:703`）。
7. 安装后版本断言：`profileVersions(...).version !== release.version` → 抛"安装后版本验证失败"（`update.js:911`）。
8. 失败且有快照 → `manager.rollback(backup.id)`，回滚结果写进同一份 errors/result（`update.js:923-935`）。
9. 全目标 ok 才写 channel/pin（`update.js:940`），有 applied 才 `pushHistory`（`update.js:941-953`），`reason==="auto"` 且 ok 才落 auto-update guard（`update.js:954`）。

`Maintenance.install()`（`community.js:691-774`）实现细节：

- `validateArchive`：`tar -tzf/-tvzf/-xOzf package/package.json`，路径必须全在 `package/` 下、无 `..`/反斜杠、无非普通文件、包名/版本/`repository.url` 必须匹配：`community.js:931-973`。
- tgz 复制到 `$DSH_HOME/dsh-purge-community/pkgs/<sha256(file)>/`，避免 `file:` spec 指向 /tmp 后失效：`community.js:696-702`。
- 依赖图 checkpoint：`checkpointProfile(profile, install-recovery/<backupId>)` 拷 `package.json`、`pnpm-lock.yaml`、整个 `node_modules`（链接保目标不跟随）：`community.js:712`、`rollback-transaction.js:55-94`。
- 旧浮动 spec（`releases/latest/download/...`）在 `add` 前就地改成本地 file spec，并复查依赖未被并发改动：`community.js:707-722`。
- 通过 `dsh` CLI 安装后立刻读 `node_modules/dsh-purge-community/package.json` 断言 name/version，再跑 `verifyInstalledPackage()`（新进程 `import` 入口，只 import 不 apply）：`community.js:723-729`、`rollback-transaction.js:19-34`。
- 配置只做引用迁移，不做整份覆盖；并发检测失败即抛：`community.js:733-735`；迁移 journal 存 `migrations/<backupId>.json`：`community.js:753-756`。
- bundles 列表先剔除三个旧包名再补 `PACKAGE`：`community.js:746-751`。
- 失败一律 `checkpoint.restore()` + 报出保留的备份号：`community.js:767-772`。
- 成功返回 `restart_required:true` 与"请手动退出并重新打开 DSH"文案：`community.js:758-766`。

### 5. 上游 legacy 通道（隔离目录，不碰现有安装）

- `installUpstreamLane()`：固定 commit → 下载 zip → `verifySourceTree()` 逐文件核对 Git blob sha1 → 拷到 `$DSH_HOME/dsh-purge-upstream/<slug>` → `swapDir()` 交换（交换失败自动回滚）：`update.js:999-1022`、`update-install.js:329-354`。
- `downloadPluginArchive()` 要求 `sourceManifest` 先拿到 commit/tree、tree 不 truncated，路径/模式/重复文件都校验，ZIP 只能有一个根目录：`update-install.js:229-248`、`update-integrity.js:8-29`。
- 结果强制带 `warning`/`error` 文案并声明 `appliedToRunningInstall:false`、`dependencySpec` 提示：`update.js:1037-1068`。
- 老 `legacyApply()` 保留但被显式挡住：正在运行的副本与 `PACKAGE` 目标都会被 skip（`update.js:1103-1111`），git 覆盖失败退 zip 覆盖并各自拍快照（`update.js:1112-1145`）。

### 6. 完整性校验的三条来源

| 来源 | 作用 | 证据 |
| --- | --- | --- |
| 官方 `SHA256SUMS.txt` | 默认通道：按文件名精确匹配一行 sha256 | `community.js:910-916` |
| GitHub API `asset.digest` | **仅当配置了镜像**时改用 API digest（`sha256:` 前缀 64 hex） | `community.js:901-909` |
| 下载字节比对 | `hash(bytes) !== expected` → "安装包 SHA256 校验失败" | `community.js:917-918` |
| Git blob sha1 树 | legacy zip 通道逐文件核对 + 缺失/未登记文件检查 | `update-integrity.js:30-49` |

同时 `prepareRelease` 先做身份/来源硬校验：ref 必须是 `vX.Y.Z`、`ref === v${version}`、`asset`/`sums` 必须等于 `https://github.com/<REPOSITORY>/releases/download/<ref>/...`（`community.js:895-900`）；镜像元数据只用于**取摘要**，从不作为摘要来源（`community.js:903-908`）。

### 7. 维护锁与回滚事务

- 互斥体是**非空目录** `maintenance.guard/`，内含 `token.json`，用 `rename` 原子发布，绝不暴露空锁路径：`maintenance-lock.js:56-65`、`maintenance-lock.js:105-112`。
- 旧名 `maintenance.lock` 用 `linkSync` 指向同一 inode，形成"双名一 inode"的兼容记录；`pair()` 校验 ino/dev 一致：`maintenance-lock.js:139-159`、`maintenance-lock.js:67-70`。
- 回收只认"进程真死"：`kill(pid,0)` 得到 ESRCH，且（PID 复用场景）进程启动时间 > 锁创建时间 + 2s：`maintenance-lock.js:35-43`；启动时间在 Windows 用 PowerShell `Get-Process.StartTime`、POSIX 用 `ps -o lstart`：`maintenance-lock.js:17-27`。
- `LOCK_LOST`：记录文本不符或 inode 对不上（`maintenance-lock.js:15`、`75`、`78`）；`LOCK_UNREADABLE`：连续 3 次读锁失败但非 ENOENT（`maintenance-lock.js:79`）。两者都停止后续写入，不自动恢复。
- 空目录视为可安全 `rmdir`（`maintenance-lock.js:118-119`），未知内容一律 `MAINTENANCE_BUSY`（`maintenance-lock.js:120`）；**没有任何按 age 强删路径**。
- 释放失败保留互斥门，并把 release 闭包登记进 `pendingReleases` 供本进程重试（`maintenance-lock.js:83-104`）。
- 上层 `Maintenance.locked()` 把 `guard.check` 变成 `this.beat`，在每个同步段与 await 后复查归属；提交后 lock 检查失败降级成 `cleanup_warnings` 而不是伪装失败：`community.js:345-370`、`community.js:598-609`。
- 回滚语义：`verify(id)` 校验 manifest 属于当前 home/profile、文件集合与逐文件 sha256、去重对象存在且哈希一致、插件路径白名单（`community.js:561-597`）→ 先拍 `before-rollback` 安全快照（`community.js:615`）→ 反向迁移 journal/alias（`community.js:616-625`）→ 把快照重新打包成 tgz 再走 `dsh` CLI 安装（禁止裸目录 add）（`community.js:626-651`）→ 失败 `checkpoint.restore()`（`community.js:683-688`）。

### 8. 偏好与状态文件（检查 vs 安装分离）

`update-policy.js:11-17` 三个文件 + `update-state.js:18-40` 五个文件：

| 文件 | 关键字段 | 证据 |
| --- | --- | --- |
| `dsh-purge/update-preferences.json` | `autoCheck`(默认 true) / `autoInstall`(取 legacy `autoUpdateOnStart`) / `intervalHours`(1–168，默认 6) | `update-policy.js:11-12`、`39-46`、`81-93` |
| `dsh-purge/update-channel.json` | `proxyUrl` / `githubToken` / `mirrorUrl`（凭据文件，独立写保护） | `update-policy.js:15-16`、`28-38`、`118-120` |
| `dsh-purge/update-status.json` | `checkedAt` / `availableVersion` / `hasUpdate` / `pendingVersion` / `restartRequired` / `installError` / `targets` | `update-policy.js:17`、`200-208`、`256-274` |
| `dsh-purge/channel.json` | `channel`(stable/beta) / `pin`（beta 名不可 pin） | `update-state.js:22-24`、`131-152` |
| `dsh-purge/version-history.json` | 最近 20 条，按 ref 去重 | `update-state.js:26`、`160-165` |
| `dsh-purge/installed-rev` | 安装修订戳 | `update-state.js:30-32`、`167-179` |
| `dsh-purge/auto-update-guard.json` | `{ref,sha,version,at}`，12h TTL，防"没重启→反复安装" | `update-state.js:34-36`、`193-213` |
| `dsh-purge/upstream-state.json` | legacy 通道解压目录/ref/sha | `update-state.js:38-40`、`215-235` |
| `dsh-purge-community/backups|objects|pkgs|downloads` | 快照、去重对象、持久 tgz、下载缓存 | `community.js:339-341`、`698-702`、`919-922` |

分离铁律：`savePreferences()` 只在 `prefFields`/`channelFields` 真被触碰时写对应文件（`update-policy.js:144-157`）；`updateEnv()` 把偏好映射成**仅本次请求**的环境（ALS），不改进程环境（`update-policy.js:96-106`、`update-http.js:7-9`，消费点 `index.js:1559`）；`publicPreferences()` 抹掉 token 与代理凭证（`update-policy.js:107-116`）。

### 9. 包管理器集成与别名迁移

- 安装只走 `dsh` CLI：`resolveDshCli()` 定位 CLI → `repairRuntimeForCli()` 修 `app/runtime` 链接 → `plugin --profile <name> add <file>`（不直接调 pnpm）：`community.js:776-804`。
- 目标 profile 必须真属于 `$DSH_HOME/profiles/<name>`（realpath 比对），否则拒绝：`community.js:780-786`。
- 依赖名白名单 `PURGE_PACKAGES`，回滚残留的 symlink（指向 `restored/`）先摘下并换新 tgz 再 `remove` + `add`：`community.js:810-846`。
- Windows 上先 `realpathSync.native`，避免 8.3/junction 别名把 pnpm store 索引名撑爆：`community.js:838-844`。
- 公开镜像缺 `@dsh-ops/bash-win32-x64` 版本时，只在"registry 确实是 npmmirror + 官方元数据可独立验证"前提下对**这一次** `@dsh-ops` 用官方源重试：`install-registry.js:6-14`、`install-registry.js:49-67`。
- 别名迁移表固定 5 个 ID（`dsh-purge` 及四个子路径）：`market-migration.js:8-13`；`migrateReferences()` 只改 `name:` 标量区间，`id` 不匹配/动态 name（tag/无 range）/手动 `insert` 一律停止并保留原文件：`market-migration.js:21-58`。
- `yaml` 解析器在**安装完成后**才通过 `createRequire(已安装包路径)` 解析，保证 bootstrap 阶段无依赖：`market-migration.js:60-65`。
- 读取安装身份时同时支持 `dsh-purge-community` 与别名 `dsh-purge`，但要求只有一个物理安装：`installed-package.js:8-36`。

### 10. 引导器与脚本

- `bootstrap-install.mjs` 自包含（不 import `lib/*`，注释明示 `:14`）：`trustedURL` 只允许 4 个 GitHub 域（`:18-23`）、`curlReleaseRequest` 用 `--disable --proto =https`、保留 `CURL_CA_BUNDLE`、限字节、丢弃 stderr（`:40-90`）。
- `downloadReleaseFile` 策略：两次 fetch 后第三次系统 curl，每次**从官方 URL 重新开始**，逐跳校验域名，瞬时错误才重试，永久错误（401/403/404/大小/校验）立即停（`bootstrap-install.mjs:92-158`、`:15-16`）。
- `verifyChecksum` 要求校验文件里**恰好一行**匹配文件名（`bootstrap-install.mjs:167-171`）。
- `bootstrapInstall()`：Node ≥18、mode ∈ {web,desktop}、profile 必须已初始化、版本号正则、tar 列目录白名单、解包后 manifest 身份（name/version/repository）三项硬校验，然后以 `ELECTRON_RUN_AS_NODE=1` 跑 `package/bin/community.js migrate <tgz>`（`bootstrap-install.mjs:322-372`）。
- 引导器自带 no-follow 删树实现（`:390-422`），不依赖 `lib/remove-tree.js`。
- `install.ps1`：唯一可定位 DSH 可执行文件（进程 → 卸载表 → 常见目录，多命中即报错，`:11-33`）；必须 `Start-Process -Wait -PassThru` 等 GUI 子系统进程真实退出再读 ExitCode（`:60-66`）；只清理自己创建的三个文件（`:70-79`）。
- `install.sh`：macOS 从 `Info.plist` 取 `CFBundleExecutable` 并校验不越界/非符号链接（`:20-39`）；Linux 用 `DSH_NODE`/`PURGE_DSH_CLI`（`:40-52`）；仓库内用同级 bootstrap，否则 curl 下载 master 版（`:59-72`）。

### 11. Maintenance API 表面

| 能力 | 方法 | 入口 | 证据 |
| --- | --- | --- | --- |
| 列表 | `Maintenance.list()` | CLI `status` / HTTP GET | `community.js:371-394`、`bin/community.js:254`、`index.js:1586` |
| 备份 | `backup(reason)` | CLI `backup` / POST `{op:"backup"}` | `community.js:395-401`、`bin/community.js:256`、`index.js:1595` |
| 回滚 | `rollback(id)` | CLI `rollback <id>` / POST `{op:"rollback"}` | `community.js:610-690`、`bin/community.js:259`、`index.js:1596` |
| 清理 | `pruneLocked(opts)` | CLI `prune` / POST `{op:"prune"}`（keepLast/keepDays/maxTotalBytes 可传） | `community.js:402-404`、`community.js:444-494`、`index.js:1597` |
| 占用 | `usage()` | CLI `usage` / GET `backup_usage` | `community.js:406-412` |
| 对象 GC | `gcObjects()` | prune 内部 | `community.js:414-438` |
| 安装/迁移 | `install(file,{reason})` | CLI `install|migrate <tgz>` | `community.js:691-774`、`bin/community.js:260-265` |

`prune` 保留策略：最近 `keepLast=5` 必留；其余每天最多 1 份、最多 `keepDays=7` 天；最后按 `maxTotalBytes=200MB` 从最旧淘汰，并保护 `protect`（当前回滚目标）与最新一份：`community.js:444-491`。

## 数据流与状态

```
prefs(channel.json/update-preferences.json/update-channel.json)
        │  updateEnv() 注入 ALS（PURGE_HTTPS_PROXY/PURGE_GH_MIRROR/GITHUB_TOKEN）
        ▼
checkUpdate ─ listForkReleases ─ GitHub API / releases.atom / 60s cache / stale 10min
        │            └─ listRemoteVersions(+ upstream head/tags/history/local)
        │  profileVersions(每 profile 磁盘版本) → summarizeProfileUpdates
        ▼
   {ok,hasUpdate,targets,retryIncomplete,lanes,versions,warnings,error}
        │  createUpdateController: reconcile → 检查 → (autoInstall?) → install → record(update-status.json)
        ▼
installForkRelease ─ prepareRelease ─ download(SHA256SUMS, authoritative) ─ downloadArchive(可走镜像)
        │                                   └─ sha256(bytes)==expected，否则不进入下一步
        ▼
Maintenance.locked(acquireMaintenanceLock)
        ├─ backup/snapshot → backups/<id>/{manifest.json,plugins/,settings/} + objects/<sha256>
        ├─ checkpointProfile → install-recovery/<id>/{package.json,pnpm-lock.yaml,node_modules}
        ├─ dsh plugin add <file:tgz> → 包身份 + 入口 import 校验
        ├─ migrateReferences(cordis.patch.yml) → migrations/<id>.json
        ├─ bundles 重写 + prune + checkpoint.finish() → cleanup_warnings
        └─ 任一失败 → checkpoint.restore()（并发改动检测）/ rollback(backup.id)
        ▼
restart_required=true（只提示，不重启）→ rememberUpdate 强制 restartAfter=false
```

状态机要点：`installedVersion()` 读盘（`update.js:138-141`）与 `runningVersion()`（模块求值期快照，`update.js:136-137`）**分开**；`reconcileUpdateStatus()` 只有两者都是合法 semver 才敢清 `pendingVersion`，否则抛错并由 `status()` 转成 `reconciliationError`（`update-policy.js:165-186`、`209-216`）。

## 真实能力清单

| 能力 | 入口 | 实现位置 | 真实现 | 证据 |
| --- | --- | --- | --- | --- |
| 多 profile 安装位置探测 | 面板/CLI | `update.js:253-311` | 是 | 覆盖不到运行副本时补 `running:true`（`:296-309`） |
| 正式通道版本列表 | GET `/dsh-purge/community`、CLI | `update.js:549-586`、`community.js:859-893` | 是 | 只接受 `vX.Y.Z` 且同时有 tgz+sums 的 release（`community.js:871-891`） |
| 列表降级（atom/stale） | 同上 | `update.js:567-585` | 是 | 降级原因进入 `degraded`/`error` 文案 |
| 检查更新永不抛 | `checkUpdate` | `update.js:770-840` | 是 | 列版本 try/catch 兜底 |
| 自动检查/自动安装调度 | activate 时 `updates.start()` | `update-policy.js:289-329`、`index.js:1665` | 是 | 启动 30s 后首次，之后 `intervalHours` |
| 发行包下载（可走镜像） | `prepareRelease` | `community.js:894-925`、`update-download.js:18-24` | 是 | 下载前 host 白名单二次校验 |
| SHA256 校验 | 同上 | `community.js:910-918` | 是 | 校验文件缺失/无有效 sha256 即抛（`:916`） |
| GitHub API digest 交叉校验 | 同上（仅镜像场景） | `community.js:901-909` | 部分 | 未配镜像时该分支不执行 |
| 归档结构/身份校验 | `validateArchive` | `community.js:931-973` | 是 | 依赖外部 `tar`（`:934-937`） |
| 备份（内容寻址去重） | `backup`/POST | `community.js:495-560` | 是 | ≥32KB 文件入 `objects/<sha256>`（`DEDUPE_MIN` `:237`） |
| 备份完整性校验 | `rollback` 前置 | `community.js:561-597` | 是 | 逐文件哈希 + 去重对象哈希 + 插件路径白名单 |
| 回滚（快照→tgz→CLI 安装） | `rollback <id>` | `community.js:610-690` | 是 | 失败进 `checkpoint.restore()`（`:683-688`） |
| 依赖图 checkpoint/恢复 | install/rollback | `rollback-transaction.js:55-94` | 是 | 恢复前检测并发改动（`:78`） |
| prune + GC | `prune`/POST | `community.js:444-494` | 是 | 三层保留策略 + 引用式 GC |
| 占用统计 | `usage`/GET | `community.js:406-412` | 是 | 跳过符号链接（`:49-71`） |
| 维护互斥 | install/backup/rollback/prune | `maintenance-lock.js:51-167` | 是 | 非空目录 + 双名一 inode + PID 生日证明 |
| 更新偏好/凭据分文件 | POST `{op:"preferences"}` | `update-policy.js:39-158` | 是 | 只写被触碰的文件（`:144-157`） |
| 密钥文件权限保护 | 读写 `update-channel.json` | `update-secrets.js:104-133` | 是 | Windows 走 PowerShell DACL 脚本（`:15-103`） |
| 镜像（仅传输） | `mirrorUrl`/`PURGE_GH_MIRROR` | `update-mirror.js:3-20` | 是 | 摘要永远走 `authoritative` 直连（`community.js:904`） |
| HTTP/SOCKS5 代理 + NO_PROXY | `proxyUrl`/`PURGE_HTTPS_PROXY` | `update-http.js:18-107`、`update-socks.js` | 是 | 仅 HTTPS，明文协议被拒（`update-http.js:126`） |
| 上游 legacy 通道（隔离目录） | `op:"upstream"`/beta | `update.js:999-1069` | 是 | 独立目录 + warning 强制展示 |
| 老 git/zip overlay | `applyUpdate(jobs)` | `update.js:1092-1179`、`update-install.js:281-354` | 是（被限制） | 运行副本与社区包目录一律 skip（`update.js:1103-1111`） |
| 别名引用迁移 | install/rollback | `market-migration.js:21-58` | 部分 | 手动 `insert`/动态 name 直接停止（`:46-47`） |
| 独立引导安装器 | `bootstrap-install.mjs` | `:322-373` | 是 | 无 node_modules 也可跑（调 `migrate`，`:363`） |
| Windows/macOS/Linux 入口脚本 | `install.ps1`/`install.sh` | 全文 | 是 | 脚本自身无签名，仅 TLS 信任（`install.sh:70`、`install.ps1:50`） |
| 自动重启宿主 | — | — | **否** | `rememberUpdate` 强制 `restartAfter:false`（`update.js:849`），文案要求手动退出（`community.js:765`） |

## 依赖与耦合

- `update.js` 是聚合层：把 `community.js`（Maintenance/发行包）、`update-net/http/download/mirror`（传输）、`update-state/policy`（状态）、`update-install`（文件系统）、`update-targets`（磁盘证据）串成对外动作 `checkUpdate`(`:770`) / `installForkRelease`(`:869`) / `applyUpdate`(`:1187`) / `switchChannel`(`:1234`) / `switchVersion`(`:1253`) / `autoUpdateIfNeeded`(`:1276`) / `handleUpdateOp`(`:1347`)，末尾再把 50 个旧 API 名整体 re-export（`update.js:1377-1427`）。
- `community.js` 又向下牵 11 个模块：`extract-asar`（`diskFs` 读密封归档）、`remove-tree`、`maintenance-lock`、`atomic-files`、`market-migration`、`update-http`、`runtime-layout`、`instance`（profile/host 解析）、`desktop-identity`、`install-registry`、`rollback-transaction`（`community.js:1-20`）。
- 宿主耦合点：`resolveDshCli()`/`repairRuntimeForCli()` 依赖宿主 `app/runtime` 布局（`community.js:777-779`）；`findAiBase/currentHost` 决定 `aiBase`（`update.js:885`、`community.js:317`）；`compatibility()` 决定快照里记录的 `host_version`（`community.js:534`）。
- 外部进程依赖：`git`（`update-install.js:63-134`）、`tar`（`community.js:934`、`rollback-transaction.js:14`、`bootstrap-install.mjs:354`）、`reg.exe`/`powershell.exe`（`update-system-proxy.js:27,34`、`update-secrets.js:89`、`maintenance-lock.js:21`）、系统 `curl`（`bootstrap-install.mjs:43`）。
- 运行时耦合：`AsyncLocalStorage` 传递更新环境（`update-http.js:7-9`），任何绕过 `withUpdateEnvironment` 的调用都会退回 `process.env`（`update-http.js:8`、`:157`）。
- HTTP 暴露面：`/dsh-purge/community` 单一路由承担状态 + 6 种写操作（`index.js:1578-1605`），`allowPluginRequest` 做来源校验（`index.js:1899`）。

## 局限与缺陷（带证据）

1. **CLI `migrate` 参数是死参数**。`bin/community.js:260-265` 传 `{reason, migrate:true}`，但 `Maintenance.install(file, { reason })` 只解构 `reason`（`community.js:691`）；"迁移"与"安装"唯一差别只是快照 reason 字符串，没有独立迁移路径（对照 AGENTS §12 承诺的"首次安装/迁移"分离）。
2. **别名安装无法被 `Maintenance.install` 正确定位**。安装后校验硬编码 `node_modules/dsh-purge-community`（`community.js:725`），bundles 重写也固定写回 `PACKAGE`（`community.js:746-751`）；而 `installWithDsh` 的 `dependencyName` 默认 `PACKAGE`（`community.js:810`）。别名 `dsh-purge` 的 profile 依赖 `installed-package.js` 兼容读取（`:8-36`），却在写路径上被单边拉回新名，可能出现"依赖名 `dsh-purge` + bundle 名 `dsh-purge-community`"的不一致。
3. **API digest 只在配了镜像时校验**。`community.js:901` 用 `if (mirrorPrefix())` 包住整段官方元数据核对，未配镜像时信任链只剩同一 release 里的 `SHA256SUMS.txt`（`:910-916`），缺少"元数据与归档来自两个通道"的交叉证明。
4. **一次更新会打两份快照**。`installForkRelease` 先 `manager.backup()`（`update.js:909`），`Maintenance.install` 内部又 `this.snapshot(reason)`（`community.js:703`），叠加 `rollback` 里的 `before-rollback` 快照（`:615`），在 200MB 上限下容易把有用快照挤掉（prune 逻辑 `:444-491`）。
5. **跨进程互斥只覆盖 Maintenance 路径**。`applyUpdateInflight` 仅进程内单飞（`update.js:1185-1199`）；`legacyApply`/`overlayFromZip` 只用 `dirBackup` 拍目录快照（`update.js:1114`、`update-install.js:286`），不进 `acquireMaintenanceLock`，因此上游 overlay 与社区安装理论上可并发写同一目录。
6. **锁回收依赖外部命令，且无兜底**。`processBirth()` 在 Windows 调 PowerShell、POSIX 调 `ps`，失败返回 `NaN`（`maintenance-lock.js:17-27`），随后 `ownerDead()` 因 `Number.isFinite(start)` 为假而返回 false（`:41-42`）→ 永久 `MAINTENANCE_BUSY`。这是"不按年龄删锁"的有意代价，但缺少人工解锁/诊断输出。
7. **`legacy` 通道其实指向自己**。`SOURCE_REPO = UPSTREAM_REPO = kingcharleslzy-ai/dsh-purge`（`update-net.js:10-11`），`sourceManifest()` 固定用 `UPSTREAM_REPO`（`update-integrity.js:9`），所以"上游历史 tag/分支"实际校验的是本 fork 自己的 Git 树；`UPSTREAM_WARNING` 文案里的"上游已停止维护"与代码行为不再同一实体（`update.js:110-112`）。
8. **归档校验依赖系统 `tar`**。`validateArchive` 与 bootstrap 解包都用 `System32/tar.exe` 或 PATH 上的 `tar`（`community.js:934-937`、`bootstrap-install.mjs:354`），缺失即失败，且 `-tvzf` 首字符判定（`community.js:955`）对非 BSD/GNU tar 输出格式较脆。
9. **下载缓存无回收**。`pkgs/<sha256(file)>`（`community.js:698-702`）与 `downloads/<ref>`（`:919-922`）只增不减，`prune`/`gcObjects` 只处理 `backups` 与 `objects`（`:414-438`、`:444-494`）。
10. **`op:"rollback"` 在两条路径上语义不同**。`handleUpdateOp` 把 `rollback` 映射到 `switchVersion`，即"切到旧发行版本"（`update.js:1352`、`1253-1270`）；而 `/dsh-purge/community` 的 `{op:"rollback"}` 是快照回滚（`index.js:1596`）。同名不同义，客户端极易误调。
11. **`update-status.json` 的 `error` 会长期残留**。`record()` 用对象展开合并（`update-policy.js:203-208`），清理成功路径只写 `hasUpdate/checkedAt`，`installError`/`targets` 被有意保留（注释 `:183-185`），界面若只看 `error` 会持续报警。
12. **半成功安装的重试窗口较窄**。`retryIncomplete` 允许绕过"待重启"守卫（`update-policy.js:249`、`update-targets.js:22`），但如果 guard 戳在 12h 内且 ref/version 相同，`autoUpdateIfNeeded` 直接 `skipped:"guard"`（`update.js:1295-1300`）——必须先有人手动清 guard 或等 TTL。
13. **上游安装缺包名严格断言**。`installUpstreamLane` 只在 `pkg.name` 存在且 ≠ `dsh-purge` 时报错（`update.js:1011`），没像 `validateArchive` 那样要求 repository 与版本一致（`community.js:963-971`），也没有 SHA256SUMS（只有 Git blob sha1）。
14. **脚本信任锚只有 TLS**。`install.sh:70` 与 `install.ps1:50` 从 `raw.githubusercontent.com/.../master/scripts/bootstrap-install.mjs` 拉取后立即执行，未做签名或哈希钉（AGENTS §12.2 已自述该局限）；`PURGE_VERSION` 仅拼成 `--version=`（`install.sh:62,71`）。
15. **主机防护路径双实现**。`copyTree` 在两处各自实现（`community.js:218-231`、`update-install.js:144-160`），`removeTreeNoFollowSync` 在 bootstrap 里另有一份（`bootstrap-install.mjs:391+`，注释自称"checked against lib/remove-tree.js"），三者需人工同步。
16. **`services.installRelease` 注入会重复 prepare**。`update.js:910` 把已准备好的文件当第三参 `request` 传进 `installRelease(manager, release, prepared)`（`community.js:927-929`），后者再 `prepareRelease()` 重新下载/校验一次；非注入路径正常。测试专用但易误用。

## 对 Purge+ 的启示

**值得原样继承（照抄设计，不必重写）**

1. **通道/来源白名单 + 双重身份断言**：`prepareRelease` 的 `ref===v${version}`、`asset/sums` 必须等于官方前缀、`validateArchive` 的包名与 `repository.url` 校验（`community.js:895-900`、`963-971`）。这套组合能挡住"镜像给什么就装什么"。
2. **镜像只做传输、摘要必须 authoritative**：`mirrorTarget()` 只改写 host（`update-mirror.js:14-20`），`authoritative:true` 时直连取摘要（`update-http.js:162`、`community.js:904`），并把 token 从镜像请求剔除（`update-http.js:173`）。
3. **非空锁目录 + 双名一 inode + 进程生日证明**（`maintenance-lock.js:105-159`）：这是"绝不按年龄删锁"里少数能自证归属的实现，`LOCK_LOST`/`LOCK_UNREADABLE` 的语义也够用。
4. **快照格式（manifest schema + 逐文件 sums + blobs 去重）与回滚前 verify**（`community.js:495-597`）：快照自带校验，回滚前先证明快照没坏。
5. **回滚=重新打包 tgz 再走官方 CLI**（`community.js:626-651`）：避免"裸目录 add 产生缺依赖 link"这类经典坑。
6. **依赖图 checkpoint + 并发改动检测后再恢复**（`rollback-transaction.js:55-94`）：只回滚自己那三个包名的字段，保留别人/用户的后续改动。
7. **偏好与凭据分文件 + 只写被触碰的文件 + 公开视图脱敏**（`update-policy.js:107-158`）。
8. **ALS 级 per-request 环境**（`update-http.js:7-9`）：更新用代理/token/镜像不污染宿主进程。
9. **自包含引导器 + fetch→curl 降级 + 从官方 URL 重新开始**（`bootstrap-install.mjs:92-158`）：可观测的 `stage/host/transport/attempt/code` 诊断，排障友好。

**需要重构**

1. **把 `Maintenance` 拆成 `BackupStore` / `PackageInstaller` / `Policy`**：现在 973 行里混了快照、安装、迁移、锁、GC、兼容性；`locked()` 的 `beat` 穿线（`community.js:343`、`514`、`526`）让每个文件操作都要手写 `this.beat?.()`，极易漏。
2. **依赖名（`dependencyName`）提到一等公民**：安装、校验、bundles 重写、回滚都要显式携带别名（对照缺陷 2），而不是靠 `PACKAGE` 常量。
3. **单一写入门**：`legacyApply`/`overlayFromZip`/`Maintenance.install` 都应进同一把维护锁（缺陷 5），并把 `migrate` 做成真分支（缺陷 1）。
4. **摘要策略统一**：无论是否配镜像，都先取 GitHub API `asset.digest`，`SHA256SUMS.txt` 作交叉验证而不是唯一来源（缺陷 3）。
5. **有界缓存**：`pkgs/`、`downloads/` 纳入 prune/GC，或按 ref 保留最近 N 份（缺陷 9）。
6. **状态文件改成"不可变事件 + 派生视图"**：`update-status.json` 的覆盖式合并（缺陷 11）难排查；改为 append-only 记录 + 计算出的状态。
7. **锁诊断与人工出路**：`ownerDead()` 取不到生日时，输出可读诊断与"确认进程已退出后如何安全回收"的操作指引，而不是只报 busy（缺陷 6）。

**应当替换/删除**

1. **整条 `legacy` 上游 zip overlay 线**（`update.js:999-1179`、`update-install.js:281-354`、`update-integrity.js`）：`SOURCE_REPO` 已指向自身（缺陷 7），Git blob 树校验的重成本换不到真实收益；Purge+ 若需要源码通道，应做成显式"开发模式"并从可信清单来源取。
2. **外部 `tar` 依赖**（缺陷 8）：改用纯 JS 解包 + 结构校验（项目内已有 `zip-extract.js`，tgz 可用 `zlib` + 自写 tar 解析），去掉平台分支与输出格式脆点。
3. **`op:"rollback"` 双语义**（缺陷 10）：拆成 `op:"switch-version"` 与 `op:"restore-backup"` 两个显式操作名。
4. **重复的 `copyTree`/`removeTree` 实现**（缺陷 15）：收敛到单一模块；bootstrap 允许内联，但必须有哈希一致性测试而不是注释承诺。
