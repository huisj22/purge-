# 安全审计（SECURITY_REVIEW）

范围：API 入口、策略层、插件边界、审计链、凭据处理、文件系统操作
证据：`evidence/probe-e-csrf*.txt`、`evidence/probe-hk*.txt`、`tests/phase4-security.test.ts`、`tests/policy.test.ts`

---

## 1. 结论先行

| 判定 | 内容 |
| --- | --- |
| 有 1 项 P0 | API 入口无身份、无来源校验、可绑公网（已修） |
| 有 1 项 P1 | 插件能力白名单被表述为"隔离"，实际不是沙箱（已修：如实声明 + 信任门 + 超时） |
| 策略层本身可信 | 风险模型、拒绝/确认/放行三态、AI 无法降级：全部有测试 |
| 审计链可信 | 哈希链、篡改检测、脱敏：有测试；并发追加也安全 |

---

## 2. P0-01：API 入口（已修）

### 原始状态（VERIFIED，修复前）

探针 E：

```
status: 200, ok: true
portBefore: 7801 → portAfter: 7802
originSent: https://evil.example
contentType: text/plain
PROBE_RESULT=CSRF_WRITE_ACCEPTED
```

四条叠加形成完整攻击链：

1. **无鉴权**：任何本机进程都能调用所有端点。
2. **无 Origin 校验**：浏览器发起的跨站请求照样执行。
3. **不校验 Content-Type**：`text/plain` 属于 CORS 简单请求，**不触发预检**，因此不需要服务器允许跨域，请求就已经执行了。
4. **`host` 可配置为 `0.0.0.0`**：用户为"手机访问"改一行配置，攻击面从本机扩大到局域网。

危害等级：`POST /api/snapshots/:id/restore` + `confirm:true` 会覆盖文件；`POST /api/packs/:id/apply` 会改宿主源码。属于"关键安全边界失效 + 可能数据丢失"→ P0。

### 修复

| 层 | 措施 | 代码 |
| --- | --- | --- |
| 传输 | 带 body 的变更请求必须是 `application/json`，否则 415 | `server.ts` 的 `MUTATING` + `hasBody` 判断 |
| 来源 | 带 `Origin` 且与 `Host` 不同源 → 403 | `isSameOrigin()` |
| 身份 | 配置 `apiToken` 后强制 `Authorization: Bearer`；未配置令牌时**只接受回环来源** | `checkAuth()` |
| 绑定 | 非回环地址 + 无令牌 → 拒绝启动（`refusing to bind`） | `listen()` |

### 验证（修复后）

```
POST text/plain        → 415 unsupported_media_type
POST 跨源 Origin + JSON → 403 cross-origin request rejected
POST 同源 JSON          → 200
bind 0.0.0.0 无令牌     → 拒绝启动
设置 apiToken 后无令牌  → 403；错误令牌 → 403；正确令牌 → 200
POST 无效端口（未授权客户端无法知道令牌）
```

全部由 `tests/phase4-security.test.ts` 覆盖（5 例）。

### 残余风险（未修，需明示）

1. **未实现 CSRF token / 会话**：同源 + Content-Type 的组合能挡住浏览器跨站，但挡不住本机同源页面（例如用户在 `127.0.0.1:7801` 打开恶意脚本）。这一条属"本机即信任边界"的设计选择。
2. **令牌明文存于 config.json**：未加密。文件权限由 OS 保证；磁盘上的明文仍是风险。
3. **无速率限制**：本机高频调用可耗尽 CPU/IO。
4. **跨进程**：两个 Purge+ 实例共享同一数据目录时，没有跨进程锁（配置/快照的互斥只在进程内）。

---

## 3. P1-04：插件边界（已修表述 + 加门槛）

### 原始状态（VERIFIED）

探针 H：声明 `capabilities: []` 的插件直接 `import("node:fs")` 写出文件，`health` 返回 ok。

```
pluginWroteOutsideDataDir: true
fileContent: "plugin bypassed capability system"
PROBE_RESULT=NOT_A_SANDBOX_CONFIRMED
```

### 真实边界（修正后必须这样表述）

| 声称 | 事实 |
| --- | --- |
| 「插件只能拿到声明的服务」 | ✅ 成立（`ctx.use()` 白名单，越权抛 `policy_denied`） |
| 「插件被隔离」 | ❌ **不成立**：插件与宿主同进程，拥有完整 Node 权限 |
| 「插件不能读写宿主文件」 | ❌ 不成立 |

这属于**能力声明机制**，不是沙箱。把它当沙箱用会导致错误的安全判断。

### 修复

1. 清单新增**必填**字段 `privilege: "host" | "declared"`。
2. `privilege: "host"` 的插件启用时必须显式信任（CLI `--yes` / API `confirm:true`），否则 `policy_denied`。
3. `invoke` / `health` 增加超时（默认 5s），避免插件挂死拖垮调用方。
4. 文档（`README`、`ARCHITECTURE`）改为"能力声明（非沙箱）"。

### 残余风险

- 用户一旦 `--trust`，插件拥有**与 Purge+ 相同**的全部权限（包括写真实宿主）。
- 插件间无隔离：同一进程、同一模块图，可通过 `globalThis` 互相干扰。
- 插件在 `activate` 阶段崩溃会标记 `broken`；但运行期未捕获异常会冒泡到调用方（已被超时与 try/catch 包住，不会杀进程）。

**建议（未实施）**：若要运行不可信插件，必须改成子进程 + 受限 IPC + 独立用户，这一层当前不存在。

---

## 4. P2-10：策略可被自己解除（未修，记录设计约束）

`policy.allowActions` 命中后直接 `allow`。修改配置本身需要确认，但"确认"与"修改"由同一调用方完成，因此存在"先自我放行、再做高危动作"的路径。

- 当前护栏：放行仍写审计（`allowlisted` 因子可见）、风险值仍计算。
- 未做：对 `allowActions` 的修改要求更高确认等级、或只允许放行 `low/medium`。
- 建议：下一阶段把"修改策略"列为 `denyThreshold` 之上的特殊动作，需要二次确认 + 审计标记。

---

## 5. 凭据与敏感数据

| 检查 | 结论 | 证据 |
| --- | --- | --- |
| 日志脱敏（键名） | ✅ token/secret/password/authorization/cookie 等键值替换为 `[redacted]` | `tests/logs.test.ts` |
| 日志脱敏（内联串） | ✅ `Bearer xxx`、`token=xxx`、`ghp_...` 形态被替换 | 同上 |
| 审计 detail 脱敏 | ✅ 写库前 `redact()` | `tests/storage.test.ts` |
| API 错误信息是否泄漏内部路径 | ⚠️ 会带上文件路径（便于排障），但不会带凭据 | 手工检查 |
| 插件是否能读凭据 | ❌ 能（进程内）——已在 §3 声明 |

---

## 6. 文件系统安全

| 检查 | 结论 | 证据 |
| --- | --- | --- |
| 包导入路径越界 | ✅ `policy_denied` | `tests/packs.test.ts` |
| 技能导入路径围栏 | ✅ 拒绝 `..`、跳过符号链接 | `tests/ruleskills.test.ts` |
| 静态资源路径穿越 | ✅ 修复后带分隔符校验 | `tests/api.test.ts` |
| 递归删除是否跟随链接 | ✅ 不跟随（lstat + 非递归） | CODE_CONFIRMED |
| 递归删除失败是否静默 | ✅ 修复后抛出 `unwritable` | `tests/phase4-fault-injection.test.ts` |
| 原子写是否保留权限 | ✅ 目标存在时沿用 mode | `tests/config.test.ts`（非 Windows 断言） |
| 写后校验 | ✅ 事务与配置提交都回读哈希 | `tests/recovery.test.ts` |

---

## 7. 审计链

| 检查 | 结论 |
| --- | --- |
| 篡改检测 | ✅ 改任一字段 → `broken` |
| 序列缺口检测 | ✅ 删除中间行 → `broken` |
| 并发追加 | ✅ 50 并发后链完整（Node 单线程 + 同步 append） |
| 链断裂后的行为 | 报告 `broken`，**不自动修复**（正确） |
| 审计覆盖 | 变更类动作均写；只读动作不写（`diagnostic.run` 例外，带 risk=0） |

---

## 8. 安全结论

1. **策略层可信**：风险模型可解释、AI 不能降级、确认不能越过拒绝。
2. **入口层原本不可信**：P0-01 使策略层形同虚设；修复后恢复为"本机可信 + 令牌可选"。
3. **插件层不是安全边界**：只能作为"可信插件"机制；文档已改为如实表述。
4. **剩余最高风险**是本机同源页面与本机恶意进程——当前架构假定"本机操作者是可信的"。
