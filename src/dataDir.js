import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DATA_DIR = path.resolve(__dirname, "../data");

export function getDataDir() {
  return process.env.ATTENDANCE_BOT_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
}

export function getDataFile(fileName) {
  return path.join(getDataDir(), fileName);
}
