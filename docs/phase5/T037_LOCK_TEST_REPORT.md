# T-037 跨进程锁测试报告

命令：`node --test tests/lock.test.ts`
环境：Windows 11 · Node v24.1.0
测试方式：**全部使用真实子进程**（`spawn(process.execPath, [holderScript, ...])`），不使用线程或同进程模拟。

## 1. 结果概览

```
✔ T-037 cross-process lock (13.9s)
  Case A–G + 元数据 + 层级
✔ T-037 lock coverage of real write paths (4.2s)
  配置提交 / 快照创建 / 插件安装 / 更新激活
tests 11 · pass 11 · fail 0
```

## 2. Case A–G 逐条

| Case | 注入 | 期望 | 实际 | 结果 |
| --- | --- | --- | --- | --- |
| A | 子进程持 `config` 3s，父进程申请 | `BUSY` 且 owner.pid = 子进程 | `BUSY`，pid 匹配 | ✅ |
| B | 子进程持 `global`+`snapshot`，父进程写配置 | 被阻止 | `conflict` | ✅ |
| C | 子进程持锁后 `process.exit(9)` | 不盲目删除；识别 STALE；可回收且留痕 | `inspect → STALE`；`acquire → ACQUIRED (reclaimed stale lock from pid N)`；`.stale-*` 目录含 `reclaimed.json`（`previousOwner.pid` 匹配） | ✅ |
| D | 子进程正常释放后父进程申请 | 成功 | `ACQUIRED`；释放后 `inspect → RELEASED` | ✅ |
| E | 两个子进程同时抢同一锁 | 恰好一个成功 | 1×ACQUIRED + 1×BUSY | ✅ |
| F | 一个进程持 `global+config`，另一个申请同组合 | 等待而非死锁 | 约 600ms 后成功，未到 5s 超时 | ✅ |
| G | `owner.json` 内容损坏 | 阻止写入，不自动夺取 | `RECOVERY_REQUIRED`；`withWriteGuard` 抛 `policy_denied`；损坏文件原样保留 | ✅ |

## 3. 覆盖真实写路径（子进程持 global）

| 操作 | 结果 |
| --- | --- |
| `ConfigCenter.commit` | `conflict` |
| `SnapshotStore.capture` | `conflict` |
| `PluginHost.install` | `conflict` |
| `UpdateService.activate` | `conflict` |
| 锁释放后同样的 `ConfigCenter.commit` | 成功并产生历史版本 |

## 4. 发现并修复的实现缺陷（测试驱动）

| # | 问题 | 现象 | 修复 |
| --- | --- | --- | --- |
| 1 | 先 `mkdir` 再写 `owner.json` 存在窗口 | Case E 中竞争方读到"目录存在但无元数据" → 误判 `RECOVERY_REQUIRED`，两个进程都拿不到锁 | 改为"临时目录先写元数据 → `rename` 原子占位" |
| 2 | 同进程并发 `withWriteGuard` 会互抢 | 并发快照/恢复测试抛 `BUSY`（本应排队） | 增加进程内按资源排队 |
| 3 | 重入判断在排队之后 | `restore → capture` 同资源自锁 → 测试挂起 300s+ | 把重入判断提前到排队之前 |
| 4 | `finally` 里 `throw` 掩盖原始错误 | lint `no-unsafe-finally` 报错；业务异常会被"释放失败"顶掉 | 先捕获业务结果，再释放，最后按优先级抛出 |

## 5. 未覆盖（诚实清单）

| 项 | 状态 |
| --- | --- |
| 网络文件系统（SMB/NFS）上的目录 rename 原子性 | NOT_VERIFIED |
| Linux/macOS 实机 | NOT_VERIFIED |
| 规则/技能/自身配置写入的加锁 | 未接入（见 REMAINING_RISK_REGISTER P2-13） |
| 锁心跳与长任务续期 | 未实现（仅记录 heartbeatAt 字段） |
| 跨机器锁 | 未支持（单机语义） |
