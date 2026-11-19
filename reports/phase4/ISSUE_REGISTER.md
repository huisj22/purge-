# ISSUE REGISTER（Phase 4 问题清单）

基准：`8457ab7` · 审计日期 2026-11-19
状态词：`OPEN` / `FIXED` / `WONTFIX`（需说明）/ `DEFERRED`
证据：`reports/phase4/evidence/*`、`reports/phase4/audit/*`、测试文件

| ID | 模块 | 问题 | 等级 | 状态 | 证据（类型） |
| --- | --- | --- | --- | --- | --- |
| P0-01 | API/Security | 无鉴权；接受跨源 `text/plain` 写入；`host` 可绑 `0.0.0.0`；恢复/配置类端点可被浏览器跨站触发 | **P0** | FIXED | 探针 E（VERIFIED） |
| P1-01 | Core | `Kernel.start()` 首次失败后永久锁死（rejected Promise 被缓存），服务永不重试 | **P1** | FIXED | 探针 B（VERIFIED） |
| P1-02 | Adapter/Inspector | 「宿主是否被修改」用 mtime 启发式 → 干净的解包宿主被判 high/fail | **P1** | FIXED | 探针 A（VERIFIED） |
| P1-03 | Recovery | `restore()` 非事务：部分失败留下混合状态，无自动回滚、不自动预拍 | **P1** | FIXED | 探针 D（VERIFIED） |
| P1-04 | Plugins | 能力白名单不是沙箱，但文档表述为"隔离"；无超时/资源限制 | **P1** | FIXED（边界如实声明 + 超时 + 信任声明） | 探针 H（VERIFIED） |
| P2-01 | Core | 配置写盘失败后内存态已改变（内存/磁盘不一致，历史为 0） | P2 | FIXED | 探针 K（VERIFIED） |
| P2-02 | ConfigCenter | 并发提交报 `integrity_failed` 而非 `conflict`；历史 index RMW 丢条目 | P2 | FIXED | 探针 C（VERIFIED） |
| P2-03 | Scheduler | 一次瞬时失败后任务永久停摆（`state=failed` 不再被 tick 选中） | P2 | FIXED | 探针 F2（VERIFIED） |
| P2-04 | Workflow | `cancel()` 不中断执行器；run=cancelled 而 step=succeeded；1.2s 才返回 | P2 | FIXED | 探针 G（VERIFIED） |
| P2-05 | Recovery | `SnapshotStore.get()` 只在前 500 条快照里查找，老快照报 `not_found` | P2 | FIXED | CODE_CONFIRMED（`snapshot.ts:180`） |
| P2-06 | Observability | 每次 `append()` 全表 `COUNT(*)`，长跑退化 | P2 | FIXED | CODE_CONFIRMED（`logs.ts:44`） |
| P2-07 | Update | HTTP 抓取无超时；同版本重复激活直接删旧目录无备份 | P2 | FIXED | CODE_CONFIRMED |
| P2-08 | Recovery | 恢复不比较"快照 vs 当前"新旧，覆盖更新内容无提示 | P2 | OPEN（设计约束，见说明） | CODE_CONFIRMED |
| P2-09 | Recovery | 并发 `restore()` 无互斥，后完成者赢 | P2 | FIXED（串行化） | INFERRED |
| P2-10 | Security | `allowActions` 可自我解除策略，缺少"改策略需更高确认" | P2 | OPEN（设计约束） | CODE_CONFIRMED |
| P3-01 | Rules | `compose()` 按 id 字典序，与文档"全局在前"不符 | P3 | FIXED | `tests/ruleskills.test.ts` 中顺序断言 |
| P3-02 | API | 静态资源前缀校验缺路径分隔符 | P3 | FIXED | CODE_CONFIRMED（`server.ts:607`） |
| P3-03 | Core | `removeTreeNoFollow` 静默吞掉 `rmdir` 失败 | P3 | FIXED | CODE_CONFIRMED |
| P3-04 | Skills | `#walk` 循环内 `reduce` → O(n²) | P3 | FIXED | CODE_CONFIRMED |
| P3-05 | Registry | `discover()` 无单飞，并发重复扫盘 | P3 | FIXED | CODE_CONFIRMED |
| P3-06 | Registry | 无注销/移除语义 | P3 | DEFERRED（无需求） | CODE_CONFIRMED |
| P3-07 | Inspector | `dual_shape` 与 `disk_vs_loaded` 对同一事实重复告警 | P3 | FIXED（合并提示） | 实机输出 |
| P3-08 | Workflow | `interrupted` 状态从未被写入（死字段） | P3 | FIXED（启动时标记遗留 running） | CODE_CONFIRMED |
| P3-09 | Observability | 日志无 traceId，无法与 trace 关联（文档声称有） | P3 | FIXED（日志带 traceId） | CODE_CONFIRMED |
| P3-10 | Update | 旧版本永不清理；索引不校验 source 协议 | P3 | FIXED（协议白名单 + prune） | CODE_CONFIRMED |
| P3-11 | Adapter | 标记扫描上限 400 却报告确定结论 | P3 | FIXED（输出 scanned/truncated） | CODE_CONFIRMED |
| P3-12 | Inspector | `integrity.backups` 把"归档存在"当"可回滚快照" | P3 | FIXED（改为引用真实快照） | CODE_CONFIRMED |
| P3-13 | ConfigCenter | 写文件与写历史不原子 | P3 | FIXED（历史先行 + 失败补偿） | CODE_CONFIRMED |
| P3-14 | Rules | 技能 `requires` 只校验格式，无依赖可达性 | P3 | OPEN | CODE_CONFIRMED |
| P3-15 | Workflow | 步骤无幂等键，resume 会重复副作用 | P3 | OPEN | CODE_CONFIRMED |
| P3-16 | Workflow | 同一 run 并发 resume 可能并发执行同一步骤 | P3 | FIXED（run 级互斥） | INFERRED |
| P3-17 | Scheduler | `runNow` 会推进正常调度时间 | P3 | FIXED（runNow 不改 next） | CODE_CONFIRMED |
| P3-18 | Scheduler | 无"取消正在运行的 job" | P3 | DEFERRED | CODE_CONFIRMED |
| P3-19 | Observability | metrics tags 不索引，无法按 host/job 分组 | P3 | OPEN | CODE_CONFIRMED |
| P3-20 | Recovery | `prune()` 只按前 500 快照算引用，可能误删老快照引用的对象 | P3 | FIXED（全量引用集） | CODE_CONFIRMED |
| P3-21 | Security | 审计里的 `risk` 是事前评分，非事后事实 | P3 | DOCUMENTED | CODE_CONFIRMED |
| P3-22 | Update | 无依赖图/版本冲突检查 | P3 | DEFERRED | CODE_CONFIRMED |
| P3-23 | CLI | 帮助未说明 `snapshot capture` 的路径语义 | P3 | FIXED | CODE_CONFIRMED |
| P3-24 | UI | 配置中心/策略端点无 UI | P3 | FIXED（新增配置屏） | CODE_CONFIRMED |
| P3-25 | Recovery | `capture()` 不做写后校验（只有 `verify()` 能发现损坏） | P3 | FIXED（capture 末尾自检） | CODE_CONFIRMED |
| P2-11 | Recovery | 并发 `capture()` 写同一内容对象时 Windows `rename` 竞争 → `unwritable` | P2 | FIXED（CAS 幂等） | 故障注入 E（VERIFIED） |
| P2-12 | Update | `plan()` 接受外部 index 时跳过 schema 校验（校验绕过） | P2 | FIXED（统一 validateIndex） | 故障注入 C7（VERIFIED） |

## 统计

| 等级 | 总数 | 已修 | 未修 |
| --- | --- | --- | --- |
| P0 | 1 | 1 | 0 |
| P1 | 4 | 4 | 0 |
| P2 | 12 | 10 | 2（P2-08 设计约束、P2-10 设计约束） |
| P3 | 25 | 19 | 6（P3-06/14/15/18/19/22，均已标注理由） |

## 修复纪律

- 每个 FIXED 项都有**先失败后通过**的回归测试（见 `REGRESSION_RESULTS.md` 的 "coverage added" 列）。
- 未修项均给出理由与后续建议（见 `NEXT_PHASE_RECOMMENDATIONS.md`）。
