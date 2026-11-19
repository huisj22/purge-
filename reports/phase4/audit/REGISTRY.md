# B2 · Registry 审计

范围：`src/registry/registry.ts`
方法：代码直读 + `tests/diagnostics.test.ts` 中的缓存/失效用例

## 已确认事实

| 事实 | 结论 |
| --- | --- |
| 重复适配器 id 被拒绝 | 正确（`purgeError("invalid_argument")`，有测试） |
| 未知 hostId 报 `not_found` 并附带已知 id 列表 | 正确（有测试） |
| 快照缓存 + `invalidate()` 生效 | 正确（测试断言两次 inspect 返回同一对象、invalidate 后不同） |
| `inspect()` 在未 discover 时自动发现 | 正确（Phase 3 修复项，有测试覆盖间接路径） |
| 结果按 `resourcesDir|root` 去重 | 正确 |

## 发现的问题

### P3-05 · `discover()` 无单飞（single-flight） — CODE_CONFIRMED

`discover(force)` 每次都会遍历全部适配器并调用 `adapter.discover()`；并发调用（例如 UI 概览 + 诊断同时触发）会重复扫盘、重复 `hostDiscovered` 事件。缓存只在「有结果且未过期」时短路，首次并发没有互斥。
影响：性能与事件噪声；不造成数据错误。

### P3-06 · 没有「注销 / 移除」语义 — CODE_CONFIRMED

`addAdapter` 只能加不能删，`HostRegistry` 无 `unregister`。适配器热替换只能重建实例。当前产品不依赖该能力，属已知限制而非缺陷。

### 无「错误对象进入注册表」风险 — CODE_CONFIRMED

`addAdapter` 只接受 `HostAdapter` 形状的对象，但**不做运行时校验**：传入缺 `discover` 的对象会在调用时抛 `TypeError`，被 `discover()` 的 try/catch 捕获并记入 `errors` 数组，不会污染候选列表。可接受，但错误信息不够具体（会显示 `adapter.discover is not a function`）。

## 并发结论

| 操作 | 是否安全 | 说明 |
| --- | --- | --- |
| 并发 `inspect(id)` | 安全 | 结果幂等，仅可能重复扫一次 |
| 并发 `discover()` | 正确性安全，效率不安全 | 见 P3-05 |
| `inspect` 与 `invalidate` 并发 | 安全 | 最坏情况缓存被覆盖一次 |

## 结论

注册表实现真实、边界清楚（未知 id/重复 id 有明确错误），但缺少单飞与注销语义。P3-05 建议修复（成本极低）。
