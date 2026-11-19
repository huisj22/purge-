# T-036 插件安全测试报告（明细）

命令：`node --test tests/plugin-isolation.test.ts` · 9 例通过（9.3s 的 worker 组 + 0.19s 的集成组）

## 1. 逐项安全控制

| 控制点 | 实现位置 | 验证方式 | 结果 |
| --- | --- | --- | --- |
| 进程分离 | `isolated-host.ts` `fork()` | 断言 `worker.pid !== process.pid`，health 回传的 pid 也不同 | ✅ |
| IPC schema 版本 | 两端都检查 `v === 1` | 版本不符 → Host 记录警告并忽略 | ✅（代码）+ 单测覆盖入站字段 |
| 消息类型白名单 | `worker-runtime.validateInbound` | 未知 type → 回 `invalid message` | ✅ |
| 消息大小上限 | 两端 1MB | 超限 → 拒绝（Worker）/ kill（Host） | ✅（代码路径） |
| 能力声明检查 | Host `capabilityResolver` + Worker `ctx.use` | 未声明 → `not declared` | ✅ |
| 服务方法存在性 | Host 侧仅调用真实方法 | 不存在的方法 → 错误回包 | ✅ |
| 请求超时 | `requestTimeoutMs`（默认 5s） | 300ms 注入 → TIMEOUT + kill | ✅ |
| 启动超时 | `startupTimeoutMs` | activate 抛错 → start reject | ✅ |
| 关闭超时 | `shutdownTimeoutMs` | 关闭失败 → SIGKILL 兜底 | ✅（代码） |
| 崩溃隔离 | `child.on("exit")` | `process.exit(7)` → CRASHED，宿主存活 | ✅ |
| 资源回收 | `stop()` + `kill(pid,0)` 断言 | 子进程确实退出 | ✅ |
| 状态机 | `WorkerState` 8 态 | 非法跳转未发现（状态只由内部推进） | ✅（代码） |

## 2. 攻击面评估（未通过测试证明，仅代码级判断）

| 攻击 | 是否被阻止 | 说明 |
| --- | --- | --- |
| 插件伪造 `capability_result` 冒充宿主回包 | ⚠️ 部分 | Worker 只处理自己 pending 的 id；但 Worker 可主动给任意 id 回包——目前 Host 只用 id 匹配，未加 HMAC。风险有限（插件本来就能拿到返回值）。列为 P3。 |
| 插件发送超大消息耗尽内存 | ✅ | Host 侧 1MB 上限 + kill |
| 插件死循环（同步） | ✅（部分） | 单次 invoke 超时会 kill 进程；若在 `activate` 中死循环则由启动超时覆盖 |
| 插件在后台 setInterval 慢慢耗 CPU | ❌ | 无 CPU 限额 |
| 插件读宿主内存/对象 | ✅ | 独立进程，无共享对象 |
| 插件改审计记录 | ✅（若数据库文件权限允许则 ❌） | 子进程有文件权限，理论上可直接改 SQLite 文件 |
| 插件通过 IPC 请求未声明服务 | ✅ | Host 白名单 |
| 插件请求声明服务的危险方法 | ⚠️ | 白名单是**服务级**，不是**方法级**；例如声明 `snapshots` 后可调用 `restore` |

## 3. 由此产生的待办

| ID | 问题 | 等级 | 处置 |
| --- | --- | --- | --- |
| P2-14 | 能力白名单是服务级，未细化到方法级 | P2 | 下一阶段为每个能力声明允许的方法集合 |
| P3-26 | IPC 回包未加关联校验（HMAC/随机 salt） | P3 | 低风险，记录 |
| P3-27 | 插件可直接修改数据目录文件（含审计库） | P3 | 依赖 OS 权限；需 OS 沙箱才能根治 |

## 4. 结论

- 进程隔离与超时/崩溃处理是**真实实现**，有 9 个用例证明。
- 安全等级：`PROCESS_ISOLATED` + `CAPABILITY_RESTRICTED`（服务级）。
- **不是** `OS_SANDBOXED`，也没有通过任何渗透级验证。
