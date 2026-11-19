# B11 · Security Policy 审计

范围：`src/security/policy.ts` + `PurgeApp.guarded()` + API 调用点

## 已确认事实

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 风险因子可解释（code/weight/note） | 正确 | `tests/policy.test.ts` |
| 同一因子去重 | 正确 | 同上 |
| AI 来源只升不降 | 正确（`ai_origin +10`，且无任何降级路径） | 同上 |
| plugin/scheduler 来源更高风险 | 正确 | 同上 |
| `>=denyThreshold` 拒绝、`>=confirmThreshold` 需确认 | 正确 | 同上 |
| `confirmed:true` 不能越过 `deny` | 正确 | 同上 |
| `forceConfirm` 对只读动作也生效 | 正确（用于 restore/apply/update） | 同上 |
| 策略判定在确定性代码里，AI 无法调用 | 正确（AI 只能产出 ActionRequest） | CODE_CONFIRMED |
| 拒绝时写审计 | 正确（`guarded()` catch 分支写 `:denied`） | CODE_CONFIRMED |

## 发现的问题

### P0-01 · API 层使策略边界可被跨站绕过 — VERIFIED

策略层本身没错，但**执行入口**没有身份与会话语义：

1. 无鉴权：本机任何进程都能调用全部端点。
2. 无 Origin/Referer 校验：探针 E 用 `Origin: https://evil.example` + `Content-Type: text/plain`（CORS 简单请求，浏览器不预检）POST，得到 `200 ok`，配置端口从 7801 改成 7802。
3. 服务端不校验 `Content-Type`：`readJson()` 只看 body 字节，`text/plain` 体照样被当 JSON 解析。
4. `host` 可配置为 `0.0.0.0`：一旦用户为"手机访问"改配置，上述写入通道就从"本机任意网页"变成"局域网任意主机"。

**为什么是 P0**：`POST /api/snapshots/:id/restore` + `confirm:true` 会覆盖文件；`POST /api/config` 会改运行配置。跨站请求是浏览器自动发出的（用户只需访问一个被投毒的页面），不需要用户做任何操作，属于"关键安全边界失效 + 可能数据丢失"。

### P2-10 · `allowActions` 可把高危动作变成 allow — 设计如此，但缺少护栏

`policy.ts` 里 `allowActions` 命中后直接返回 `allow`（风险仍上报）。配置可从 API/CLI 修改，于是"策略"可以被自己解除，且只需一次 `config.set`（本身需要确认，但确认人是同一调用方）。
建议：`allowActions` 的修改本身应要求更高确认等级，或限制为只对 `low/medium` 风险动作生效。

### P3-21 · 审计中的 `risk` 是"判定时"的风险，不是"执行后"的事实

`guarded()` 写入的 `risk` 来自 `evaluatePolicy`，与实际影响范围（例如实际写了多少文件）无关。可接受，但报告中应注明这是"事前评分"。

## 验证：AI 能否降低风险？

| 场景 | 结果 |
| --- | --- |
| AI 提出 `files.delete` + recursive | `deny`（探针/测试） |
| AI 提出 `config.set` | `confirm`（比 human 更高 risk） |
| AI 携带 `confirm:true` | 无法自行提供（API 由调用方传；AI 无凭据通道）→ 但**若** AI 通过 shell 调 CLI `--yes`，则等同人类确认。属平台外风险，需在文档说明 |

## 结论

风险模型与 `guarded()` 的组合是本项目最规范的部分，可解释、可审计、不可通过"建议"降级。但 API 入口把这道门变透明了（P0-01），必须修。
