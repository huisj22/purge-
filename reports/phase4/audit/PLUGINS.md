# B12 · Plugins 审计

范围：`src/plugins/host.ts` + `examples/demo-plugin`

## 已确认事实

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 清单校验（name/apiVersion/entry 相对路径/capabilities 数组） | 正确 | `tests/plugins.test.ts` |
| 内容寻址安装（整树哈希）+ 同版本不同内容 → `conflict` | 正确 | 同上 |
| `entry` 越界（`../outside`）被拒 | 正确 | 同上 |
| 能力白名单：未声明 `ctx.use()` 抛 `policy_denied` | 正确 | 同上 |
| 加载失败只标记该插件 `broken`，不影响其它 | 正确 | 同上 |
| 启停、健康检查、私有 KV 存储 | 正确 | 同上 |
| 删除（先 disable 再删目录 + 清状态） | 正确 | 同上 |
| `invoke` 在未启用时拒绝 | 正确 | 同上 |

## 发现的问题

### P1-04 · 能力白名单不是沙箱，但文档表述容易被理解为"隔离" — VERIFIED

插件代码在**宿主进程内**运行，拥有完整 Node 权限。探针 H（`probes/hk-plugin-config.ts`）：

```
pluginCapabilitiesDeclared: []
pluginWroteOutsideDataDir: true
fileContent: "plugin bypassed capability system"
health: { ok: true, state: "enabled", detail: "wrote file without any capability" }
PROBE_RESULT=NOT_A_SANDBOX_CONFIRMED
```

即：声明"零能力"的插件仍可直接 `import("node:fs")` 写到任意路径。白名单只约束 `ctx.use()` 这一条通道。

影响：
- **安全**：安装第三方插件 = 授予其与 Purge+ 相同的权限（含读写真实宿主）。当前 `install` 只需要 `confirm:true`，UI/CLI 无强提示。
- **诚实性**：`PRODUCT_SPEC` / `ARCHITECTURE` 用"隔离""权限"等词，会让人误以为有沙箱。必须改成"能力声明 + 进程内信任"。

### 无超时 / 无资源限制 — CODE_CONFIRMED

`invoke()` 直接 `await instance.invoke(...)`，没有超时。插件里一个 `while(true)` 会挂住调用方（API 请求永不返回）。同样没有 CPU/内存限制。

### 卸载期间正在执行 — CODE_CONFIRMED（低风险）

`remove()` 先 `disable()`（调用 `deactivate`）再删目录。若插件有进行中的 `invoke`，其代码已被加载进内存，删除文件不影响执行，但 `.data` 目录会被一并删除 → 运行中的插件写 store 会失败（抛错给调用方）。属可接受行为，需文档说明。

### 插件之间的隔离

同一个进程、同一个模块图。两个插件可以互相通过 `globalThis` 或模块缓存干扰（例如都 `import` 同一个可变单例）。**没有任何隔离**（INFERRED，未专门构造攻击）。

## 实际安全边界（必须写进文档）

| 边界 | 是否成立 |
| --- | --- |
| 插件不能调用 `ctx.use()` 未声明服务 | ✅ 成立（有效） |
| 插件不能读宿主文件 | ❌ 不成立 |
| 插件不能写宿主文件 | ❌ 不成立 |
| 插件不能访问审计/凭据 | ❌ 不成立（进程内） |
| 插件崩溃不影响宿主 | ⚠️ 部分（加载期异常被捕获；运行期未捕获异常会冒泡到调用方） |

## 建议（最小可靠修复）

1. 清单增加 `"privilege": "host" | "declared"`；`enable` 时对 `host` 特权插件要求显式 `--trust` 并在审计中记录。
2. `invoke` 增加超时（默认 5s）与并发上限。
3. 文档把"隔离"改为"能力声明（非沙箱）"。

## 结论

插件的**声明式能力检查**是真实且有效的；但它不是安全沙箱。当前实现可以作为"可信插件"机制使用，不能作为"运行不可信代码"的机制。P1-04 的修复重点是**让用户知道这一点**，而不是假装隔离。
