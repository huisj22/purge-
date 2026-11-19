import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigCenter, diffText, formatDiff } from "../src/configcenter/managed.ts";
import { PurgeError } from "../src/core/errors.ts";
import { sha256 } from "../src/core/atomic.ts";

describe("config center", () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "purgeplus-cfg-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a file with its hash and reports absence honestly", async () => {
    const file = path.join(dir, "a.json");
    await writeFile(file, '{"a":1}\n', "utf8");
    const center = new ConfigCenter(path.join(dir, "data1"));
    const read = await center.read(file);
    assert.equal(read.exists, true);
    assert.equal(read.hash, sha256('{"a":1}\n'));
    const missing = await center.read(path.join(dir, "nope.json"));
    assert.equal(missing.exists, false);
    assert.equal(missing.content, "");
  });

  it("previews a diff without writing", async () => {
    const file = path.join(dir, "b.json");
    await writeFile(file, "line1\nline2\nline3\n", "utf8");
    const center = new ConfigCenter(path.join(dir, "data2"));
    const diff = await center.diff(file, "line1\nline2-changed\nline3\nline4\n");
    assert.equal(diff.addedLines, 2);
    assert.equal(diff.removedLines, 1);
    assert.equal(await readFile(file, "utf8"), "line1\nline2\nline3\n", "diff must not write");
    assert.match(formatDiff(diff), /\+ line2-changed/);
  });

  it("commits with hash guard and records history", async () => {
    const file = path.join(dir, "c.json");
    await writeFile(file, '{"v":1}\n', "utf8");
    const center = new ConfigCenter(path.join(dir, "data3"));
    const before = await center.read(file);
    const version = await center.commit(file, '{"v":2}\n', { expectHash: before.hash, actor: "test" });
    assert.equal(version.hash, sha256('{"v":2}\n'));
    assert.equal(await readFile(file, "utf8"), '{"v":2}\n');
    const history = await center.history(file);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.actor, "test");
    const versions = await center.versionsFor(file);
    assert.equal(versions[0]?.content, '{"v":2}\n');
  });

  it("refuses to overwrite when the file changed externally", async () => {
    const file = path.join(dir, "d.json");
    await writeFile(file, '{"v":1}\n', "utf8");
    const center = new ConfigCenter(path.join(dir, "data4"));
    const before = await center.read(file);
    await writeFile(file, '{"v":"external"}\n', "utf8");
    await assert.rejects(
      () => center.commit(file, '{"v":2}\n', { expectHash: before.hash }),
      (err: unknown) => {
        assert.ok(err instanceof PurgeError);
        assert.equal(err.code, "conflict");
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), '{"v":"external"}\n', "external content must survive");
  });

  it("diffs against a stored version", async () => {
    const file = path.join(dir, "e.txt");
    await writeFile(file, "one\n", "utf8");
    const center = new ConfigCenter(path.join(dir, "data5"));
    const read1 = await center.read(file);
    const v = await center.commit(file, "one\ntwo\n", { expectHash: read1.hash });
    // 版本快照 = 提交后的内容 → 与当前磁盘一致
    const same = await center.diffWithVersion(file, v.id);
    assert.equal(same.addedLines + same.removedLines, 0);
    // 外部再改一次后，与该版本的差异必须可见
    await writeFile(file, "one\ntwo\nthree\n", "utf8");
    const diff = await center.diffWithVersion(file, v.id);
    assert.equal(diff.addedLines, 1);
    assert.ok(diff.lines.some((l) => l.kind === "add" && l.line === "three"));
  });
});

describe("line diff", () => {
  it("handles pure additions, removals and identical text", () => {
    const add = diffText("x", "a\n", "a\nb\n", "h1", "h2");
    assert.deepEqual([add.addedLines, add.removedLines], [1, 0]);
    const remove = diffText("x", "a\nb\n", "a\n", "h1", "h2");
    assert.deepEqual([remove.addedLines, remove.removedLines], [0, 1]);
    const same = diffText("x", "a\nb", "a\nb", "h", "h");
    assert.deepEqual([same.addedLines, same.removedLines], [0, 0]);
  });
});
