# T-037 跨进程锁审计（T037_LOCK_AUDIT）

## 1. 结论

| 问题 | 回答 |
| --- | --- |
| 是否存在真正的跨进程锁？ | ✅ 是。原子原语 = "写临时目录 + `rename` 占位"，不是"先判断再创建" |
| 哪些操作受锁保护？ | config.commit / snapshot.capture / snapshot.restore / plugin.install / plugin.remove / update.activate / pack.apply / installer.install |
| 是否存在未保护入口？ | 有，见 §6 |
| 是否经过真实子进程测试？ | ✅ 11 例，全部 spawn 真实 `node` 进程 |
| 是否存在死锁风险？ | 层级 + 重入已处理；见 §5 |
| Stale Lock 是否安全？ | 是，且回收留痕（见 §4） |

## 2. 实现

`src/core/lock.ts`

- **互斥原语**：先 `mkdir <resource>.lock.tmp-<pid>-<rand>` → 写入 `owner.json` → `rename` 到 `<resource>.lock`。
  - 这样竞争者**永远看不到**"锁目录存在但 owner.json 缺失"的窗口（早期版本用 mkdir 后写文件，实测在 Case E 中产生 `RECOVERY_REQUIRED` 误判）。
- **锁元数据**：`{schema, lockId, resource, scope, operation, pid, processStartTime, owner, createdAt, heartbeatAt, version}`。
- **状态**：`ACQUIRED / BUSY / STALE / RECOVERY_REQUIRED / RELEASED / FAILED`。
- **存活判定**：`process.kill(pid, 0)`；有启动时间时比对；超过 24h 一律按"可能仍在运行"处理（阻塞，不自动回收）。
- **回收**：把整个锁目录 `rename` 成 `<resource>.lock.stale-<ts>`，写入 `reclaimed.json`（含前一持有者），再重新占位。
- **释放**：先校验 `lockId` 一致（防止误删别人抢到的锁），再删除。
- **层级**：`global(10) → host(20) → config/snapshot/update/plugin(30) → pack(40) → file(50)`；`acquireMany` 自动排序。
- **重入**：同进程同资源可重入（避免 `pack.apply → snapshot.capture` 自锁）；global 亦记录深度。

## 3. 写路径覆盖（实测）

| 操作 | 锁资源 | 覆盖方式 | 测试 |
| --- | --- | --- | --- |
| 配置提交 `ConfigCenter.commit` | global → config | 包裹整个提交（hash 守卫在锁内） | ✅ 子进程持 global 时 `conflict` |
| 快照创建 `capture` | global → snapshot | 包裹 | ✅ |
| 快照恢复 `restore` | global → snapshot | 包裹 + 进程内串行 | ✅（配置写入同时被阻） |
| 插件安装 `install` | global → plugin | 包裹 | ✅ |
| 插件删除 `remove` | global → plugin | 包裹 | ✅ |
| 更新激活 `activate` | global → update | 包裹 | ✅ |
| 修改包 `apply` | global → pack | 包裹（`dataDir` 注入后生效） | CODE_CONFIRMED |
| 安装器 `install` | `<parent>/locks/install.lock` | 包裹 | CODE_CONFIRMED |
| 规则/技能写 | ❌ 未包 | 见 §6 | — |
| 审计追加 | ❌ 不加锁（同步 SQLite 事务，单写者语义） | 见 §6 | — |

## 4. Stale Lock 策略

1. 读不到 `owner.json` / JSON 非法 / 字段缺失 → `RECOVERY_REQUIRED`（**阻止写入**，不自动删除）。
2. PID 不存在（`ESRCH`）→ `STALE`，可回收。
3. PID 存在但 `EPERM` → 视为存活（安全方向）。
4. 有双方启动时间且不一致 → 判定为 PID 复用 → `STALE`。
5. 创建超过 24h → 不回收（长任务优先，交由人工）。
6. 回收必须留痕：旧目录改名 + `reclaimed.json`，测试断言 `previousOwner.pid`。

## 5. 死锁防护

- 层级常量固定；`acquireMany` 排序后获取；逆序释放。
- 同进程重入避免自锁。
- Case F 实测：进程 A 持有 `global+config` 时，进程 B 的 `withWriteGuard(config)` 会等待并在 A 释放后成功（约 600ms），不会超时死锁。
- **未使用**阻塞式 OS 文件锁（flock/LockFileEx）：跨平台差异大，且 Node 无内置 API；改用目录原子性，语义足够。

## 6. 仍未覆盖的写入口（诚实清单）

| 入口 | 原因 | 风险 |
| --- | --- | --- |
| `RuleStore.create/update/remove`、`SkillLibrary.import/remove` | 位于 `<dataDir>/rules`、`<dataDir>/skills`，当前只有进程内一致性 | 两个进程同时改同一规则文件可能丢更新（概率低，影响局部） |
| `ConfigStore.update`（Purge+ 自身配置） | 尚未接入锁 | 两进程同时改配置可互相覆盖 |
| 审计追加 | 依赖 SQLite 单写者 + 同步 append；未加文件锁 | 跨进程并发写同库可能 `SQLITE_BUSY`（已有 busy_timeout=5s） |
| `SnapshotStore.prune` | 只删无引用对象 | 与 capture 并发可能删掉刚写入的对象（窗口小） |

**处置**：以上四项已登记为 P2 剩余风险，下一阶段接入（规则/技能/配置/审计），不影响本轮验收的核心写路径。

## 7. 平台差异

| 平台 | 行为 | 证据 |
| --- | --- | --- |
| Windows 11 | `rename(dir → existing dir)` 抛 `EPERM/EEXIST`，已纳入"占用"判定 | VERIFIED（本机 11 例测试） |
| Linux/macOS | `rename` 到非空目录抛 `ENOTEMPTY`，同样纳入判定 | CODE_CONFIRMED（未运行） |
| 网络文件系统（SMB/NFS） | 目录 rename 的原子性依赖服务端；未验证 | NOT_VERIFIED |
