/*
 * Durable local-file primitives used by the queue, registry, caches and recovery
 * journals.
 *
 * These helpers are deliberately stricter than ordinary JSON file utilities:
 *
 * - replacement writes go to a fresh temporary file, fsync the file, rename it,
 *   then fsync the parent directory;
 * - append-only JSONL records are fsynced before the caller continues;
 * - JSONL records carry checksums so silent corruption is not replayed as valid
 *   state;
 * - writes to the same logical key are serialized in-process;
 * - runtime directories/files are forced to private permissions.
 *
 * Do not replace these helpers with bare `writeFile()` calls in code that forms
 * part of an acknowledgement or recovery boundary. A successful return from a
 * durable write is what allows higher layers to safely tell the user an action
 * has been accepted.
 */

import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const serializedOperations = new Map();
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Ensure the parent exists and remains private even if it pre-dated the bot. */
async function ensureParentDir(filePath) {
  const directoryPath = path.dirname(filePath);
  await mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
}

// fsyncing the file is not enough to guarantee a rename/unlink survives a host
// crash. Sync the containing directory after changing its directory entry.
async function syncDirectory(filePath) {
  const handle = await open(path.dirname(filePath), "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Atomically replace a private text file.
 *
 * The temporary file is created with `wx` so an unexpected name collision is a
 * hard failure. The old path remains untouched until the new bytes are fully
 * written and synced.
 */
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

/** Append durable text without rewriting earlier queue/journal history. */
async function appendPrivateFile(filePath, content) {
  const handle = await open(filePath, "a+", PRIVATE_FILE_MODE);

  try {
    const stats = await handle.stat();
    let prefix = "";

    if (stats.size > 0) {
      const trailingByte = Buffer.alloc(1);
      await handle.read(trailingByte, 0, 1, stats.size - 1);

      // A crash may leave the final JSONL record incomplete. Do not overwrite or
      // join onto those bytes; put the next valid append on a fresh line so the
      // rest of the file remains recoverable.
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

// Checksums catch complete-looking JSON that was corrupted on disk. They are
// record-level rather than file-level so valid history can still be recovered
// around a truncated final append.
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

/** Read JSON, returning the supplied fallback only when the file is absent. */
export async function readJsonFile(filePath, fallbackValue) {
  await ensureParentDir(filePath);

  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }

    // Malformed existing JSON is not equivalent to an absent file; callers need
    // to see the error rather than silently resetting durable state.
    throw error;
  }
}

/** Atomically replace a JSON state file. */
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

/** Remove a private state file and make the deletion crash-durable. */
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

    await syncDirectory(filePath);
    return true;
  });
}

/** Append one checksummed JSONL event. */
export async function appendJsonLine(filePath, value) {
  return runSerialized(`file:${filePath}`, async () => {
    await ensureParentDir(filePath);
    await appendPrivateFile(filePath, `${JSON.stringify(addRecordChecksum(value))}\n`);
  });
}

/** Append several checksummed JSONL events under one serialized file operation. */
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

/**
 * Rewrite a JSONL file, normally for compaction. Callers should only compact
 * state they have read with `rejectMalformed: true`; otherwise a damaged tail
 * could be silently discarded and converted into apparent success.
 */
export async function writeJsonLines(filePath, values) {
  return runSerialized(`file:${filePath}`, async () => {
    await ensureParentDir(filePath);
    const content =
      values.map((value) => JSON.stringify(addRecordChecksum(value))).join("\n") +
      (values.length > 0 ? "\n" : "");
    await writePrivateFile(filePath, content);
  });
}

/**
 * Replay a JSONL log. A truncated JSON record can be ignored for non-destructive
 * recovery because surrounding complete records remain usable; destructive
 * callers request `rejectMalformed` so the damaged bytes cannot be erased.
 */
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

/**
 * Serialize operations sharing a logical key. A failed operation does not poison
 * the chain: the following operation still gets a turn, while the original
 * caller receives the original rejection.
 */
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
