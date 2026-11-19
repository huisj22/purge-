import * as fsp from "node:fs/promises";
const f = "C:\\Users\\chenw\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const fh = await fsp.open(f, "r");
const b = Buffer.alloc(64); await fh.read(b, 0, 64, 0); await fh.close();
console.log([...b].slice(0,48).map((x,i)=>`${i}:${String.fromCharCode(x)}(${x})`).join(" "));
for (const off of [0,4,8,12]) console.log("u32@"+off, b.readUInt32LE(off));
