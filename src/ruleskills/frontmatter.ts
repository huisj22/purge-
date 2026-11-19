/**
 * 极简 frontmatter 解析（YAML 子集）：只支持 SKILL.md 实际会用到的那几种写法。
 *
 * 支持：`key: value`、`key: "quoted"`、`key: [a, b]`、块列表（`- item`）、注释、多行描述（`|`）。
 * 不支持：锚点、嵌套映射（遇到即报错，不静默丢数据）。
 */

export interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
  /** 解析中发现的问题（例如不支持的嵌套结构）。 */
  problems: string[];
}

export function parseFrontmatter(text: string): Frontmatter {
  const problems: string[] = [];
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { data: {}, body: normalized, problems: ["no frontmatter block"] };
  }
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: normalized, problems: ["unterminated frontmatter"] };
  const head = normalized.slice(3, end).replace(/^\n/, "");
  const body = normalized.slice(end + 4).replace(/^\n/, "");
  const data: Record<string, string | string[]> = {};
  const lines = head.split("\n");
  let currentKey: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] as string;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent > 0 && currentKey && line.startsWith("- ")) {
      const value = unquote(line.slice(2).trim());
      const prev = data[currentKey];
      data[currentKey] = Array.isArray(prev) ? [...prev, value] : [value];
      continue;
    }
    if (indent > 0) {
      problems.push(`nested mapping is not supported (line ${i + 1}): ${line}`);
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) {
      problems.push(`malformed line ${i + 1}: ${line}`);
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    currentKey = key;
    if (value === "|" || value === ">") {
      // 多行块：收集后续缩进行
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j] as string;
        if (next.trim() === "") {
          collected.push("");
          continue;
        }
        if (next.length - next.trimStart().length === 0) break;
        collected.push(next.trimStart());
      }
      data[key] = collected.join(value === "|" ? "\n" : " ").trim();
      i = j - 1;
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => unquote(v.trim()))
        .filter((v) => v.length > 0);
      continue;
    }
    data[key] = unquote(value);
  }
  return { data, body, problems };
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

export function stringField(data: Record<string, string | string[]>, key: string): string | undefined {
  const v = data[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(", ");
  return undefined;
}

export function listField(data: Record<string, string | string[]>, key: string): string[] {
  const v = data[key];
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) return [v.trim()];
  return [];
}

export function boolField(data: Record<string, string | string[]>, key: string): boolean {
  const v = stringField(data, key);
  return v === "true" || v === "yes";
}
