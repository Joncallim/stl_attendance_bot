import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const serializedOperations = new Map();

async function ensureParentDir(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
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
  await ensureParentDir(filePath);
  const temporaryFilePath = `${filePath}.tmp`;

  await writeFile(temporaryFilePath, JSON.stringify(value, null, 2));
  await rename(temporaryFilePath, filePath);
}

export async function appendJsonLine(filePath, value) {
  await ensureParentDir(filePath);
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function appendJsonLines(filePath, values) {
  if (values.length === 0) return;
  await ensureParentDir(filePath);
  await appendFile(filePath, values.map((v) => `${JSON.stringify(v)}\n`).join(""), "utf8");
}

export async function writeJsonLines(filePath, values) {
  await ensureParentDir(filePath);
  const temporaryFilePath = `${filePath}.tmp`;
  const content = values.map((value) => JSON.stringify(value)).join("\n") + (values.length > 0 ? "\n" : "");
  await writeFile(temporaryFilePath, content, "utf8");
  await rename(temporaryFilePath, filePath);
}

export async function readJsonLines(filePath) {
  await ensureParentDir(filePath);

  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
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
