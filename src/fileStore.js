import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const serializedOperations = new Map();
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

async function ensureParentDir(filePath) {
  const directoryPath = path.dirname(filePath);
  await mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
}

async function syncDirectory(filePath) {
  const handle = await open(path.dirname(filePath), "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(filePath, content) {
  const temporaryFilePath =
    `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryFilePath, "wx", PRIVATE_FILE_MODE);

  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(temporaryFilePath, filePath);
  await chmod(filePath, PRIVATE_FILE_MODE);
  await syncDirectory(filePath);
}

async function appendPrivateFile(filePath, content) {
  const handle = await open(filePath, "a+", PRIVATE_FILE_MODE);

  try {
    const stats = await handle.stat();
    let prefix = "";

    if (stats.size > 0) {
      const trailingByte = Buffer.alloc(1);
      await handle.read(trailingByte, 0, 1, stats.size - 1);

      // Preserve an incomplete final record after a crash, but put subsequent
      // records on a fresh line so the valid queue remains recoverable.
      if (trailingByte[0] !== 0x0a) {
        prefix = "\n";
      }
    }

    await handle.writeFile(`${prefix}${content}`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await chmod(filePath, PRIVATE_FILE_MODE);
}

function addRecordChecksum(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const record = { ...value };
  delete record._recordChecksum;
  return {
    ...record,
    _recordChecksum: createHash("sha256")
      .update(JSON.stringify(record), "utf8")
      .digest("hex")
  };
}

function verifyRecordChecksum(record) {
  if (!record?._recordChecksum) {
    return record;
  }

  const expected = record._recordChecksum;
  const value = { ...record };
  delete value._recordChecksum;
  const actual = createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");

  if (actual !== expected) {
    throw new Error("JSONL record checksum mismatch; refusing unsafe recovery.");
  }

  return record;
}

export async function readJsonFile(filePath, fallbackValue) {
  await ensureParentDir(filePath);

  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }

    throw error;
  }
}

export async function writeJsonFile(filePath, value) {
  return runSerialized(`file:${filePath}`, async () => {
    await ensureParentDir(filePath);
    await writePrivateFile(filePath, JSON.stringify(value, null, 2));
  });
}

export async function writePrivateTextFile(filePath, content) {
  return runSerialized(`file:${filePath}`, async () => {
    await ensureParentDir(filePath);
    await writePrivateFile(filePath, String(content));
  });
}

export async function removePrivateFile(filePath) {
  return runSerialized(`file:${filePath}`, async () => {
    await ensureParentDir(filePath);

    try {
      await unlink(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return false;
      }

      throw error;
    }

    // unlink() can return before the directory entry is durable. Sync the
    // parent so a deleted transaction journal cannot reappear after a crash.
    await syncDirectory(filePath);
    return true;
  });
}

export async function appendJsonLine(filePath, value) {
  return runSerialized(`file:${filePath}`, async () => {
    await ensureParentDir(filePath);
    await appendPrivateFile(filePath, `${JSON.stringify(addRecordChecksum(value))}\n`);
  });
}

export async function appendJsonLines(filePath, values) {
  if (values.length === 0) return;
  return runSerialized(`file:${filePath}`, async () => {
    await ensureParentDir(filePath);
    await appendPrivateFile(
      filePath,
      values.map((value) => `${JSON.stringify(addRecordChecksum(value))}\n`).join("")
    );
  });
}

export async function writeJsonLines(filePath, values) {
  return runSerialized(`file:${filePath}`, async () => {
    await ensureParentDir(filePath);
    const content =
      values.map((value) => JSON.stringify(addRecordChecksum(value))).join("\n") +
      (values.length > 0 ? "\n" : "");
    await writePrivateFile(filePath, content);
  });
}

export async function readJsonLines(filePath, { rejectMalformed = false } = {}) {
  await ensureParentDir(filePath);

  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n");

    return lines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => line)
      .flatMap(({ line, index }) => {
        try {
          return [verifyRecordChecksum(JSON.parse(line))];
        } catch (error) {
          // A process or host crash can leave only the last append truncated.
          // Keep the damaged bytes on disk for recovery and load every complete
          // record around them. Destructive callers such as compaction must use
          // rejectMalformed so these retained bytes cannot be rewritten away.
          if (error instanceof SyntaxError) {
            if (rejectMalformed) {
              throw new Error(
                `Malformed JSONL record at line ${index + 1}; refusing destructive rewrite.`
              );
            }

            console.error(
              `[FileStore] Ignoring incomplete JSONL record at line ${index + 1}; bytes retained on disk.`
            );
            return [];
          }

          throw error;
        }
      });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export function runSerialized(key, operation) {
  const previous = serializedOperations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  const settled = next.catch(() => {}).finally(() => {
    if (serializedOperations.get(key) === settled) {
      serializedOperations.delete(key);
    }
  });

  serializedOperations.set(key, settled);
  return next;
}
