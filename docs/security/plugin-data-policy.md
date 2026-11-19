# 插件数据策略（PLUGIN DATA POLICY，T055-03）

实现：`src/plugins/data-policy.ts` · 接线：`src/plugins/host.ts`、`src/plugins/isolated-host.ts`、`src/plugins/worker-runtime.ts`
测试：`tests/plugin-data-policy.test.ts`（9 例，全部通过）

---

## 1. 边界声明（先说清楚不是什么）

| 级别 | 是否成立 |
| --- | --- |
| `CAPABILITY_RESTRICTED`（能力白名单） | ✅ |
| `PROCESS_ISOLATED`（独立子进程） | ✅ |
| `HOST_MEDIATED_DATA_ACCESS`（数据经宿主校验） | ✅（本阶段新增） |
| `OS_SANDBOXED`（操作系统级文件隔离） | ❌ |

**插件进程仍以当前用户身份运行，可直接 `import("node:fs")` 读写任意路径。**
`ctx.data` / `ctx.store` 的边界只对"走宿主 API 的访问"生效。任何文档不得把它描述成沙箱。

## 2. 目录规则

| 用途 | 路径 |
| --- | --- |
| 插件程序（版本化） | `<dataDir>/plugins/<name>@<version>/` |
| **插件私有数据** | `<dataDir>/plugin-data/<pluginId>/` |
| 状态文件 | `<dataDir>/plugin-state.json` |

变化：数据不再位于 `<program>/.data`（Phase 5 的实现）。

理由：
1. 升级/重装会替换版本目录 → 旧实现会**丢失数据**；
2. 卸载会删除版本目录 → 旧实现会**默认删掉用户数据**；
3. 数据与代码分离后，权限与保留策略可以独立定义。

兼容：加载插件时若发现旧 `<program>/.data/store.json`，自动迁移到新目录（目标已有数据则不覆盖）。

## 3. 路径校验（宿主侧强制执行）

`PluginDataStore.resolvePath()` 的校验顺序：

1. **插件 ID**：`/^[a-z0-9][a-z0-9._-]{0,63}$/`，拒绝 `..`、分隔符、点开头、超长、非 ASCII。
2. **相对路径规范化**：拒绝绝对路径、盘符、UNC（`\\server`）、`..` 上跳、Windows 设备名（`con/nul/com1…`）、超长（>512）。
3. **词法边界**：`path.resolve(dir, rel)` 必须仍在插件目录内。
4. **逐级 lstat**：路径中任何已存在组件是符号链接 / junction → 拒绝（不跟随）。
5. **realpath 祖先校验**：最近的已存在祖先 realpath 后必须仍在 `plugin-data/` 根内（防 junction、挂载点逃逸）。
6. **体积上限**：读/写 1MB，键名 256B。

拒绝一律返回 `policy_denied` + `state: PLUGIN_DATA_ACCESS_DENIED`，并触发 `onAudit`（`plugin.data.denied`，risk 40）。

## 4. 数据 API

| API | in-process | process（worker） | 校验方 |
| --- | --- | --- | --- |
| `ctx.data.read/write/list/remove` | 直接调用 `PluginDataStore` | IPC → 宿主 `__data__` 通道 | **宿主** |
| `ctx.store.get/set` | 同左 | 同左 | 宿主 |

Worker 侧不做路径判断（避免"两侧不一致"），只转发；宿主拒绝时错误回传给插件。

## 5. 生命周期

| 事件 | 数据行为 |
| --- | --- |
| 首次安装 | 创建 `plugin-data/<id>/` |
| 升级（新版本目录） | 复用同一数据目录（测试断言 `runs` 累计、文件保留） |
| 重装同版本 | 复用 |
| 卸载 `remove(name)` | **保留**数据（`dataKept: true`），只删程序目录 |
| 卸载 `remove(name, {purgeData:true})` | 删除数据并写审计 `plugin.data.purged`（risk 60） |
| 崩溃/超时 | 数据目录不受影响（写入经宿主原子写） |

## 6. 测试证据（9/9）

| 用例 | 结果 |
| --- | --- |
| 拒绝 9 类非法 ID | ✅ |
| 拒绝绝对路径 / `..` / UNC / 设备名 | ✅ |
| 跨插件读写（`../alpha/a.txt`） | ✅ 拒绝，原数据未变 |
| 文件符号链接逃逸 | ✅ 拒绝 |
| 目录 junction 逃逸 | ✅ 拒绝（平台允许时） |
| 核心配置（`config.json`、`security/policy.json`） | ✅ 拒绝，核心文件字节未变 |
| 超限写入（2MB） | ✅ 拒绝 |
| 升级 / 重装 / 卸载保留 / purgeData | ✅ 数据保留与删除符合预期 |
| 拒绝事件审计 | ✅ `plugin.data.denied` 且 target 正确 |
| 进程隔离模式下的 worker 数据访问 | ✅ 合法读写成功、越界被拒 |

## 7. 未解决的问题（明确登记）

| ID | 问题 | 等级 | 说明 |
| --- | --- | --- | --- |
| PD-1 | 插件可用 `node:fs` 绕过 `ctx.data`（宿主无法阻止） | **P2** | 需要 OS 沙箱（seccomp/AppContainer/独立用户）才能根治 |
| PD-2 | 插件数据无配额（可写满磁盘） | P2 | 需要 OS 级配额或定期审计 |
| PD-3 | 数据目录未加密，敏感数据落在明文 | P3 | 与核心数据同等保护级别 |
| PD-4 | 旧 `.data` 迁移只覆盖 `store.json`，其它文件不迁移 | P3 | 旧实现只有 `store.json` |
| PD-5 | 卸载后数据无自动清理策略（无 TTL） | P3 | 有意：默认保留用户数据 |

## 8. 结论

**插件数据边界在应用层成立**：目录分离、ID/路径/junction 校验、跨插件隔离、核心目录保护、拒绝可审计、卸载保留数据均已通过测试。
**但它不是 OS 沙箱**：能直接使用 `node:fs` 的插件仍可越界。该限制已写入 `phase5.5-risk-register`（PD-1），并在进入 Phase 6 的条件中保留。
