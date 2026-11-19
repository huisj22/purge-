import { readAsarIndex, readAsarJson, listAsarTop } from "file:///D:/Purge+/src/adapters/asar.ts";
const file = "C:\\Users\\chenw\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const t0 = Date.now();
const idx = await readAsarIndex(file);
const top = listAsarTop(idx);
const pkg = await readAsarJson(file, "package.json");
console.log(JSON.stringify({ ms: Date.now() - t0, top: top.slice(0, 12), name: pkg.name, version: pkg.version, main: pkg.main }, null, 2));
