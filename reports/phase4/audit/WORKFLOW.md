# B7 · Workflow Engine 审计

范围：`src/workflow/engine.ts`（DAG / 并行 / 重试 / 超时 / 取消 / 恢复 / 持久化）

## 已确认事实

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 未知 executor 在 validate 阶段拒绝 | 正确 | `tests/workflow.test.ts` |
| 重复步骤 id / 未知依赖 / 自依赖 / 环 | 均正确报错并输出环路 | 同上 |
| 同层并行、受 concurrency 限制 | 正确 | 同上 |
| 依赖步骤在依赖完成前不运行 | 正确 | 同上 |
| 重试（attempts/delay） | 正确，attempts 记录准确 | 同上 |
| 重试耗尽 → 失败 + 下游 skipped | 正确 | 同上 |
| `continueOnError` → partial | 正确 | 同上 |
| 超时 → `timeout` + abort signal 触发 | 正确（测试监听 abort） | 同上 |
| 恢复（resume）：已完成步骤不重跑 | 正确 | 同上 |
| 每步状态落库 | 正确（`run_step` 表） | CODE_CONFIRMED |
| 事件与 trace | 正确（`run.state` 事件、父子 span） | 同上 |

## 发现的问题

### P2-04 · 取消不中断执行器，且产生「run=cancelled、step=succeeded」的混合状态 — VERIFIED

`cancel(runId)` 只把 runId 放进 `#cancelled` 集合；正在执行的 step 的 `AbortController` **不会**被 abort。步骤会继续跑完，然后 run 被标记为 `cancelled`。

探针 G（`probes/fg-scheduler-workflow.ts`）：

```
runState: "cancelled"
stepState: "succeeded"          ← 步骤实际成功
executorActuallyFinished: true  ← 副作用已经发生
msUntilRunReturned: 1213        ← 100ms 就点了取消，1.2s 后才返回
PROBE_RESULT=CANCEL_DOES_NOT_INTERRUPT
```

影响：
1. 用户以为「已取消」，实际写操作已经完成（对 apply/restore 这类步骤后果严重）；
2. 记录自相矛盾（run 取消、step 成功），事后分析会得出相反结论；
3. 若步骤没有 `timeoutMs` 或超时很长，取消可能长时间不返回。

### P3-08 · resume 未把「运行中被中断」的步骤显式标记 — CODE_CONFIRMED

`StepState` 里有 `interrupted` 定义，但没有任何代码路径会写入它。进程崩溃后重启，DB 里留下 `running` 状态的步骤；resume 会把它当未完成重跑（行为可接受），但状态词表里那个状态是死字段，UI/报告无法区分"从未开始"与"跑到一半崩了"。

### 幂等性

`run()` 不是幂等的：同一 workflow 连续调用两次会产生两个 run（符合预期）。但**步骤**没有幂等键，重跑会重复副作用（例如 `pack.apply` 会第二次创建快照）。这一点在 `resume` 语义下可接受，但缺少「步骤级幂等键」是能力缺口（P3-15）。

### 重复执行风险

| 场景 | 是否重复执行 | 说明 |
| --- | --- | --- |
| 同一 run 并发 tick | 无（单进程单循环） | CODE_CONFIRMED |
| 两个客户端同时 `run(workflowId)` | 会产生两个独立 run | 预期行为 |
| resume 两次同一 run | 第二次会把已 succeeded 的跳过；若第一次仍在跑则可能并发执行同一步骤 | **存在风险（P3-16）** |

## 结论

状态机主体是可靠的：验证、并行、重试、超时、持久化、恢复都有真实测试。取消语义（P2-04）必须修——它会让用户对「是否真的停下了」产生错误判断。
