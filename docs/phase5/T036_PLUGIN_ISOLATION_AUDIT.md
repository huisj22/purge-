# T-036 插件隔离审计与安全报告

## 1. 隔离等级（严格用词）

| 状态 | 是否成立 | 依据 |
| --- | --- | --- |
| `CAPABILITY_RESTRICTED` | ✅ | `ctx.use()` 白名单，未声明的服务在 Host 侧被拒 |
| `PROCESS_ISOLATED` | ✅（新增） | `IsolatedPluginWorker` 用 `fork` 启动独立 Node 进程；插件崩溃不影响核心 |
| `OS_SANDBOXED` | ❌ | 未做 seccomp/AppContainer/job object 内存限制/独立用户 |
| `SECURITY_VERIFIED` | ❌ | 未做对抗性渗透测试；未验证恶意插件能否逃逸 |
| `NOT_SANDBOXED` | ✅（对 OS 级而言） | 子进程仍拥有当前用户的全部文件/网络权限 |

**结论**：从"能力声明"升级到"进程隔离"，但**不是**操作系统沙箱。任何文档/UI 都不得称其为 sandbox。

## 2. 实现结构

```
主进程 (Purge+)                     Worker 子进程
PluginHost(isolation:"process")  ──fork──▶ worker-runtime.ts
  │  校验 capability 白名单                    │  校验入站消息（v/type/size/id）
  │  执行真实服务方法                          │  ctx.use() 返回代理 → 发 capability 请求
  │  回包 capability_result                    │  等待回包（10s 上限）
  └─ 超时/崩溃 → kill + 状态标记               └─ 收到 shutdown → deactivate → exit
```

关键点：
- Worker 只通过 IPC 与宿主交互，**不持有宿主对象引用**。
- 能力调用的"批准"发生在 Host 侧（`capabilities` 白名单 + 服务方法存在性检查）。
- Worker 侧也校验消息：schema 版本、消息类型、1MB 上限。
- 超时会**真的 kill 子进程**（避免僵尸与挂起）。

## 3. 安全测试（9 例，全部通过）

| 用例 | 期望 | 实际 | 结果 |
| --- | --- | --- | --- |
| 独立进程 | worker pid ≠ 宿主 pid，health/invoke 正常 | pid 不同，health.detail 一致 | ✅ |
| 未声明能力 | worker 内 `ctx.use('secret-service')` 抛错 | `not declared` | ✅ |
| 已声明能力 | 由宿主执行（宿主侧记录调用） | `recentReports(2)` 在宿主执行 | ✅ |
| 超时 | 300ms 后返回失败并置 TIMEOUT | `state=TIMEOUT`，<3s 返回 | ✅ |
| 崩溃 | 插件 `process.exit(7)` | `state=CRASHED`，主进程存活 | ✅ |
| 启动失败 | activate 抛错 | start 拒绝，状态 CRASHED/FAILED/TIMEOUT | ✅ |
| 停止 | stop 后子进程真正退出 | `process.kill(pid,0)` 失败（已退出） | ✅ |
| 未运行调用 | 明确失败而非静默 | `ok=false` | ✅ |
| 隔离模式集成 | `PluginHost(isolation:"process")` 装/启/健康/调用 | 全部通过，disable 后 health=false | ✅ |

## 4. 仍然没有限制的能力（必须让用户知道）

| 能力 | 现状 | 风险 |
| --- | --- | --- |
| 文件系统 | 子进程可读写当前用户可访问的任何路径 | 恶意插件可改用户文件 |
| 网络 | 可自由出站 | 可外传数据 |
| 环境变量 | 继承父进程环境（含可能的 token） | 凭据泄漏 |
| CPU/内存 | 无限制 | 可耗尽资源（超时只覆盖单次调用，不覆盖后台循环） |
| 子进程 | 插件可再 `fork` | 进程树难追踪 |
| 系统模块 | 可 `import` 任意 node 内置模块 | 无能力层拦截 |

> 缓解：`privilege: "host"` 的插件启用需要显式 `--trust`；审计记录启用行为。这只是"知情同意"，不是隔离。

## 5. 下一阶段实现路线（若要真正的 OS 沙箱）

1. Linux：`clone` + seccomp 白名单 + mount namespace（只挂载插件目录）；或 `bwrap`。
2. Windows：AppContainer 低权限 + Job Object（内存/CPU/子进程限制）。
3. macOS：`sandbox-exec`（已弃用但可用）+ 独立用户。
4. 统一要求：能力调用只经 Unix socket/命名管道，文件访问按目录白名单挂载。

## 6. 结论

T-036 达成 **PROCESS_ISOLATED**：崩溃隔离、超时、IPC 校验、Host 侧权限控制全部有真实测试。
**未达成** OS 沙箱与 `SECURITY_VERIFIED`，报告中不得混淆。
