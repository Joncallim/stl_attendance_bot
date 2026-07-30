import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import {
  appendJsonLine,
  readJsonLines,
  writeJsonFile
} from "../src/fileStore.js";

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "attendance-files-"));

  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("sensitive JSON files are written with owner-only permissions", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "nested", "users.json");
    await writeJsonFile(filePath, [{ chatId: "1" }]);

    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
  });
});

test("JSONL recovery keeps complete records around a truncated append", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "queue.ndjson");
    await appendJsonLine(filePath, { id: 1, status: "pending" });
    await appendFile(filePath, "{\"id\":", "utf8");
    await appendJsonLine(filePath, { id: 2, status: "pending" });

    const records = await readJsonLines(filePath);
    assert.deepEqual(records.map((record) => record.id), [1, 2]);
    assert.match(await readFile(filePath, "utf8"), /"id":\n/);
  });
});

test("JSONL checksum rejects a modified complete record", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "queue.ndjson");
    await appendJsonLine(filePath, { id: 1, status: "pending" });
    const content = await readFile(filePath, "utf8");
    await appendFile(filePath, content.replace("pending", "flushed"), "utf8");

    await assert.rejects(
      readJsonLines(filePath),
      /checksum mismatch/
    );
  });
});
