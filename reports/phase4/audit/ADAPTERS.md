# B3 · Adapter 审计

范围：`src/adapters/{types,asar,dsh}.ts`
方法：代码直读 + 对真实 209 MB 归档实测 + 探针 A

## 已确认事实

| 事实 | 结论 | 证据 |
| --- | --- | --- |
| ASAR 头解析正确 | 正确：`uint32=4 / headerSize / headerPayload / jsonLength / json@16`，实测读真实归档 65 ms 得到 `@deepseek-ai/dsh-desktop@0.2.2-rc.5` | 会话实测 + `tests/adapters.test.ts` |
| 非 ASAR 文件被明确拒绝 | 正确：`schema_invalid`，不返回垃圾数据 | `tests/adapters.test.ts` |
| 归档内路径查找 | 正确：逐段下钻，未命中返回 `undefined`，读取时 `not_found` | 同上 |
| 未解包宿主也能识别版本 | 正确（sealed 场景有测试） | `tests/adapters.test.ts` |
| 只读：不写宿主 | 正确（代码无写路径） | CODE_CONFIRMED |
| 多路径候选 + 去重 | 正确；`includeDefaults:false` 可关（测试用） | CODE_CONFIRMED |
| 进程探测失败返回 `null` 而非 `false` | 正确（区分 unknown 与 stopped） | `tests/adapters.test.ts` |

## 发现的问题

### P1-02 · 「宿主是否被修改」用 mtime 启发式，系统性误报 — VERIFIED

`src/adapters/dsh.ts:347-356`：

```ts
const newer = archive.mtimeMs !== undefined ? st.mtimeMs > archive.mtimeMs : null;
looksModified = markerHits.length > 0 ? true : newer;
```

只要 `resources/app/package.json` 比 `app.asar` 新，就判定「源码被修改」。而**真实解包必然导致这个结果**：解包就是从 asar 里写出一批新文件，mtime 一定晚于归档。

探针 A（`probes/a-inspector-clean-host.ts`）构造一个**完全没有补丁痕迹**的解包宿主：

```
shape: "both"   markerHits: 0   packs: 0
looksModified: true
verdict: "fail"   severity: "high"
verdictText: "宿主源码被修改，但没有找到任何修改包/快照记录"
PROBE_RESULT=FALSE_POSITIVE_CONFIRMED
```

影响：最高频的合法状态（已解包）被报成高危故障，直接摧毁诊断可信度，属于典型的「狼来了」。同时反方向也漏报：如果攻击者改了文件又把 mtime 改回去，该启发式判不出来。

### P3-11 · 标记扫描有文件数上限（400）却报告为确定结论 — CODE_CONFIRMED

`#scanMarkers` 最多扫描 400 个源文件。当宿主更大时，`markerHits.length === 0` 不能推出「未修改」。当前 `looksModified` 的取值没有区分「扫完没命中」与「没扫完」。

### 硬编码路径

`targetFiles`-style 的宿主内部布局来自 `dsh.ts` 的固定候选清单（`app.asar` / `app/` / `runtime/` / `profiles/`）。这是**合理的领域知识**，但应被视为可配置项；当前已支持 `PURGE_HOST_ROOT` 与 `hosts.roots` 覆盖，可接受。

## 结论

ASAR 与身份识别是这个项目最扎实的部分（有真实大文件验证）。但 `looksModified` 的判定逻辑错误，必须重写为「以标记与已知修改记录为准，mtime 只作提示」。
