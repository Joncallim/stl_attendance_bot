import path from "node:path";
import { fileURLToPath } from "node:url";
import { chmod, mkdir, readdir } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DATA_DIR = path.resolve(__dirname, "../data");

export function getDataDir() {
  return process.env.ATTENDANCE_BOT_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
}

export function getDataFile(fileName) {
  return path.join(getDataDir(), fileName);
}

export async function secureRuntimeFilePermissions() {
  const dataDir = getDataDir();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);

  const entries = await readdir(dataDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) =>
      entry.isFile() &&
      (entry.name.endsWith(".json") || entry.name.endsWith(".ndjson"))
    )
    .map((entry) => chmod(path.join(dataDir, entry.name), 0o600)));

  const envFilePath =
    process.env.ENV_FILE_PATH?.trim() || path.resolve(process.cwd(), ".env");
  await chmod(envFilePath, 0o600).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}
