# 审计汇总（AUDIT_SUMMARY）

范围：`src/` 全部 38 个 TS 文件 + UI 3 文件 + 18 个测试入口 + 验收脚本。
方法：逐模块阅读 + 可执行探针（`scripts/phase4/probes/*`，全部在临时目录内运行）。
证据等级：`VERIFIED`（跑过）/ `CODE_CONFIRMED`（代码直读）/ `INFERRED` / `NOT_VERIFIED` / `BLOCKED`。

---

## 总览

| 模块 | 审计文件 | 结论 | 关键问题 |
| --- | --- | --- | --- |
| Core Engine | [CORE_ENGINE.md](audit/CORE_ENGINE.md) | 存在 P1 生命周期缺陷 + P2 状态不一致 | P1-01、P2-01、P3-03 |
| Registry | [REGISTRY.md](audit/REGISTRY.md) | 基本可用；并发无单飞、无注销语义 | P3-05、P3-06 |
| Adapter | [ADAPTERS.md](audit/ADAPTERS.md) | ASAR 读取可靠；修改判定启发式错误 | P1-02 |
| Inspector | [INSPECTOR.md](audit/INSPECTOR.md) | 12 条规则实现真实；1 条会系统性误报 | P1-02、P3-07 |
| Config Center | [CONFIG_CENTER.md](audit/CONFIG_CENTER.md) | 哈希守卫有效；并发与写失败处理不足 | P2-01、P2-02 |
| Rules & Skills | [RULES_SKILLS.md](audit/RULES_SKILLS.md) | 围栏与备份真实；组合顺序与文档不符 | P3-01、P3-04 |
| Workflow | [WORKFLOW.md](audit/WORKFLOW.md) | 状态机大体正确；取消不中断 | P2-04、P3-08 |
| Scheduler | [SCHEDULER.md](audit/SCHEDULER.md) | cron 正确；失败即永久停摆 | P2-03 |
| Observability | [OBSERVABILITY.md](audit/OBSERVABILITY.md) | 数据真实、脱敏有效；性能与关联性不足 | P2-06、P3-09 |
| Recovery | [RECOVERY.md](audit/RECOVERY.md) | CAS 正确；恢复非事务 | P1-03、P2-05 |
| Security | [SECURITY.md](audit/SECURITY.md) | 风险模型有效；API 边界失效 | P0-01 |
| Plugins | [PLUGINS.md](audit/PLUGINS.md) | 能力白名单真实但只是「礼貌约定」 | P1-04 |
| Update Center | [UPDATE_CENTER.md](audit/UPDATE_CENTER.md) | 分阶段与摘要校验真实；无超时/覆盖风险 | P2-07、P3-10 |
| UI / CLI / API | [UI_CLI_API.md](audit/UI_CLI_API.md) | 退出码与错误透出基本正确；API 校验不足 | P0-01、P3-02 |

## 被证实的事实（正向）

1. 审计哈希链真实可用：篡改任一行即 `broken`（`tests/storage.test.ts` + 本会话探针）。
2. 事务回滚真实：写入后回读比对，失败可还原原始字节（`tests/recovery.test.ts`）。
3. `expect` 命中数契约默认生效，多命中整条拒写（`tests/packs.test.ts`）。
4. 包导入路径越界被拒（`policy_denied`），技能导入拒绝 `..`/符号链接/超大文件。
5. ASAR 头解析对真实 209 MB 归档有效（65 ms 读出 package.json）。
6. 审计日志脱敏在落库前生效（`tests/logs.test.ts` 断言私密串不出现）。

## 被证伪的事实（负向，均已复现）

| Issue | 声称 | 实际 |
| --- | --- | --- |
| P0-01 | 「变更类端点需要确认，审计留痕」 | 任何本机网页可用 `text/plain` 跨源 POST 直接改配置（探针 E：200，port 7801→7802） |
| P1-01 | 「start() 幂等」 | 失败后永久锁死，服务永不重试（探针 B：attempts 恒为 1） |
| P1-02 | 「无证据 = unknown」 | 干净解包宿主被判 high/fail「未登记的宿主修改」（探针 A） |
| P1-03 | 「恢复必须回读验证，失败保留现场」 | 逐文件尽力而为，失败后一半文件已改、另一半没改（探针 D） |
| P1-04 | 「插件只能拿到声明的服务」 | 只约束 `ctx.use()`；零能力插件可直接 `import("node:fs")` 写任意文件（探针 H） |
| P2-03 | 「失败会记录 attempts 与 lastError」 | 记录属实，但任务同时被永久停摆（探针 F2） |
| P2-04 | 「取消是真取消」 | 不中断执行器；run=cancelled 而 step=succeeded（探针 G，1213 ms 才返回） |

## 审计方法学说明

- 探针均使用 `mkdtemp` 临时目录，运行后清理；未触碰真实 DSH 安装、未改动项目业务代码。
- 每个负向结论都有独立探针输出，保存在 `reports/phase4/evidence/`。
- 未覆盖的部分（真实宿主写入、跨平台、崩溃注入、浏览器渲染）在 `BASELINE.md §9` 标为 BLOCKED / NOT_VERIFIED，**不计入通过**。
