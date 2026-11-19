// 示例插件：只读使用被授予的 diagnostics 能力做统计，不写任何宿主文件。
// 能力白名单由宿主强制：未在 plugin.json 的 capabilities 里声明的服务，ctx.use() 会抛错。

let activated = false;
let ctx = null;
let calls = 0;

export function activate(context) {
  ctx = context;
  activated = true;
  ctx.log("info", "example plugin activated", { capabilities: ["diagnostics"] });
}

export function health() {
  return { ok: activated, detail: `activated=${activated} calls=${calls}` };
}

export function deactivate() {
  activated = false;
  ctx = null;
}

export async function invoke(method, args) {
  if (!activated || !ctx) return { ok: false, error: "plugin is not activated" };
  calls += 1;
  if (method !== "recent") return { ok: false, error: `unknown method: ${method}` };
  const diagnostics = ctx.use("diagnostics");
  const limit = Number(args?.limit ?? 5);
  return { ok: true, recent: diagnostics.recentReports(Number.isFinite(limit) ? limit : 5) };
}
