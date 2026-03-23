import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

function formatLogLine(level, args) {
  const timestamp = new Date().toISOString();
  const message = args.map((value) => {
    if (value instanceof Error) {
      return value.stack || value.message;
    }

    if (typeof value === "string") {
      return value;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ");

  return `[${timestamp}] [${level}] ${message}\n`;
}

export async function setupLogging() {
  const logFilePath = process.env.LOG_FILE_PATH?.trim();

  if (!logFilePath) {
    return;
  }

  await mkdir(path.dirname(logFilePath), { recursive: true });

  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  async function writeLine(level, args) {
    await appendFile(logFilePath, formatLogLine(level, args), "utf8");
  }

  console.log = (...args) => {
    originalLog(...args);
    writeLine("INFO", args).catch((error) => originalError("Failed to write log file:", error));
  };

  console.error = (...args) => {
    originalError(...args);
    writeLine("ERROR", args).catch((error) => originalError("Failed to write log file:", error));
  };

  console.warn = (...args) => {
    originalWarn(...args);
    writeLine("WARN", args).catch((error) => originalError("Failed to write log file:", error));
  };

  console.log(`File logging enabled at ${logFilePath}`);
}
