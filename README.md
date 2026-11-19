# Purge+

**Agent 宿主的运维控制台**：发现宿主 → 取证诊断 → 事务式修改 → 编排与调度 → 可回溯审计与回滚。

> 起源：Purge+ 以 `dsh-purge-community@1.6.91` 为研究基础（见 [`docs/phase0/`](docs/phase0/ORIGINAL_PROJECT_ANALYSIS.md)），继承其「对第三方宿主做可回滚修改」的工程能力，并重建为宿主无关的平台：
> 补丁从代码常量变成**数据包**，写盘从「逐条尽力而为」变成**事务**，审计从 jsonl 变成**哈希链**，前端从 662 KB 单文件变成零构建 SPA。

---

## 快速开始

```bash
# 需要 Node ≥ 22.5（使用内置 TypeScript 直跑与 node:sqlite，无编译步骤）
node -v

# 体检（环境/数据目录/数据库/审计链/宿主发现）
node src/cli/main.ts doctor

# 启动 API + UI
node src/cli/main.ts serve
# 打开 http://127.0.0.1:7801
```

常用命令：

```bash
node src/cli/main.ts host list
node src/cli/main.ts host inspect <hostId>
node src/cli/main.ts diagnose [<hostId>]
node src/cli/main.ts pack list
node src/cli/main.ts pack import ./examples/pack-template.json
node src/cli/main.ts pack plan <packId> <hostId>          # 只读预演，不改任何字节
node src/cli/main.ts pack apply <packId> <hostId> --yes   # 事务写入（快照→写→校验→提交）
node src/cli/main.ts pack revert <snapshotId> --yes       # 用快照精确还原
node src/cli/main.ts snapshot capture <label> <path...> --yes
node src/cli/main.ts workflow run healthcheck
node src/cli/main.ts job add nightly healthcheck "0 3 * * *" --yes
node src/cli/main.ts rule add my-rule "标题" --body "规则正文" --yes
node src/cli/main.ts rule compose --workspace .
node src/cli/main.ts skill add ./my-skill
node src/cli/main.ts plugin install ./examples/demo-plugin --yes
node src/cli/main.ts plugin enable purge-example-plugin --yes
node src/cli/main.ts plugin invoke purge-example-plugin recent '{\"limit\":2}'
node src/cli/main.ts update check --index examples/release-index.json
node src/cli/main.ts audit --limit 20
```

退出码：`0` 成功 · `1` 失败 · `2` 用法错误 · `3` 策略拒绝。

---

## 它解决什么问题

| 场景 | 原工具的做法 | Purge+ |
| --- | --- | --- |
| 宿主更新后修改失效 | 逐条补丁看 `applied/pending`，锚点漂移需人工重锚 | 诊断把漂移报成**异常状态**（不是 skipped），并给出文件/行号/候选片段 |
| 装完不知道成没成 | 面板计数 + 自检层 | 磁盘态 / 进程态 / 加载态**三者分开**，无证据一律 `unknown` |
| 改坏之后回不去 | `.bak` 文件 + 快照目录 | 内容寻址快照 + 事务回滚，恢复后逐文件回读哈希 |
| 操作没有记录 | `audit.jsonl`（1 MB 轮转，可被删） | SQLite **哈希链**，断链立即报告 `broken` |
| 想给别的宿主用 | 86 条路径写死在代码里 | `HostAdapter` 接口：加宿主不改核心 |
| 前端改不动 | 662 KB 打包产物 | `src/ui/*` 零构建，刷新即生效 |

---

## 架构（详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）

```
UI(零构建 SPA) / CLI            ← 表现层
API (node:http + 策略 + 审计)    ← 接口层
registry · inspector · packs · workflow · scheduler
observability · recovery · security · plugins · update   ← 领域层
kernel · eventbus · config · logger · schema · atomic    ← 内核层
adapters(dsh/asar) · storage(sqlite)                     ← 适配层
```

关键不变量：

1. **无证据 = unknown**：`ok` 必须能指到文件/哈希/探针输出，否则只能黄。
2. **写必须走事务**：快照 → 写 → 回读校验 → 提交/回滚；「命令返回 0」不算成功。
3. **AI 不能绕过策略**：风险评分在确定性代码里，`>=70` 直接拒绝，`30~69` 需显式确认。
4. **审计不可静默篡改**：`hash = sha256(prev_hash‖seq‖…)`，断链即 `broken`。

---

## 修改包（Modification Pack）

包是**数据**，不是代码。引擎不认识任何具体宿主。

```jsonc
{
  "schema": "purgeplus.pack/1",
  "id": "my-pack", "name": "示例", "version": "1.0.0",
  "target": { "adapter": "dsh", "versions": ["0.2.2-rc.5"] },
  "risk": { "level": "medium", "reasons": ["改写宿主源码"] },
  "rules": [{
    "id": "r1", "layer": "code", "path": "lib/main.js",
    "markers": ["[purge-plus]"],                       // 必须：用于证明「已应用」
    "replacements": [{ "pattern": "原文", "replace": "新文 // [purge-plus]", "expect": 1 }]
  }]
}
```

- `expect` **默认 1**：多命中或零命中都整条拒写（防「宿主复制了相似代码段被连带改错」）。
- `replace` 必须包含至少一个 marker，否则导入即被拒（否则无法区分「已应用」与「宿主本来如此」）。
- `path` 必须在宿主基目录内（越界即 `policy_denied`）。
- 应用用事务；回退用**快照恢复**，不做反向替换（正则有捕获组时反向替换不可逆）。

安全边界（MASTER PROMPT §07）：Purge+ **不内置**任何「关闭审批/沙箱/模型安全」的规则；这类内容只能由使用者自行导入，导入即被风险评分、审计与可回滚。

---

## 开发

```bash
node --test "tests/**/*.test.ts"   # 当前 140 项，全绿
pnpm i && npx tsc --noEmit        # 类型检查（已通过，0 错误）
```

- 源码是 TypeScript，但**由 Node 原生 type stripping 直接运行**，不需要构建。
- 约束：不使用 enum / namespace / 构造函数参数属性（strip-only 不支持）。
- 测试用 `node:test`，夹具在 `tests/helpers/fixtures.ts`（可造最小合法 ASAR 与假宿主）。

进度与任务见 [PROJECT_STATUS.md](PROJECT_STATUS.md)、[TASKS.md](TASKS.md)；路线见 [docs/ROADMAP.md](docs/ROADMAP.md)。

---

## 许可

Purge+ 自身代码 MIT。`references/` 与 `docs/phase0/evidence/` 保存的是**对原项目的研究记录**，原项目为 MIT，另见 [docs/phase0/ORIGINAL_SECURITY_REVIEW.md](docs/phase0/ORIGINAL_SECURITY_REVIEW.md) §5。
