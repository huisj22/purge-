# 故障注入结果（FAULT_INJECTION_RESULTS）

执行日期：2026-11-19 · 环境：Windows 11 / Node v24.1.0
测试入口：`node --test tests/phase4-fault-injection.test.ts`（Level 3）
辅助探针：`scripts/phase4/probes/*`（证据在 `evidence/probe-*.txt`）

> 所有用例在 `mkdtemp` 临时目录或内存 SQLite 中运行；未触碰真实宿主，未写入项目源码目录。
> 下表的「结果」列全部来自实际执行，不引用任何自报告。

---

## C1 文件操作故障（5 例，5 通过）

| 用例 | 注入方式 | 期望 | 实际 | 结果 |
| --- | --- | --- | --- | --- |
| 空配置文件 | 写入空白 `config.json` | 按默认值运行，且**不改写**用户文件 | port=7801，文件内容保持 `"   \n"` | ✅ |
| 损坏 JSON | 写入 `{ oops` | 报 `schema_invalid`，文件保持原样 | 拒绝加载，内容未变 | ✅ |
| 目标被目录占用 | 把 `config.json` 建成目录 | 报 `unwritable` | 抛出 `PurgeError(unwritable)` | ✅ |
| 父路径退化为文件 | 快照后把 `b-dir` 换成普通文件 | 报失败并**回滚** | `failed=[b.txt]`、`rolledBack=true`、a.txt 回到恢复前内容 | ✅ |
| 未 verify 就 commit | 事务写入后直接 commit | 拒绝提交 | 抛 `cannot commit before verify()` | ✅ |

**无法安全模拟（BLOCKED）**：磁盘写满（ENOSPC）、只读文件系统、文件被其他进程独占锁定（Windows 需 `FILE_SHARE_NONE` 打开句柄，需原生调用）。上述三项在报告中不标记为通过。

## C2 配置中心故障（3 例，3 通过）

| 用例 | 期望 | 实际 | 结果 |
| --- | --- | --- | --- |
| 外部改动后提交 | `conflict`，不覆盖外部内容 | `conflict`，外部内容保留 | ✅ |
| 两客户端并发提交（同一 expectHash） | 恰好一个成功，另一个 `conflict`，历史与成功数一致 | 1 成功 / 1 `conflict`，历史 1 条 | ✅（修复前：`integrity_failed` + 历史丢失） |
| 历史索引损坏 | 读取时报错，不静默返回空 | 抛 `schema_invalid` | ✅ |

## C3 恢复故障（4 例，4 通过）

| 用例 | 期望 | 实际 | 结果 |
| --- | --- | --- | --- |
| 连续恢复两次 | 幂等，最终状态一致 | 两次后内容 = 快照内容 | ✅ |
| 同一快照并发恢复 | 串行化，均成功 | 两个结果 `failed=[]` | ✅ |
| 对象被篡改（>32KB 文件） | 恢复前发现损坏，**不动目标文件** | `failed>0`，目标仍为 `v1` | ✅ |
| 快照记录"当时不存在" | 恢复时删除该路径 | 删除成功、`failed=[]` | ✅ |

**修复前对照**：探针 D（`evidence/probe-d-restore*.txt`）证明旧实现会留下"a.txt 已改、b.txt 未改"的混合状态（`PARTIAL_RESTORE_CONFIRMED`）；修复后同一探针返回 `ROLLED_BACK`。

## C4 工作流故障（5 例，5 通过）

| 用例 | 期望 | 实际 | 结果 |
| --- | --- | --- | --- |
| 首步失败 | 后续步骤 skipped，run failed | 与期望一致 | ✅ |
| 中间步骤失败 | 前序 succeeded、后续 skipped | 一致 | ✅ |
| 并发 resume 同一 run | 第二次 `conflict` | `/already active/` | ✅ |
| 持久化输出损坏 | `getRun` 不崩，标记 unparsable | `{unparsable:"not json"}` | ✅ |
| 崩溃遗留 running | 启动修复为 `interrupted` | run 与 step 均 interrupted | ✅ |

**修复前对照**：探针 G 显示取消需 1213 ms 且 `run=cancelled / step=succeeded`；修复后 107 ms 返回、step=cancelled（`evidence/probe-fg-fixed.txt`）。

## C5 调度故障（3 例，3 通过）

| 用例 | 期望 | 实际 | 结果 |
| --- | --- | --- | --- |
| job spec 行损坏 | `list()` 抛错，不伪造数据 | 抛错（JSON 解析失败） | ✅ |
| 一个 tick 窗口内三次 tick | 只执行一次 | runs=1 | ✅ |
| 连续 3 个周期都失败 | 仍按周期执行（不永久停摆） | calls=3，state=enabled | ✅（修复前：calls=1） |

## C6 规则/技能边界（3 例，3 通过）

| 用例 | 期望 | 实际 | 结果 |
| --- | --- | --- | --- |
| 空/超长/含 `../` 的规则 id | 全部拒绝 | 三个都抛 `invalid` | ✅ |
| Unicode 标题与正文 | 正常保存 | 保存并回读成功 | ✅ |
| 含空格/中文目录的技能 | 正常导入 | `files>=2` | ✅ |

## C7 更新故障（4 例，4 通过）

| 用例 | 期望 | 实际 | 结果 |
| --- | --- | --- | --- |
| sha256 不符 | `integrity_failed`，不激活 | 与期望一致，`activeVersion` 仍为空 | ✅ |
| 相对路径来源（未声明协议） | 索引校验失败 | `/source must be/` | ✅（修复前：`plan()` 绕过校验） |
| staging 目录缺失时 activate | 报错，旧版本指针不变 | ENOENT，`activeVersion` 未变 | ✅ |
| prune | 保留 active + 最近版本 | 删除了旧版本，保留 0.5.0 | ✅ |

## E 并发一致性（2 例，2 通过）

| 用例 | 期望 | 实际 | 结果 |
| --- | --- | --- | --- |
| 50 个并发审计追加 | 哈希链完整 | `ok=true, checked=50` | ✅ |
| 5 个并发快照（同一文件） | 5 个独立且可验证 | 5 个不同 snapId，全部 verify 通过 | ✅（修复前：并发写同一对象会抛 `unwritable`） |

---

## 汇总

| 类别 | 用例数 | 通过 | 失败 | 阻塞 |
| --- | --- | --- | --- | --- |
| C1 文件 | 5 | 5 | 0 | 3（ENOSPC/只读挂载/独占锁） |
| C2 配置 | 3 | 3 | 0 | 0 |
| C3 恢复 | 4 | 4 | 0 | 0 |
| C4 工作流 | 5 | 5 | 0 | 1（真实 kill -9） |
| C5 调度 | 3 | 3 | 0 | 1（运行中取消 job：功能缺失） |
| C6 规则/技能 | 3 | 3 | 0 | 0 |
| C7 更新 | 4 | 4 | 0 | 1（进程中断：用 staging 缺失模拟） |
| E 并发 | 2 | 2 | 0 | 0 |
| **合计** | **29** | **29** | **0** | **6 项显式 BLOCKED** |

## 故障注入发现的新问题（修复前不存在于测试集）

| Issue | 说明 | 处理 |
| --- | --- | --- |
| P2-11 | 并发 `capture()` 写同一内容对象时，Windows 上 `rename` 竞争导致 `unwritable` | FIXED：CAS 写入改为幂等（失败后校验既有对象） |
| P2-12 | `UpdateService.plan()` 接受外部传入的 index 时跳过 schema 校验 | FIXED：`plan()` 内统一 `validateIndex` |
