# B9 · Observability 审计

范围：`src/storage/{trace,logs}.ts`、`src/core/logger.ts`、`/api/{traces,metrics,logs}`、UI「观测」屏

## 已确认事实

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| Span 父子关系与 trace 聚合 | 正确 | `tests/storage.test.ts` |
| 失败 span → trace 状态 error | 正确 | 同上 |
| 空窗口 metrics 返回 `null` 而非 0 | 正确（不编造数据） | 同上 |
| 日志脱敏（键名 + 内联串 + GitHub token 形态） | 正确 | `tests/logs.test.ts` |
| 日志按级别/子串/时间过滤 | 正确 | 同上 |
| 日志上限与淘汰计数（`pruned`） | 正确 | 同上 |
| 写库失败不影响主流程（fail-soft + 计数） | 正确 | CODE_CONFIRMED |

## 发现的问题

### P2-06 · 每次写日志都做全表 COUNT — CODE_CONFIRMED

`logs.ts:44`：每次 `append()` 都执行 `SELECT COUNT(*) AS n FROM log`。SQLite 的 COUNT 是全表扫描（除非命中覆盖索引），写日志的代价随行数线性增长，而日志量本身就随运行时间线性增长 → 长跑时形成 O(n²) 总成本。
上限 5000 行时影响可控（每次 ~5000 行扫描），但这是典型的「越跑越慢」隐患，应在内存里维护计数器。

### P3-09 · 日志与 trace 没有关联字段 — CODE_CONFIRMED

`LogRecord` 只有 `ts/level/msg/ctx`。诊断/工作流产生的 span 有 `trace_id`，但日志行里没有 traceId，无法把「某次诊断的日志」和「那次诊断的 trace」直接对上。UI 只能按时间近似关联。`ARCHITECTURE.md` 里「每次派发带 traceId」的表述**在实现中未落地**（文档超前于实现）。

### 日志不轮转成文件

日志只存 SQLite（内存/磁盘单文件），没有文件轮转。对运维来说可接受（数据库自身 WAL），但与「日志轮转」这个常见预期不同，需在文档中说明。

### 多任务关联

metrics 的 `tags` 由调用方传字符串（如 `{level}`），不做索引；`/api/metrics` 只能给全量统计，无法按 host/job 分组。属能力缺口（P3-19）。

## 数据真实性抽查

| 检查 | 结论 |
| --- | --- |
| metrics 是否在无数据时返回 0 | 否（返回 null，正确） |
| trace 列表是否伪造根 span | 否（无根时显示 `(unknown)`） |
| UI 是否在 API 失败时显示成功 | 否（捕获后显示错误卡片） |
| 日志是否含明文凭据 | 否（测试断言私密串不出现） |

## 结论

观测数据是真实的、脱敏有效的、不编造零值。问题集中在性能（P2-06）与关联能力（P3-09），不影响当前正确性，但必须修 COUNT 那一条。
