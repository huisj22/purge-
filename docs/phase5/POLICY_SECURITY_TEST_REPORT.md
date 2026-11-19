# 权限安全测试报告（POLICY_SECURITY_TEST_REPORT）

命令：`node --test tests/policy-hierarchy.test.ts`（10 例）+ `tests/policy.test.ts`（13 例，Phase 4 风险层）
结果：**10/10 + 13/13 通过**

## 1. 角色与自提权

| 用例 | 期望 | 实际 | 结果 |
| --- | --- | --- | --- |
| 自称 owner 但不是策略 owner | 拒绝 | `deny` + `not the policy owner` | ✅ |
| executor 自我授予 L4 | 拒绝 | `policy_denied`（owner role required） | ✅ |
| advisor 授予自己权限 | 拒绝 | `policy_denied` | ✅ |
| owner 授予 executor L2 | 成功并 +1 版本 | grant 返回 grantedBy=owner | ✅ |
| 撤销后立即失效 | 拒绝 | 撤销前 allow / 撤销后 deny | ✅ |
| TTL 过期 | 拒绝 | 50ms 后 allow → deny | ✅ |
| auditor 无隐式权限 | 拒绝 | `deny` | ✅ |

## 2. AI 边界

| 用例 | 期望 | 实际 |
| --- | --- | --- |
| AI 请求 L3（snapshot.restore） | 拒绝 | `deny` + `AI advisor may not perform L3+` |
| AI 请求 L2（config.set）且无授权 | 拒绝 | `deny`（无 grant） |
| AI 自行授予权限 | 拒绝 | `policy_denied` |

> 说明：AI 在**获得 owner 明确授权**后可以执行 L2 以内的动作；这是"建议 + 审批"模型，不是"AI 自治"。

## 3. 策略完整性

| 用例 | 期望 | 实际 |
| --- | --- | --- |
| 策略文件被改 owner | 加载失败 | `integrity_failed`（hash mismatch） |
| 正常策略 | 哈希自洽 | `policyHash(doc) === doc.hash` |
| 修改策略写入审计钩子 | 触发 `policy_grant` | events 记录 |

## 4. 与风险层的串联

| 场景 | 风险层 | 权限层 | 最终 |
| --- | --- | --- | --- |
| AI 请求 `files.delete`（recursive, 30 路径） | deny（风险 100） | 不会到达 | deny |
| AI 请求 `pack.apply` | confirm（风险 50） | advisor 拒绝 L3 | **deny** |
| 人类 `config.set` 未确认 | confirm | owner 放行 | `confirmation_required` |
| 人类 `config.set` 已确认 | confirm | owner 放行 | 执行 |

## 5. 未验证 / 限制

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 远程/多用户身份伪造 | NOT_VERIFIED / 设计不覆盖 | actor 是声明值，无密码学身份 |
| 策略文件与 hash 同时被改 | 未防御 | 需要签名或 OS 权限 |
| 并发权限修改 | 未测 | 策略写入未加锁（见 REMAINING_RISK P2-15） |
| API/CLI 的 `policy grant` 端点 | 未实现 | 当前只能通过代码/未来 CLI 使用 PolicyStore |

## 6. 结论

- "执行主体不能自行提权"这一目标**已达成**并有测试证明。
- "Policy 完整性"达到**检测级**（篡改必被发现），未达到**防篡改级**。
- 与风险层的串联顺序正确（风险 → 权限）。
