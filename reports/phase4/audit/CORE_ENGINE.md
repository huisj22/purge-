# B1 · Core Engine 审计

范围：`src/core/{kernel,events,logger,schema,config,atomic,errors}.ts`（7 文件）
方法：代码直读 + 探针 B/K

## 已确认事实

| 事实 | 结论 | 证据 |
| --- | --- | --- |
| 事件总线监听器异常被隔离 | 正确：单个 listener 抛错不影响其余，错误上报 | `tests/core-kernel.test.ts` |
| `once` 订阅只触发一次、退订幂等 | 正确 | 同上 |
| 日志脱敏在产生记录时完成 | 正确：`SECRET_KEY` 正则 + 内置串替换 | `tests/logs.test.ts` |
| 日志内存上限 | 有上限（默认 2000，超出 shift） | 代码 `logger.ts` |
| 原子写 | 临时文件 + fsync + rename，使用 `.pid.random.tmp` 名 | `tests/config.test.ts`（模式保留） |
| Schema 校验 | 缺失/类型错/枚举错/越界均报错并带字段路径；嵌套对象会递归填默认值 | `tests/config.test.ts` |

## 发现的问题

### P1-01 · `Kernel.start()` 失败后永久锁死 — VERIFIED

`src/core/kernel.ts:74-103`：`#startPromise` 一旦赋值就永远返回同一个 Promise。首次启动失败后，它保存的是一个已 reject 的 Promise；后续 `start()` 不会重建，也不会重试服务。
探针 B（`probes/b-kernel-start-latch.ts`）实测：

```
firstError  : service "flaky" failed to start: first start fails
secondError : service "flaky" failed to start: first start fails   ← 同一错误被重放
startAttempts: 1     ← 服务第二次根本没被调用
kernelStarted: false
PROBE_RESULT=START_LATCH_CONFIRMED
```

影响：任何「启动期暂时性失败」（端口占用、DB 锁、宿主暂不可读）会让整个进程在生命周期内不可恢复；`stop()` 后再 `start()` 也会拿到旧的 rejected Promise。

### P2-01 · 配置写入失败后内存态已改变 — VERIFIED

`src/core/config.ts:110-114`：`#apply()` 先更新 `#current`/`#raw`，随后才 `atomicWriteFile`。
探针 K（`probes/hk-plugin-config.ts`）把 `config.json` 换成目录使写盘必然失败：

```
errorCode: "unwritable"
inMemoryPortAfterFailure: 7999     ← 内存已改
diskReadable: false                ← 磁盘没写成功
historyEntries: 0
PROBE_RESULT=MEMORY_DIVERGED_CONFIRMED
```

影响：进程按「未落盘」的配置继续运行；下次重启回退到旧值，表现为"配置自己变回去了"。同时历史记录为 0，用户无从判断发生过什么。

### P3-03 · `removeTreeNoFollow` 静默吞掉删除失败 — CODE_CONFIRMED

`src/core/atomic.ts`：目录删除用 `await fsp.rmdir(target).catch(() => {})`。非空目录（并发创建/权限不足/文件被占用）会失败并被吞掉，随后调用方（事务回滚、技能替换）认为已删除。

## 结论

内核的事件隔离、脱敏、原子写、schema 校验是**真实实现**，不是空壳。但生命周期语义（`start` 重试）和配置提交语义（先写盘后生效）存在确定缺陷，属必须修复项（P1-01、P2-01）。
