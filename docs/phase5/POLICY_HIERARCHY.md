# 权限层级（POLICY_HIERARCHY，P2-10）

## 1. 角色

| 角色 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| `owner` | 全部动作；修改策略；授予/撤销权限；L4 | —（唯一能改策略的角色） |
| `executor` | 在**有效授权**范围内执行 | 不能自授予、不能改策略、不能 L4 |
| `advisor`（AI） | 读取、分析、建议、请求 | 不能执行 L3+、不能授予、不能被当作 owner |
| `auditor` | 只读审计 | 无任何写权限 |

## 2. 等级

| 等级 | 含义 | 例子 |
| --- | --- | --- |
| L0 | READ_ONLY | `host.inspect`、`list*`、`status` |
| L1 | SAFE_OPERATION | `diagnostic.run` |
| L2 | CONTROLLED_WRITE | `config.set`、`snapshot.capture`、`plugin.install`、`job.add` |
| L3 | HIGH_RISK | `snapshot.restore`、`pack.apply`、`pack.revert`、`plugin.enable` |
| L4 | ADMINISTRATIVE | `update.apply`、`policy.grant`、`policy.revoke`、`policy.set` |

未登记动作：按关键字粗分；无法判断时按 **L3**（保守）。

## 3. 判定流程

```
请求 (actor, role, action)
   ↓
level = ACTION_LEVELS[action] ?? 关键字推断 ?? 3
   ↓
role=owner 且 actor==policy.owner ? → ALLOW
role=owner 但 actor≠policy.owner ? → DENY（防自封 owner）
role=advisor 且 level>=3        ? → DENY
level>=4                        ? → DENY（除 owner）
存在未过期且覆盖该 action 的 grant ? → ALLOW(grantId)
actor==本机操作者               ? → ALLOW（L0–L3）
否则                            → DENY
```

风险层（`policy.ts` 的风险评分/确认）与权限层**串联**：先过风险层，再过权限层；任一层拒绝都不执行。

## 4. 策略完整性

| 机制 | 实现 |
| --- | --- |
| 版本 | `version` 每次修改 +1 |
| 哈希 | `policyHash()`（排除 hash 字段、grants 按 id 排序、字段固定顺序） |
| 加载校验 | 哈希不符 → `integrity_failed`，**不降级回默认值** |
| 修改权限 | 仅 owner；executor/advisor 抛 `policy_denied` |
| 审计 | 每次 grant/revoke/set 触发 `onChange` → 写入审计链 |
| 回滚 | 策略文件为普通 JSON，可从备份恢复；恢复后哈希自洽 |

## 5. 授权（Grant）

```jsonc
{
  "id": "grant-xxx",
  "subject": "ci-bot",
  "role": "executor",
  "maxLevel": 2,
  "actions": ["config.set"],     // 可选，方法级收窄
  "grantedBy": "owner@host",
  "grantedAt": "...",
  "expiresAt": "...",            // 可选 TTL
  "reason": "..."
}
```

- `subject: "*"` 表示任意主体（慎用）。
- 过期 → 立即失效（每次判定都看 `expiresAt`）。
- 撤销 → 从数组移除并 +1 版本。

## 6. 已知限制

1. **身份来自调用方声明**：API/CLI 的 actor 是文本，没有密码学身份。本机单用户模型下可接受；多用户/远程场景不成立。
2. **本机操作者默认放行 L0–L3**：这是产品选择（避免每次本地操作都授权），L4 仍强制 owner。
3. **策略存储位置**：`<dataDir>/security/policy.json`，有文件权限的人可直接改（会被哈希检出，但可同时改 hash）。真正的防篡改需要签名/OS 权限。
4. **AI 判定依赖 origin 字段**：调用方必须如实标注 `origin: "ai"`；恶意调用方可以谎报为 human（同 §6.1）。
