# Purge+ tasks

状态：`todo` / `doing` / `done` / `blocked`。完成标准必须可验证（测试或真实命令输出）。

| ID | 名称 | 优先级 | 状态 | 依赖 | 完成标准 | 测试要求 |
| --- | --- | --- | --- | --- | --- | --- |
| T-001 | 原项目源码/结构测绘 | P0 | done | — | 10 份证据报告 + 补丁表枚举 | evidence/ 文件存在 |
| T-002 | Phase 0 三份交付文档 | P0 | done | T-001 | 分析/矩阵/安全评审齐备 | 矩阵 74 项有策略与状态 |
| T-003 | 核心内核（kernel/event/log/schema/config） | P0 | done | — | 生命周期与配置测试通过 | core-kernel/config tests |
| T-004 | 存储与审计哈希链 | P0 | done | T-003 | 篡改可检测、链可校验 | storage tests |
| T-005 | 快照 + 事务回滚 | P0 | done | T-004 | 回滚后字节一致 | recovery tests |
| T-006 | ASAR 只读解析 | P0 | done | T-003 | 能读真实 209MB 归档 | adapters tests |
| T-007 | DSH 宿主适配器 | P0 | done | T-006 | 本机真实宿主识别正确 | adapters tests + 实机探针 |
| T-008 | 宿主注册表 | P0 | done | T-007 | 缓存/失效/去重可用 | diagnostics tests |
| T-009 | 诊断规则与报告落库 | P0 | done | T-008 | broken/warn/unknown 三态准确 | diagnostics tests |
| T-010 | 工作流引擎 | P0 | done | T-004 | 并行/重试/超时/取消/恢复 | workflow tests |
| T-011 | 调度器与 cron-lite | P1 | done | T-004 | 不重叠/暂停恢复/持久化 | scheduler tests |
| T-012 | 安全策略引擎测试 | P0 | doing | T-003 | 阈值/AI 来源/allowlist 行为 | policy tests |
| T-013 | 组合根 src/app.ts | P0 | todo | T-003..T-012 | 一条命令装配全部服务 | 集成测试 |
| T-014 | REST API | P0 | todo | T-013 | 全端点返回真实数据 | api tests |
| T-015 | CLI 子命令 | P0 | todo | T-013 | doctor/host/diagnose/serve 实机跑通 | cli tests |
| T-016 | 静态 UI | P1 | todo | T-014 | 7 屏连真实 API | 手工验收 + 截图 |
| T-017 | 修改包引擎（schema/plan/apply/revert） | P0 | todo | T-005,T-012 | 假宿主 apply→verify→revert | packs tests |
| T-018 | 插件宿主与清单 | P2 | todo | T-013 | 安装/启用/越权拒绝 | plugins tests |
| T-019 | 更新中心（离线索引+分阶段） | P2 | todo | T-005 | 失败阶段明确、不虚报成功 | update tests |
| T-020 | 规则/技能中心 | P2 | todo | T-013 | CRUD + 导入安全校验 | ruleskills tests |
| T-021 | README 与安装说明 | P1 | todo | T-015 | 新机器按文档可跑 | 人工验证 |
| T-022 | 端到端验收脚本 | P1 | todo | T-015,T-016 | 一条命令跑完整链路 | e2e 脚本 |
