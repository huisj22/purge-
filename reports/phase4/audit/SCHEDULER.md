# B8 · Scheduler 审计

范围：`src/scheduler/{cron,scheduler}.ts`

## 已确认事实

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| cron 5 字段解析（`*`、步进、列表、区间） | 正确 | `tests/scheduler.test.ts` |
| 周日 7 → 0 归一 | 正确 | 同上 |
| 非法表达式（字段数、越界、步进 0、区间倒置） | 均报错 | 同上 |
| DOM/DOW 的 Vixie「或」语义 | 正确 | 同上 |
| 下次触发时间计算 | 正确（分钟级对齐） | 同上 |
| 同一 job 不重叠执行 | 正确（内存 `#running` 互斥） | 同上 |
| 暂停/恢复 | 正确（恢复会重算 next_run） | 同上 |
| 持久化（重启后 job 仍可读） | 正确 | 同上 |
| 失败记录 attempts/lastError | 正确 | 同上 |
| `runNow` 不影响下次触发 | 正确 | 同上 |

## 发现的问题

### P2-03 · 一次失败让任务永久停摆 — VERIFIED

`#execute()` 失败时把 `state` 置为 `"failed"`（`scheduler.ts:178`），而 `tick()` 只挑选 `state === "enabled"` 的任务（`:145`）。于是：

探针 F2（`probes/fg-scheduler-workflow.ts`）：

```
calls: 1
stateAfterFailure: "failed"
attemptsAfterTenPeriods: 1     ← 时间推进 10 个周期，一次都没再跑
PROBE_RESULT=PERMANENT_STOP_CONFIRMED
```

影响：任何一次瞬时错误（宿主被占用、磁盘暂时满、网络抖动）都会让定时任务静默死亡，且没有任何重试或退避。用户只能靠「去 UI 看状态」发现。

### P3-17 · `runNow` 会推进正常调度时间 — CODE_CONFIRMED

`#execute()` 对成功/失败都执行 `job.nextRunMs = computeNext(schedule, now)`，`runNow()` 也走这条路径。手动跑一次会让定时计划整体后移一个周期。属语义问题（不是错误，但会让使用者困惑）。

### 时间边界

| 场景 | 行为 | 评价 |
| --- | --- | --- |
| 系统时间向前跳 | 下一次 tick 立即触发一次（不会补跑多次） | ✅ 可接受 |
| 系统时间向后退 | job 的 next_run 在未来，最长要等到原时刻 | ⚠️ 可接受 |
| `interval` 秒数为 0 / 负数 / 小数 | 拒绝 | ✅ |
| cron 永不触发（如 2 月 30 日） | `computeNext` 扫 366 天后抛 `invalid_argument` | ✅ |
| next_run 为 null | 不触发 | ✅ |

### 取消

没有「取消正在运行的 job」能力；`remove()` 在 job 运行时会抛 `conflict`（正确），但没有 `cancel`。属能力缺口（P3-18）。

## 结论

cron 解析与互斥是真实可靠的。失败即停摆（P2-03）是必须修的可靠性缺陷：调度器的最基本承诺是「失败后仍按计划继续」。
