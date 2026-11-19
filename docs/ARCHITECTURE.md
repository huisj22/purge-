# Purge+ · ARCHITECTURE

版本：v0.1 设计（与 `src/` 实现同步演进）· 日期：2026-11-19

---

## 1. 分层总览

```
┌──────────────────────────────────────────────────────────────┐
│  UI (静态 SPA)            CLI (purgeplus)                    │  ← 表现层
├──────────────────────────────────────────────────────────────┤
│  API (node:http, REST + SSE)                                 │  ← 接口层
├──────────────────────────────────────────────────────────────┤
│  Services: registry | inspector | configcenter | ruleskills   │  ← 领域层
│            workflow | scheduler | observability | recovery    │
│            security | plugins | update                        │
├──────────────────────────────────────────────────────────────┤
│  Core: Kernel(服务注册/生命周期) · EventBus · Config · Log     │  ← 内核层
├──────────────────────────────────────────────────────────────┤
│  Adapters: HostAdapter(DSH/Generic) · Store(SQLite) · FS      │  ← 适配层
└──────────────────────────────────────────────────────────────┘
```

**依赖方向单一**：表现层 → 接口层 → 领域层 → 内核层 → 适配层。领域层不得 import 接口层；适配层不得 import 领域层。

---

## 2. 内核（`src/core`）

### 2.1 Kernel — 服务注册与生命周期

```ts
interface Service { readonly id: string; start?(): Promise<void>; stop?(): Promise<void>; }
class Kernel {
  register<T>(id: string, factory: (k: Kernel) => T): void
  get<T>(id: string): T                      // 未注册 → 抛 KernelError("service_not_found")
  async start(): Promise<void>               // 按注册序启动，失败回滚已启动项
  async stop(): Promise<void>                // 逆序停止
  on(event: string, fn: Handler): Unsubscribe
}
```

不变量：
- `start()` 幂等；重复调用返回同一 Promise。
- 任一服务启动失败 → 逆序停止已启动服务，聚合错误抛出（不留半启动状态）。

### 2.2 EventBus
进程内、同步派发、监听器异常隔离（记录到 logger，不影响其它监听器），每次派发带 `traceId`。事件名常量集中定义（`core/events.ts`）。

### 2.3 Config
- 文件：`<dataDir>/config.json`（主配置）+ `<dataDir>/config/overrides.json`。
- 校验：内置 schema（`core/schema.ts`），**未知字段保留但不生效**，类型错误拒绝启动并给出字段路径。
- 原子写：临时文件 + `fsync` + `rename`；**保留原文件权限**（Windows 不适用）。
- 版本化：每次变更写 `<dataDir>/config-history/<seq>.json` + 变更摘要（字段级 diff）。

### 2.4 Logging
结构化 JSONL，级别 `debug|info|warn|error`，字段 `ts, level, msg, traceId, spanId, ctx`。**强制脱敏**：键名匹配 `token|secret|password|apikey|authorization` 一律替换为 `[redacted]`。

---

## 3. 存储（`src/storage`）

`node:sqlite`（内置）。单文件 `<dataDir>/purgeplus.db`，`PRAGMA journal_mode=WAL`，`foreign_keys=ON`。

```sql
CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE audit(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT, risk INTEGER NOT NULL DEFAULT 0,
  detail TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE
);

CREATE TABLE trace(span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL,
  parent_id TEXT, name TEXT NOT NULL, service TEXT NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER, status TEXT NOT NULL DEFAULT 'running',
  attrs TEXT);
CREATE INDEX idx_trace_id ON trace(trace_id);

CREATE TABLE metric(name TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL,
  tags TEXT, PRIMARY KEY(name, ts, tags));

CREATE TABLE job(id TEXT PRIMARY KEY, kind TEXT NOT NULL, spec TEXT NOT NULL,
  state TEXT NOT NULL, next_run_ms INTEGER, last_run_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);

CREATE TABLE run(run_id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL,
  state TEXT NOT NULL, started_ms INTEGER NOT NULL, ended_ms INTEGER,
  result TEXT, error TEXT);

CREATE TABLE snapshot(snap_id TEXT PRIMARY KEY, label TEXT NOT NULL,
  created_ms INTEGER NOT NULL, root_hash TEXT NOT NULL, manifest TEXT NOT NULL);

CREATE TABLE finding(finding_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, rule_id TEXT NOT NULL,
  severity TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
  evidence TEXT NOT NULL, remediation TEXT, created_ms INTEGER NOT NULL);
```

**审计链**：`hash = sha256(prev_hash || seq || ts || actor || action || target || detail)`；启动时校验链连续性，断链报告为 `broken`（不静默修复）。

---

## 4. 适配层（`src/adapters`）

### 4.1 HostAdapter（核心扩展点）

```ts
interface HostAdapter {
  readonly id: string;                       // 'dsh' | 'generic'
  discover(): Promise<HostCandidate[]>;      // 候选安装（并发探测，去重，排序）
  identify(c: HostCandidate): Promise<HostIdentity>;   // 版本/形态/可信度
  inspect(c: HostCandidate): Promise<HostFacts>;        // 只读取证：布局、配置、修改痕迹
  capabilities(): HostCapabilities;          // 声明支持哪些动作：readConfig/writeConfig/patch/...
}
```

`HostIdentity` 必须区分三件事（原项目最大混淆点）：
1. **磁盘形态**：`sealed`（app.asar 未解包）/ `unpacked`（resources/app）/ `unknown`
2. **进程状态**：`running` / `stopped`（含 pid 证据）
3. **加载状态**：`loaded` / `not_loaded` / `unknown` —— 磁盘上有补丁 ≠ 当前进程已加载

### 4.2 DshHostAdapter（首个真实适配器）
探测顺序（Windows 优先，全平台兼容）：
1. 环境变量 `PURGE_HOST_ROOT`
2. `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources`（桌面安装）
3. `~/.dsh`、`$DSH_HOME`（CLI/Web 安装）
4. macOS `~/Applications|/Applications/DeepSeek Harness.app/Contents/Resources`

识别证据：`resources/app.asar` 或 `resources/app/package.json` 的 `name/version`；`dsh` 子目录下的 `@deepseek-ai/*` 包版本。全部作为 `evidence[]` 返回，不做「猜」。

### 4.3 GenericHostAdapter
任意目录 + `purgeplus-host.json` 清单即可纳管（用于自测与第三方宿主）。

---

## 5. 领域层

### 5.1 Inspector（`src/inspector`）
- 规则 = 纯函数 `(facts) => Finding[]`，规则集注册在 `rules.ts`，每条规则有 `id/severity/category`。
- Finding 必须带 `evidence`（`{path, line?, hash?}` 或 `{probe, output}`），无证据不得产出结论。
- 状态词表（继承原项目并收敛）：`ok` / `pending` / `partial` / `drifted` / `missing` / `unreadable` / `unknown` / `broken` / `disabled` / `not_applicable`。
- **聚合规则**：只有 `broken` 让整体 `broken`；`unknown` 让整体 `unknown`（黄），绝不显示全绿。
- 输出：`DiagnosticReport{ host, level, layers[], findings[], generated_ms }`。

### 5.2 Modification Pack Engine（`src/inspector/packs` + `src/recovery`）
即原项目补丁引擎的泛化。**Pack 是数据，不是代码**：

```jsonc
{
  "schema": "purgeplus.pack/1",
  "id": "dsh-gate-profile", "version": "1.6.91", "target": { "adapter": "dsh", "versions": [">=0.2.1 <0.3.0"] },
  "risk": { "level": "high", "reasons": ["关闭审批", "改写系统提示词"] },
  "rules": [
    { "id": 9, "layer": "code", "file": "user-approval",
      "replacements": [{ "pattern": "...", "replace": "...", "expect": 1 }],
      "markers": ["[dsh-purge]"] }
  ]
}
```

引擎能力（全部有测试）：加载/校验 pack → 解析目标文件 → `plan()`（只读，产出 per-rule 状态与 diff 预览）→ `apply()`（事务）→ `verify()`（回读哈希）→ `revert()`。
**Purge+ 自身不内置任何绕过审批/沙箱/模型安全机制的规则**；此类 pack 由用户导入，平台负责**导入前风险评分、导入后审计、随时回滚**（MASTER PROMPT §07 第 4/5/6 条）。

### 5.3 Config Center（`src/configcenter`）
- 受管对象：宿主配置文件（按 adapter 声明的路径）+ Purge+ 自身配置 + 用户规则/技能。
- 能力：`read/set/unset/diff/history/snapshot/restore/merge`，每次变更走事务 + 审计。
- 冲突检测：目标文件在读取后被外部修改（mtime+hash 双校验）→ `conflict`，拒绝覆盖。

### 5.4 Rule & Skill Center（`src/ruleskills`）
- Rule：`{id, title, scope, match, body, enabled, tags[], version}`，存 SQLite 或 JSON，导出/导入 Markdown+frontmatter。
- Skill：目录 + `SKILL.md`（YAML frontmatter：`name, description, version, tags, requires`），校验 frontmatter、重名、依赖可达性。
- 导入安全检查：路径穿越、超大文件、可执行内容告警（`script` 字段）、来源哈希记录。

### 5.5 Workflow Engine（`src/workflow`）
- 定义：`{id, version, steps:[{id, uses, with, needs[], retry, timeoutMs, continueOnError}]}`。
- 执行：拓扑序 + 同层并行（受 `concurrency` 限制）；状态机 `pending → running → succeeded|failed|skipped|cancelled|timeout`。
- 持久化：每一步落 `run`/`trace`；进程重启后可 `resume`（已完成步骤跳过，正在运行标记 `interrupted`）。
- 步骤执行器注册表：`inspect / config.set / backup / restore / pack.plan / pack.apply / http / shell(受策略) / noop`。

### 5.6 Scheduler（`src/scheduler`）
- 两种触发：`interval`（秒）与 `cron-lite`（5 字段：分 时 日 月 周，支持 `*`、`*/n`、`a,b`、`a-b`）。
- 每 tick（默认 1s）计算 due job，进入队列，受 `maxConcurrent` 限流；同 job 不重叠执行。
- 支持 `pause/resume/runNow/cancel`，`next_run_ms` 持久化，重启不丢。

### 5.7 Observability（`src/observability`）
- `tracer.startSpan(name)` → 父子关系；`timeline` 按 trace 聚合；`metrics` 记录计数/耗时直方图（手写分桶，不引入依赖）。
- Dashboard API 提供：成功率、任务耗时分位、按宿主/步骤聚合、失败 Top-N、最近 trace。

### 5.8 Recovery（`src/recovery`）
事务协议：
```
begin(label)
  ├─ snapshot(paths) → 内容寻址对象库 objects/<sha256>，manifest 落 snapshot 表
  ├─ mutate(...)                                    ← 由调用方在事务内执行
  ├─ verify(expectedHashes)                         ← 回读真实文件哈希
  └─ commit() | rollback()                          ← rollback 用 objects 覆盖，失败保留现场并报错
```
快照去重阈值 32KB（小文件内联进 manifest）。

### 5.9 Security（`src/security`）
- `PolicyEngine.evaluate(action)` → `{decision: allow|confirm|deny, risk, reasons[]}`。
- 风险因子：写宿主文件(+40)、递归删除(+50)、执行外部命令(+30)、网络出站(+10)、读凭据路径(+40)、影响范围(文件数)。
- 阈值：`<30 allow`、`30..69 confirm`（CLI `--yes` / API `confirm:true`）、`>=70 deny`（策略文件可显式放行特定 action，但需审计）。
- 策略在**确定性代码**里判定；AI 建议只能生成 `proposedAction`，必须再过 `evaluate()`。

### 5.10 Plugin System（`src/plugins`）
清单 `plugin.json`：`{name, version, apiVersion, entry, capabilities[], permissions[]}`。
安装：复制到 `<dataDir>/plugins/<name>@<version>/`，记录 sha256 → 校验 → 注册。
权限：插件只能拿到 `capabilities` 声明的服务；越权调用抛 `CapabilityError`。
健康检查：`health()` 导出可选；加载失败标记 `broken` 并保留其余插件可用。

### 5.11 Update Center（`src/update`）
离线优先：`release-index.json`（本地或 URL）→ `check()` 与当前版本比对 → `plan()` 展示将变更内容 → `download/verify(sha256)` → `backup` → `stage` → `verify` → `activate`。
任何阶段失败 → 回到 `backup` 状态并报告具体阶段；**绝不在未验证时报告成功**。

---

## 6. 接口层（`src/api`）

`node:http`，同源托管 UI。统一响应：`{ok:true, data}` / `{ok:false, error:{code,message,detail}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 版本、uptime、服务状态 |
| GET | `/api/overview` | 汇总卡片（宿主数、任务、失败、最近诊断） |
| GET | `/api/hosts` | 宿主候选与识别结果 |
| POST | `/api/hosts/discover` | 重新发现 |
| GET | `/api/hosts/:id/inspect` | 只读取证 |
| GET | `/api/diagnostics` | 最近诊断报告 |
| POST | `/api/diagnostics/run` | 触发诊断（越权/风险走策略） |
| GET | `/api/packs` / POST `/api/packs/import` / POST `/api/packs/:id/plan|apply|revert` | 修改包 |
| GET/POST | `/api/config` `/api/config/history` | 配置中心 |
| GET/POST | `/api/rules` `/api/skills` | 规则与技能 |
| GET/POST | `/api/workflows` `/api/workflows/:id/run` `/api/runs` | 工作流 |
| GET/POST | `/api/jobs` `/api/jobs/:id/pause|resume|run` | 调度 |
| GET | `/api/traces` `/api/traces/:id` `/api/metrics` `/api/logs` | 可观测性 |
| GET/POST | `/api/snapshots` `/api/snapshots/:id/restore` | 恢复 |
| GET | `/api/audit` | 审计链（含链校验状态） |
| GET/POST | `/api/plugins` `/api/plugins/install` | 插件 |
| GET/POST | `/api/update/check|plan|apply` | 更新 |

所有变更类接口带 `confirm` 语义；`deny` 直接 403 并写审计。

---

## 7. CLI（`src/cli`）

```
purgeplus serve [--port 7801] [--data-dir ...]
purgeplus doctor                      # 环境/依赖/数据目录/审计链/一致性
purgeplus host list|inspect <id>
purgeplus diagnose [--json]
purgeplus pack list|import <file>|plan <id>|apply <id> [--yes]|revert <id> [--yes]
purgeplus config get|set|unset|history|diff
purgeplus rule list|add|rm        purgeplus skill list|add|verify
purgeplus workflow list|run <id>  purgeplus job list|add|pause|resume|run
purgeplus snapshot list|restore <id> [--yes]
purgeplus audit [--limit n] [--verify]
purgeplus plugin list|install|enable|disable
purgeplus update check|plan|apply
```
退出码：`0` 成功 / `1` 失败 / `2` 用法错误 / `3` 策略拒绝。

---

## 8. 状态词表（全平台统一）

| 状态 | 含义 | 是否算绿 |
| --- | --- | --- |
| `ok` | 有证据确认成立 | ✅ |
| `applied` | 修改已在磁盘生效（不等于已加载） | ✅（磁盘维度） |
| `pending` | 尚未执行 | ⏳ |
| `partial` | 多目标部分命中 | ❌ 异常 |
| `drifted` | 目标存在但锚点不匹配 | ❌ 异常 |
| `missing` | 目标文件不存在 | ❌（除非声明 not_applicable） |
| `unreadable` | 读取失败 | ⚠️ unknown |
| `unknown` | 证据不足 | ⚠️ 黄，不得显示绿 |
| `broken` | 已确认故障 | ❌ |
| `disabled` | 用户显式关闭 | ✅（软通过） |
| `not_applicable` | 该宿主不承载此行为 | ✅ |

---

## 9. ADR 索引

- `adr/0001-no-bundler-typescript-direct-run.md`
- `adr/0002-sqlite-builtin-instead-of-orm.md`
- `adr/0003-pack-as-data-not-code.md`
- `adr/0004-evidence-or-unknown.md`
