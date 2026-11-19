# B14 · UI / CLI / API 审计

范围：`src/cli/main.ts`（12 组子命令）、`src/api/server.ts`（约 20 个端点）、`src/ui/*`（11 屏）

## API

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 统一响应 `{ok,data}` / `{ok:false,error}` | 正确 | `tests/api.test.ts` |
| 错误码 → HTTP 状态映射（400/403/404/409/422/428/500） | 正确 | 同上（428/409 有断言） |
| 未知路由 404 | 正确 | 同上 |
| 请求体上限（1 MiB）+ 超限返回 400（不是断开连接） | 正确（曾修过一次：改为排空后报错） | 同上 |
| 路径穿越防护 | 部分：`startsWith(resolve(staticDir))` 缺分隔符（P3-02） | CODE_CONFIRMED |
| 变更端点需 `confirm` | 正确（restore/apply/job/install/rule/skill/update） | 同上 |
| 参数校验（缺 path/hostId/schedule） | 正确（`invalid_argument`） | 同上 |
| 状态码是否可能错 | 未发现内部错误被报成 200 | CODE_CONFIRMED |
| 鉴权 / Origin / Content-Type | **缺失（P0-01）** | 探针 E |

### 端点数清点

`/api/health`、`/overview`、`/hosts`、`/hosts/discover`、`/hosts/:id/inspect`、`/diagnostics`、`/diagnostics/run`、`/packs*`、`/rules*`、`/skills*`、`/snapshots*`、`/workflows*`、`/runs*`、`/jobs*`、`/traces*`、`/metrics`、`/logs`、`/audit*`、`/config`、`/managed*`、`/plugins*`、`/update*`、`/policy`。

## CLI

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 退出码 0/1/2/3 语义 | 正确（策略拒绝 → 3；用法错误 → 2） | 代码 + 实机 |
| 危险动作需 `--yes` | 正确（snapshot restore / pack apply / cfg commit / job add 等） | 代码 |
| `--json` 输出 | 正确 | 实机 |
| 错误是否被吞 | `main().catch` 统一打印 `code: message` 并 exit 1 | CODE_CONFIRMED |
| 帮助文本与实际命令一致性 | 存在偏差：`update`/`cfg`/`plugin invoke` 是后期加入，帮助文本已补，但 `snapshot capture` 的 paths 语义未写清（P3-23） | CODE_CONFIRMED |
| 未实现子命令的行为 | 落到 `default` → 打印用法 + exit 2（不假装成功） | CODE_CONFIRMED |

## UI

| 检查项 | 结论 |
| --- | --- |
| 是否显示虚假成功 | 否：所有写操作 `try/catch` 后 `toast(err.message, true)`；列表永远是重新拉取真实数据 |
| 错误提示 | 有（`toast` + 失败卡片） |
| 状态徽章映射 | 与 `statusKind()` 一致；`unknown` 显示为黄（未当绿） |
| 空状态 | 每一屏都有 `.empty` 文案 |
| `packs` 应用按钮 | 有二次确认（`confirm(...)`） |
| 观测屏日志过滤 | 可用（级别下拉 + 刷新） |
| 移动端 / 可访问性 | 未验证（NOT_VERIFIED），无 aria 属性、无键盘导航测试 |
| 版本号显示 | 来自 `/api/health`，非硬编码 |

### UI 与 API 一致性

抽查：UI 调用的 13+ 端点与服务器路由逐一比对，未发现调用了不存在的端点（存在性已用脚本比对）。
**缺口**：`/api/managed`（配置中心）与 `/api/policy` 没有对应 UI 屏，属"API 有、UI 无"（P3-24）。

## 发现的问题

| Issue | 等级 | 概述 |
| --- | --- | --- |
| P0-01 | 严重 | API 无鉴权、无 Origin/Content-Type 校验、host 可绑 0.0.0.0 |
| P3-02 | 低 | 静态资源前缀校验缺分隔符 |
| P3-23 | 低 | 帮助文本未说明 `snapshot capture` 的路径语义 |
| P3-24 | 低 | 配置中心/策略端点缺少 UI |

## 结论

CLI 与 UI 的**诚实性**达标：没有发现"假装成功"的路径，退出码语义正确，错误会透出给用户。API 的功能面完整，但**入口安全缺失**（P0-01）是全局性问题——它抵消了策略层与审计层的价值。
