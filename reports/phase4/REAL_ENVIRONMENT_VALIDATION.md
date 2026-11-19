# 真实环境验证（REAL_ENVIRONMENT_VALIDATION）

执行时间：2026-11-19 · 平台：Windows 11 (NT 10.0.26200) · Node v24.1.0
原则：**只读**。未对真实宿主做任何写入、未安装/卸载、未结束任何进程、未改系统设置。

---

## 1. 环境识别（VERIFIED）

| 项 | 值 | 证据 |
| --- | --- | --- |
| 真实宿主安装 | `C:\Users\chenw\AppData\Local\Programs\DeepSeek Harness\resources` | `evidence/real-host-list.txt` |
| 宿主产品/版本 | `@deepseek-ai/dsh-desktop@0.2.2-rc.5` | ASAR 头 + 解包 package.json |
| 磁盘形态 | `both`（`app.asar` 209,083,008 B + 已解包 `app/`） | `host inspect` |
| 进程状态 | running（tasklist 命中） | `host inspect` |
| 已有第三方修改 | `dsh-purge@1.6.91`（`~/.dsh/dsh-purge/applied.json`） | 诊断输出 |
| Purge+ 数据目录 | `C:\Users\chenw\AppData\Local\purge-plus` | `doctor` |

## 2. 只读功能验证（全部 VERIFIED）

| # | 功能 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 宿主发现 | `purgeplus host list` | `dsh@24d1d554` + 真实路径 |
| 2 | 宿主取证 | `host inspect <id>` | `verified` 身份、`both/unpacked`、running、profile、修改痕迹 |
| 3 | 健康自检 | `purgeplus doctor` | `审计链 ✓ 完整`、`schema=v4`、审计 98 条 |
| 4 | 诊断 | `purgeplus diagnose` | `UNKNOWN`（2 警告 + 1 未知 + 0 失败），退出码 0 |
| 5 | 配置读取 | `/api/config` | 返回真实配置（port=7801 等） |
| 6 | ASAR 内省 | `readAsarIndex/readAsarJson` | 209 MB 归档 65 ms 读出版本 |
| 7 | 报告生成 | 诊断报告落库 | `finding`/`run` 表有记录，可 `recentReports` 读取 |
| 8 | 错误处理 | 对不存在 hostId 取证 | `not_found` + 已知 id 列表，退出码 1 |

### 诊断结果说明（真实环境的诚实解读）

```
@deepseek-ai/dsh-desktop@0.2.2-rc.5 · both/unpacked · UNKNOWN
  通过 6 · 警告 2 · 失败 0 · 未知 1
  [warn] 解包目录与归档同时存在 …
  [warn] 宿主修改有可追溯来源 …（来源 dsh-purge@1.6.91，抽样 400 文件命中 8 个）
  [unknown] 存在可回滚的宿主快照 —— 诊断层无法证明存在可用快照
```

- **修复前**同一台机器被判 `BROKEN`（因为 mtime 启发式 + 官方 bundle 依赖误报）。
- **修复后**降为 `UNKNOWN`：两个 warning 是事实（双形态、第三方修改痕迹），一个 unknown 是诚实（无法证明快照存在）。
- `unknown` 不等于"通过"。CLI 退出码 0 只表示"未发现确认故障"，自动化必须读 `level`。

## 3. 真实写入：BLOCKED（不伪造）

| 想验证的路径 | 状态 | 为什么不做 | 未来怎么验 |
| --- | --- | --- | --- |
| `pack apply` 写到真实宿主 | **BLOCKED** | 安全规则禁止；且该宿主已被 dsh-purge 修改，基线不可控，写入会污染用户环境 | 复制 `resources/` 到临时目录做 Level 4 验证（已通过假宿主验证机制，未验真实路径组合） |
| 快照真实宿主并恢复 | **BLOCKED** | 恢复属破坏性写 | 同上，在副本上验证 |
| 插件安装到真实数据目录 | **BLOCKED** | 会改变用户运行中的 Purge+ 状态（当前会话本身依赖该进程） | 使用 `--data-dir` 指向临时目录（已在验收脚本中做过） |
| 更新激活 | **BLOCKED** | 会改变 Purge+ 自身数据目录 | 已在隔离 data-dir 完成（见 FAULT_INJECTION C7） |
| 结束/重启宿主进程 | **BLOCKED** | 会中断用户正在使用的会话 | 由用户自行决定，不属于自动验收范围 |

## 4. 等级判定

| 维度 | 等级 | 说明 |
| --- | --- | --- |
| 宿主识别与版本判定 | **Level 5（真实环境）** | 真实安装、真实版本、真实 ASAR |
| 只读诊断 | **Level 5** | 真实宿主上跑出真实结论（含修正后的 UNKNOWN） |
| 宿主写入（pack/restore/update 到宿主） | **Level 4（模拟宿主）** | 机制已验证，真实路径组合未验 |
| UI 渲染 | **NOT_VERIFIED** | 未接入浏览器自动化 |
| 跨平台（macOS/Linux） | **NOT_VERIFIED** | 当前仅 Windows |

## 5. 结论

- 「识别 / 取证 / 诊断 / 报告 / 错误处理」在真实环境成立，且修复后的输出与事实一致。
- 「写入真实宿主」在当前约束下**没有**验证，任何"已在真实宿主验证写入"的说法都不成立。
- 真实环境暴露了一个模拟环境暴露不了的问题（mtime 误判），这证明真实环境验证不可替代。
