// Purge+ 前端：零构建、原生 DOM、同源 REST。
// 约定：任何写操作都会把真实错误显示给用户，不假装成功。

const state = { view: "overview", reports: [] };

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? {} : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}（响应不是 JSON）`);
  }
  if (!json.ok) {
    const err = new Error(json.error?.message ?? `HTTP ${res.status}`);
    err.code = json.error?.code;
    err.detail = json.error?.detail;
    throw err;
  }
  return json.data;
}

function toast(message, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 5200);
}

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

function pill(text, kind) {
  return h("span", { class: `pill ${kind}`, text });
}

function statusKind(status) {
  if (["ok", "pass", "succeeded", "applied", "verified", "enabled"].includes(status)) return "ok";
  if (["warn", "pending", "running", "paused", "partial"].includes(status)) return "warn";
  if (["fail", "broken", "failed", "timeout", "cancelled", "deny"].includes(status)) return "bad";
  if (["unknown", "inferred", "not_applicable", "na"].includes(status)) return "unknown";
  return "muted";
}

function fmtTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

// ---------- views ----------

async function viewOverview(root) {
  const data = await api("/api/overview");
  const hostCards = data.hosts.map((host) =>
    h("div", { class: "card" }, [
      h("h2", { text: host.id }),
      h("div", { class: "big", text: host.version ?? "?" }),
      h("div", { class: "hint", text: host.product ?? host.error ?? "" }),
      h("div", { class: "actions" }, [
        host.shape ? pill(`磁盘 ${host.shape}`, "muted") : null,
        host.running === null ? pill("进程 unknown", "unknown") : host.running ? pill("运行中", "ok") : pill("未运行", "muted"),
        host.modified === true ? pill("源码已修改", "warn") : null,
      ]),
      h("div", { class: "mono hint", text: host.root }),
    ]),
  );

  root.append(
    h("div", { class: "section" }, [
      h("div", { class: "grid" }, [
        h("div", { class: "card" }, [
          h("h2", { text: "版本" }),
          h("div", { class: "big", text: data.version }),
          h("div", { class: "hint", text: `${data.hosts.length} 个宿主 · ${data.jobs.length} 个调度任务` }),
        ]),
        h("div", { class: "card" }, [
          h("h2", { text: "审计链" }),
          h("div", { class: "big", text: data.audit.verify.ok ? "完整" : "断链" }),
          h("div", { class: "hint", text: `${data.audit.count} 条记录 · 校验 ${data.audit.verify.checked} 条` }),
        ]),
        h("div", { class: "card" }, [
          h("h2", { text: "最近运行" }),
          h("div", { class: "big", text: String(data.runs.length) }),
          h("div", { class: "hint", text: data.runs.map((r) => `${r.workflowId}:${r.state}`).join(" · ") || "暂无" }),
        ]),
        h("div", { class: "card" }, [
          h("h2", { text: "最近 trace" }),
          h("div", { class: "big", text: String(data.traces.length) }),
          h("div", { class: "hint", text: data.traces.map((t) => `${t.root}(${t.spans})`).join(" · ") || "暂无" }),
        ]),
      ]),
    ]),
    h("div", { class: "section" }, [
      h("h3", { text: "宿主" }),
      h("div", { class: "grid" }, hostCards.length ? hostCards : [h("div", { class: "empty", text: "未发现宿主。检查安装位置或用 host list 指定根目录。" })]),
    ]),
  );
}

async function viewHosts(root) {
  const hosts = await api("/api/hosts");
  const table = h("table", {}, [
    h("tr", {}, [h("th", { text: "宿主" }), h("th", { text: "适配器" }), h("th", { text: "根目录" }), h("th", { text: "" })]),
    ...hosts.map((host) =>
      h("tr", {}, [
        h("td", { class: "mono", text: host.id }),
        h("td", { text: host.adapter }),
        h("td", { class: "mono", text: host.root }),
        h("td", {}, [h("button", { class: "action", text: "取证", onclick: () => inspectHost(host.id) })]),
      ]),
    ),
  ]);
  root.append(
    h("div", { class: "actions" }, [
      h("button", {
        class: "action primary",
        text: "重新发现",
        onclick: async () => {
          const r = await api("/api/hosts/discover", { method: "POST", body: {} });
          toast(`发现 ${r.discovered} 个宿主`);
          render();
        },
      }),
    ]),
    h("div", { class: "section" }, [hosts.length ? table : h("div", { class: "empty", text: "未发现宿主" })]),
    h("div", { id: "host-detail" }),
  );
}

async function inspectHost(id) {
  const box = document.getElementById("host-detail");
  box.replaceChildren(h("div", { class: "loading", text: "取证中…" }));
  try {
    const f = await api(`/api/hosts/${encodeURIComponent(id)}/inspect`);
    box.replaceChildren(
      h("div", { class: "section" }, [
        h("h3", { text: `取证：${f.identity.product}@${f.identity.version}` }),
        h("div", { class: "grid" }, [
          card("身份置信度", f.identity.confidence, pill(f.identity.confidence, statusKind(f.identity.confidence))),
          card("磁盘形态", f.shape, h("div", { class: "hint", text: `归档 ${f.archive.exists ? f.archive.size : 0} 字节` })),
          card(
            "进程",
            f.process.running === null ? "unknown" : f.process.running ? `running (${f.process.pids.join(",")})` : "stopped",
            h("div", { class: "hint", text: `探测方式 ${f.process.probedBy}` }),
          ),
          card("加载形态", f.loadedShape, h("div", { class: "hint", text: "磁盘已写 ≠ 已加载" })),
        ]),
        h("h3", { text: "profile" }),
        h(
          "table",
          {},
          [
            h("tr", {}, [h("th", { text: "名称" }), h("th", { text: "依赖" }), h("th", { text: "启用 bundle" })]),
            ...(f.profiles.length
              ? f.profiles.map((p) =>
                  h("tr", {}, [
                    h("td", { text: p.name }),
                    h("td", { class: "mono", text: Object.keys(p.dependencies).join(", ") || "—" }),
                    h("td", { class: "mono", text: p.bundles.join(", ") || "—" }),
                  ]),
                )
              : [h("tr", {}, [h("td", { colspan: "3", class: "empty", text: "无 profile" })])]),
          ],
        ),
        h("h3", { text: "修改痕迹" }),
        h("div", { class: "pre" }, [
          `判定：${f.modification.looksModified === null ? "unknown" : f.modification.looksModified ? "已修改" : "未见修改"}`,
          `抽样：${f.modification.scannedFiles ?? 0} 个源码文件，命中 ${f.modification.markerHits.length} 个`,
          ...f.modification.packs.map((p) => `来源：${p.tool} ${p.version ?? ""} @ ${p.appliedAt ?? ""}（${p.evidence.source}）`),
          ...f.modification.markerHits.slice(0, 8).map((m) => `  ${m.file}`),
        ]),
      ]),
    );
  } catch (err) {
    box.replaceChildren(h("div", { class: "empty", text: `取证失败：${err.message}` }));
  }
}

function card(title, big, extra) {
  return h("div", { class: "card" }, [h("h2", { text: title }), h("div", { class: "big", text: String(big) }), extra ?? null]);
}

async function viewDiagnostics(root) {
  const data = await api("/api/diagnostics");
  const runButton = h("button", {
    class: "action primary",
    text: "运行全量诊断",
    onclick: async () => {
      runButton.disabled = true;
      try {
        const reports = await api("/api/diagnostics/run", { method: "POST", body: {} });
        state.reports = Array.isArray(reports) ? reports : [reports];
        toast(`诊断完成：${state.reports.map((r) => r.level).join(", ")}`);
        render();
      } catch (err) {
        toast(`诊断失败：${err.message}`, true);
      } finally {
        runButton.disabled = false;
      }
    },
  });
  const list = h("table", {}, [
    h("tr", {}, [h("th", { text: "报告" }), h("th", { text: "宿主" }), h("th", { text: "级别" }), h("th", { text: "发现" }), h("th", { text: "时间" })]),
    ...(data.recent.length
      ? data.recent.map((r) =>
          h("tr", {}, [
            h("td", { class: "mono", text: r.reportId }),
            h("td", { class: "mono", text: r.hostId || "—" }),
            h("td", {}, [pill(r.level, statusKind(r.level))]),
            h("td", { text: String(r.findings) }),
            h("td", { class: "mono", text: fmtTime(Date.parse(r.at)) }),
          ]),
        )
      : [h("tr", {}, [h("td", { colspan: "5", class: "empty", text: "还没有诊断记录" })])]),
  ]);

  root.append(h("div", { class: "actions" }, [runButton]), h("div", { class: "section" }, [list]));
  for (const report of state.reports) {
    root.append(renderReport(report));
  }
}

function renderReport(report) {
  return h("div", { class: "section" }, [
    h("h3", {}, [
      `${report.hostLabel} `,
      pill(report.level, statusKind(report.level)),
      h("span", { class: "hint", text: ` 通过 ${report.summary.pass} · 警告 ${report.summary.warn} · 失败 ${report.summary.fail} · 未知 ${report.summary.unknown}` }),
    ]),
    ...report.findings.map((f) =>
      h("div", { class: `finding ${f.status}` }, [
        h("div", { class: "title" }, [f.title, " ", pill(f.status, statusKind(f.status)), ` ${f.severity}`]),
        f.rootCause ? h("div", { class: "hint", text: `${f.rootCause.confidence === "verified" ? "已验证" : "推断"}：${f.rootCause.text}` }) : null,
        ...f.evidence.map((e) => h("div", { class: "evidence", text: `${e.kind} · ${e.source}${e.note ? ` · ${e.note}` : ""}` })),
        f.remediation ? h("div", { class: "hint", text: `修复建议（风险 ${f.remediation.risk ?? 0}）：${f.remediation.summary} → ${f.remediation.steps.join("；")}` }) : null,
      ]),
    ),
  ]);
}

async function viewSnapshots(root) {
  const snaps = await api("/api/snapshots");
  const pathInput = h("input", { placeholder: "要快照的绝对路径，逗号分隔", size: "60" });
  const labelInput = h("input", { placeholder: "标签", value: "manual" });
  root.append(
    h("div", { class: "actions" }, [
      labelInput,
      pathInput,
      h("button", {
        class: "action primary",
        text: "创建快照",
        onclick: async () => {
          const paths = pathInput.value.split(",").map((s) => s.trim()).filter(Boolean);
          if (!paths.length) return toast("请填写至少一个路径", true);
          try {
            const r = await api("/api/snapshots", { method: "POST", body: { label: labelInput.value || "manual", paths, confirm: true } });
            toast(`已创建 ${r.snapId}`);
            render();
          } catch (err) {
            toast(`创建失败：${err.message}`, true);
          }
        },
      }),
    ]),
    h("div", { class: "section" }, [
      h(
        "table",
        {},
        [
          h("tr", {}, [h("th", { text: "快照" }), h("th", { text: "标签" }), h("th", { text: "文件/字节" }), h("th", { text: "时间" }), h("th", { text: "操作" })]),
          ...(snaps.length
            ? snaps.map((s) =>
                h("tr", {}, [
                  h("td", { class: "mono", text: s.snapId }),
                  h("td", { text: s.label }),
                  h("td", { text: `${s.stats.files} / ${s.stats.bytes}` }),
                  h("td", { class: "mono", text: fmtTime(s.createdMs) }),
                  h("td", {}, [
                    h("button", {
                      class: "action",
                      text: "校验",
                      onclick: async () => {
                        const v = await api(`/api/snapshots/${s.snapId}/verify`);
                        v.ok ? toast("快照完整") : toast(`快照损坏：${v.issues.join("; ")}`, true);
                      },
                    }),
                    " ",
                    h("button", {
                      class: "action danger",
                      text: "恢复",
                      onclick: async () => {
                        if (!confirm(`确认把 ${s.stats.files} 个文件恢复到 ${s.snapId} 的状态？`)) return;
                        try {
                          const r = await api(`/api/snapshots/${s.snapId}/restore`, { method: "POST", body: { confirm: true } });
                          toast(`恢复 ${r.restored.length} 个，删除 ${r.removed.length} 个，失败 ${r.failed.length} 个`, r.failed.length > 0);
                          render();
                        } catch (err) {
                          toast(`恢复失败：${err.message}`, true);
                        }
                      },
                    }),
                  ]),
                ]),
              )
            : [h("tr", {}, [h("td", { colspan: "5", class: "empty", text: "还没有快照" })])]),
        ],
      ),
    ]),
  );
}

async function viewWorkflows(root) {
  const [defs, runs] = await Promise.all([api("/api/workflows"), api("/api/runs")]);
  root.append(
    h("div", { class: "section" }, [
      h("h3", { text: "工作流定义" }),
      h(
        "table",
        {},
        [
          h("tr", {}, [h("th", { text: "ID" }), h("th", { text: "名称" }), h("th", { text: "步骤" }), h("th", { text: "" })]),
          ...defs.map((w) =>
            h("tr", {}, [
              h("td", { class: "mono", text: w.id }),
              h("td", { text: w.name }),
              h("td", { text: w.steps.map((s) => `${s.id}(${s.uses})`).join(" → ") }),
              h("td", {}, [
                h("button", {
                  class: "action primary",
                  text: "运行",
                  onclick: async () => {
                    try {
                      const r = await api(`/api/workflows/${w.id}/run`, { method: "POST", body: {} });
                      toast(`${w.id} → ${r.state}`);
                      render();
                    } catch (err) {
                      toast(`运行失败：${err.message}`, true);
                    }
                  },
                }),
              ]),
            ]),
          ),
        ],
      ),
    ]),
    h("div", { class: "section" }, [
      h("h3", { text: "运行记录" }),
      h(
        "table",
        {},
        [
          h("tr", {}, [h("th", { text: "runId" }), h("th", { text: "工作流" }), h("th", { text: "状态" }), h("th", { text: "开始" }), h("th", { text: "步骤" })]),
          ...(runs.length
            ? runs.map((r) =>
                h("tr", {}, [
                  h("td", { class: "mono", text: r.runId }),
                  h("td", { text: r.workflowId }),
                  h("td", {}, [pill(r.state, statusKind(r.state))]),
                  h("td", { class: "mono", text: fmtTime(r.startedMs) }),
                  h("td", { class: "mono", text: r.steps.map((s) => `${s.stepId}:${s.state}`).join(" ") }),
                ]),
              )
            : [h("tr", {}, [h("td", { colspan: "5", class: "empty", text: "还没有运行记录" })])]),
        ],
      ),
    ]),
  );
}

async function viewJobs(root) {
  const jobs = await api("/api/jobs");
  const idInput = h("input", { placeholder: "任务 id", size: "14" });
  const wfInput = h("input", { placeholder: "workflowId", value: "healthcheck", size: "16" });
  const whenInput = h("input", { placeholder: "cron 或间隔秒数", value: "0 3 * * *", size: "16" });
  root.append(
    h("div", { class: "actions" }, [
      idInput,
      wfInput,
      whenInput,
      h("button", {
        class: "action primary",
        text: "添加任务",
        onclick: async () => {
          const when = whenInput.value.trim();
          const schedule = /^\d+$/.test(when) ? { type: "interval", seconds: Number(when) } : { type: "cron", expr: when };
          try {
            const r = await api("/api/jobs", {
              method: "POST",
              body: { id: idInput.value.trim(), kind: "workflow", payload: { workflowId: wfInput.value.trim() }, schedule, confirm: true },
            });
            toast(`已添加 ${r.id}，下次 ${fmtTime(r.nextRunMs)}`);
            render();
          } catch (err) {
            toast(`添加失败：${err.message}`, true);
          }
        },
      }),
    ]),
    h("div", { class: "section" }, [
      h(
        "table",
        {},
        [
          h("tr", {}, [
            h("th", { text: "id" }),
            h("th", { text: "状态" }),
            h("th", { text: "计划" }),
            h("th", { text: "下次" }),
            h("th", { text: "尝试" }),
            h("th", { text: "操作" }),
          ]),
          ...(jobs.length
            ? jobs.map((j) =>
                h("tr", {}, [
                  h("td", { class: "mono", text: j.id }),
                  h("td", {}, [pill(j.state, statusKind(j.state)), j.lastError ? h("div", { class: "hint", text: j.lastError }) : null]),
                  h("td", { class: "mono", text: j.schedule.type === "cron" ? j.schedule.expr : `${j.schedule.seconds}s` }),
                  h("td", { class: "mono", text: fmtTime(j.nextRunMs) }),
                  h("td", { text: String(j.attempts) }),
                  h("td", {}, [
                    h("button", { class: "action", text: "暂停", onclick: () => jobAction(j.id, "pause") }),
                    " ",
                    h("button", { class: "action", text: "恢复", onclick: () => jobAction(j.id, "resume") }),
                    " ",
                    h("button", { class: "action", text: "立即运行", onclick: () => jobAction(j.id, "run") }),
                  ]),
                ]),
              )
            : [h("tr", {}, [h("td", { colspan: "6", class: "empty", text: "还没有调度任务" })])]),
        ],
      ),
    ]),
  );
}

async function jobAction(id, action) {
  try {
    await api(`/api/jobs/${id}/${action}`, { method: "POST", body: {} });
    toast(`${id} ${action} ok`);
    render();
  } catch (err) {
    toast(`${action} 失败：${err.message}`, true);
  }
}

async function viewAudit(root) {
  const data = await api("/api/audit?limit=100");
  root.append(
    h("div", { class: "actions" }, [
      data.verify.ok ? pill(`链完整（${data.verify.checked} 条）`, "ok") : pill(`断链 @ ${data.verify.brokenAt}`, "bad"),
      h("span", { class: "hint", text: data.verify.reason ?? "" }),
    ]),
    h("div", { class: "section" }, [
      h(
        "table",
        {},
        [
          h("tr", {}, [h("th", { text: "#" }), h("th", { text: "时间" }), h("th", { text: "动作" }), h("th", { text: "目标" }), h("th", { text: "风险" }), h("th", { text: "hash" })]),
          ...(data.entries.length
            ? data.entries.map((e) =>
                h("tr", {}, [
                  h("td", { text: String(e.seq) }),
                  h("td", { class: "mono", text: e.ts }),
                  h("td", { text: e.action }),
                  h("td", { class: "mono", text: e.target ?? "—" }),
                  h("td", {}, [pill(String(e.risk), e.risk >= 70 ? "bad" : e.risk >= 30 ? "warn" : "muted")]),
                  h("td", { class: "mono", text: `${e.hash.slice(0, 12)}…` }),
                ]),
              )
            : [h("tr", {}, [h("td", { colspan: "6", class: "empty", text: "还没有审计记录" })])]),
        ],
      ),
    ]),
  );
}

async function viewPacks(root) {
  const [packs, hosts] = await Promise.all([api("/api/packs"), api("/api/hosts")]);
  const pathInput = h("input", { placeholder: "包文件绝对路径", size: "60" });
  const detail = h("div", { id: "pack-detail" });

  const hostSelect = h(
    "select",
    {},
    hosts.map((x) => h("option", { value: x.id, text: x.id })),
  );

  root.append(
    h("div", { class: "actions" }, [
      pathInput,
      h("button", {
        class: "action primary",
        text: "导入包",
        onclick: async () => {
          if (!pathInput.value.trim()) return toast("请填写包文件路径", true);
          try {
            const r = await api("/api/packs/import", { method: "POST", body: { path: pathInput.value.trim(), confirm: true } });
            toast(`已导入 ${r.id}@${r.version}`);
            render();
          } catch (err) {
            toast(`导入失败：${err.message}`, true);
          }
        },
      }),
      h("span", { class: "hint", text: "目标宿主：" }),
      hostSelect,
    ]),
    h("div", { class: "section" }, [
      h(
        "table",
        {},
        [
          h("tr", {}, [h("th", { text: "包" }), h("th", { text: "风险" }), h("th", { text: "规则" }), h("th", { text: "来源" }), h("th", { text: "操作" })]),
          ...(packs.length
            ? packs.map((p) =>
                h("tr", {}, [
                  h("td", {}, [h("div", { class: "mono", text: `${p.id}@${p.version}` }), h("div", { class: "hint", text: p.name })]),
                  h("td", {}, [pill(p.risk.level, p.risk.level === "high" || p.risk.level === "critical" ? "bad" : p.risk.level === "medium" ? "warn" : "muted")]),
                  h("td", { text: String(p.rules) }),
                  h("td", { class: "mono", text: p.source }),
                  h("td", {}, [
                    h("button", {
                      class: "action",
                      text: "预演",
                      onclick: () => planPack(p.id, hostSelect.value, detail),
                    }),
                    " ",
                    h("button", {
                      class: "action danger",
                      text: "应用",
                      onclick: () => applyPack(p.id, hostSelect.value, detail),
                    }),
                  ]),
                ]),
              )
            : [h("tr", {}, [h("td", { colspan: "5", class: "empty", text: "还没有导入任何修改包" })])]),
        ],
      ),
    ]),
    detail,
  );
}

async function planPack(id, hostId, box) {
  box.replaceChildren(h("div", { class: "loading", text: "预演中…" }));
  try {
    const plan = await api(`/api/packs/${encodeURIComponent(id)}/plan`, { method: "POST", body: { hostId } });
    box.replaceChildren(
      h("div", { class: "section" }, [
        h("h3", { text: `预演：${plan.packId}@${plan.packVersion}` }),
        h("div", { class: "pre", text: `待应用 ${plan.summary.pending} · 已应用 ${plan.summary.applied} · 漂移 ${plan.summary.drifted} · 缺失 ${plan.summary.missing} · 命中不符 ${plan.summary.hit_mismatch}` }),
        ...plan.entries.map((e) =>
          h("div", { class: `finding ${e.status === "pending" ? "warn" : e.status === "applied" ? "pass" : e.status === "drifted" || e.status === "hit_mismatch" ? "fail" : "unknown"}` }, [
            h("div", { class: "title", text: `${e.ruleId} · ${e.status}` }),
            h("div", { class: "evidence", text: e.detail }),
            e.preview ? h("div", { class: "pre", text: e.preview }) : null,
          ]),
        ),
      ]),
    );
  } catch (err) {
    box.replaceChildren(h("div", { class: "empty", text: `预演失败：${err.message}` }));
  }
}

async function applyPack(id, hostId, box) {
  if (!confirm(`确认真实写入宿主文件？预演结果建议先看一遍。\n包：${id}\n宿主：${hostId}`)) return;
  try {
    const r = await api(`/api/packs/${encodeURIComponent(id)}/apply`, { method: "POST", body: { hostId, confirm: true } });
    toast(`已写入 ${r.written.length} 个文件，快照 ${r.snapshotId}`);
    box.replaceChildren(
      h("div", { class: "section" }, [
        h("h3", { text: "应用完成" }),
        h("div", { class: "pre", text: `事务 ${r.txId}\n快照 ${r.snapshotId}\n写入：\n${r.written.join("\n")}` }),
        h("button", {
          class: "action danger",
          text: "用该快照回滚",
          onclick: async () => {
            if (!confirm("确认回滚到应用前状态？")) return;
            try {
              const rv = await api(`/api/packs/${encodeURIComponent(id)}/revert`, { method: "POST", body: { snapshotId: r.snapshotId, confirm: true } });
              toast(`已恢复 ${rv.restored.length} 个文件`);
            } catch (err) {
              toast(`回滚失败：${err.message}`, true);
            }
          },
        }),
      ]),
    );
  } catch (err) {
    toast(`应用失败：${err.message}`, true);
  }
}

const VIEWS = {
  overview: viewOverview,
  hosts: viewHosts,
  diagnostics: viewDiagnostics,
  snapshots: viewSnapshots,
  packs: viewPacks,
  workflows: viewWorkflows,
  jobs: viewJobs,
  audit: viewAudit,
};

async function render() {
  const root = document.getElementById("view");
  root.replaceChildren(h("div", { class: "loading", text: "加载中…" }));
  try {
    await VIEWS[state.view](root);
  } catch (err) {
    root.replaceChildren(
      h("div", { class: "card" }, [
        h("h2", { text: "加载失败" }),
        h("div", { class: "pre", text: `${err.code ?? ""} ${err.message}` }),
        h("div", { class: "hint", text: "检查服务是否运行：purgeplus serve" }),
      ]),
    );
  }
}

async function boot() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      state.view = tab.dataset.view;
      render();
    });
  }
  try {
    const health = await api("/api/health");
    document.getElementById("health").textContent = `v${health.version} · 数据目录 ${health.dataDir} · 审计 ${health.counts.audit} 条`;
  } catch {
    document.getElementById("health").textContent = "服务不可用";
  }
  render();
}

boot();
