# B4 · Inspector 审计

范围：`src/inspector/{types,rules,diagnostics}.ts`（12 条规则）
方法：逐条读实现 + 用 6 种宿主形态跑规则 + 探针 A

## 规则逐条核对

| 规则 | 是否真实实现 | 触发条件是否合理 | 误报/漏报 | 证据 |
| --- | --- | --- | --- | --- |
| `identity.verified` | 是 | 合理：`confidence` 三态映射到 pass/warn/unknown | 无 | `tests/diagnostics.test.ts` |
| `layout.archive_readable` | 是 | 合理：可解析才 pass，失败 fail 并提示重装 | 无 | 同上 |
| `layout.dual_shape` | 是 | 合理，但只给 warn | 与 `process.disk_vs_loaded` 对同一事实重复告警（P3-07） | 实机诊断输出 |
| `layout.runtime_present` | 是 | 合理 | runtime 缺失时 CLl 安装类动作会失败，评级 low 偏低（INFERRED） | CODE_CONFIRMED |
| `process.probe` | 是 | `running === null` → unknown，正确 | 无 | 探针 A |
| `process.disk_vs_loaded` | 是 | 仅在 shape=both 时判定 | 与上条重复（P3-07） | CODE_CONFIRMED |
| `profile.bundle_declared` | 是 | **曾误报官方 bundle**，本轮前已修（详见注） | 现忽略 `@deepseek-ai/*` 后正确 | Phase 3 实机纠正 |
| `profile.unreadable` | 是 | 合理 | 无 | CODE_CONFIRMED |
| `modification.traceable` | 是 | **不合理**：以 mtime 判定修改 | **系统性误报（P1-02）** | 探针 A |
| `modification.legacy_pack_version` | 是 | 合理 | 依赖 profile 依赖字符串匹配，弱（INFERRED） | CODE_CONFIRMED |
| `integrity.backups` | 是 | **证据强度不足**：把「归档还在」当成「可回滚」 | 归档损坏/被替换时仍 pass（P3-12） | CODE_CONFIRMED |

> 注：`profile.bundle_declared` 在 Phase 3 曾把官方 `@deepseek-ai/dsh-base` 误判为「缺依赖」，已在本轮之前修正。这条历史恰好说明：**规则没有在真实宿主上跑过就不可能正确**。

## 状态机核对

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 无证据是否给 unknown 而非 ok | 规则层面正确（`process.probe` 返回 unknown），但 `modification.traceable` 用推断给 fail | 探针 A |
| 聚合是否 broken > unknown > warn > ok | 正确 | `types.ts:levelFromFindings` + 测试 |
| `not_applicable` 是否排除出分母 | 正确（summary 单列） | CODE_CONFIRMED |
| 是否重复报告 | dual_shape 与 disk_vs_loaded 双告警（P3-07） | 实机输出 |
| 报告是否落库 + 可回溯 | 正确（`finding` 表 + `run` 表） | `tests/diagnostics.test.ts` |

## 发现的问题

- **P1-02**（来源在 Adapter，表现为 Inspector 误报 fail）
- **P3-07** 同一事实（双形态）两条告警，用户看到「2 个警告」其实是 1 件事
- **P3-12** `integrity.backups` 用「归档存在」当作「存在可回滚快照」，与 Recovery 中心实际的快照语义不一致

## 结论

规则框架（Finding/evidence/rootCause/remediation/level）设计良好，且确实产生可解释输出。但「修改判定」这条核心规则建立在错误的启发式上——这是本项目**当前最严重的功能缺陷**之一：它会对最常见的合法状态报警。
