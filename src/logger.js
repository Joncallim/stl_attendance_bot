import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

// ── ANSI colour helpers (terminal only) ──────────────────────────────────────
const ANSI = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  green:  "\x1b[32m",
  cyan:   "\x1b[36m",
  grey:   "\x1b[90m"
};

function ansi(...codes) {
  return codes.join("");
}

// ── Level metadata ────────────────────────────────────────────────────────────
const LEVELS = {
  INFO:  { fileLabel: "INFO ", termColour: ansi(ANSI.green) },
  WARN:  { fileLabel: "WARN ", termColour: ansi(ANSI.yellow) },
  ERROR: { fileLabel: "ERROR", termColour: ansi(ANSI.red, ANSI.bold) }
};

// ── Serialise arbitrary log arguments to a single string ─────────────────────
function serialise(args) {
  return args.map((value) => {
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
}

// ── Category tag colouring for terminal ──────────────────────────────────────
// Matches bracketed tags like [Sheets], [Bot], [Queue], [Maint], etc.
const CATEGORY_TAG_RE = /(\[[A-Za-z][A-Za-z0-9 /_-]*\])/g;

function colouriseTerminalMessage(message) {
  return message.replace(CATEGORY_TAG_RE, `${ansi(ANSI.cyan)}$1${ANSI.reset}`);
}

// ── Format a line for the LOG FILE (no ANSI codes) ───────────────────────────
function formatFileLine(level, message) {
  const { fileLabel } = LEVELS[level] ?? LEVELS.INFO;
  const ts = new Date().toISOString();
  return `[${ts}] [${fileLabel}] ${message}\n`;
}

// ── Format a line for the TERMINAL ───────────────────────────────────────────
function formatTermLine(level, message) {
  const { termColour } = LEVELS[level] ?? LEVELS.INFO;
  const ts = new Date().toISOString();
  const dimTs   = `${ANSI.grey}[${ts}]${ANSI.reset}`;
  const label   = `${termColour}[${level.padEnd(5)}]${ANSI.reset}`;
  const coloured = colouriseTerminalMessage(message);
  return `${dimTs} ${label} ${coloured}`;
}

// ── Public setup ─────────────────────────────────────────────────────────────
export async function setupLogging() {
  const logFilePath = process.env.LOG_FILE_PATH?.trim();

  if (!logFilePath) {
    return;
  }

  await mkdir(path.dirname(logFilePath), { recursive: true });

  const originalLog   = console.log.bind(console);
  const originalError = console.error.bind(console);
  const originalWarn  = console.warn.bind(console);

  function writeFileLine(level, args) {
    const message = serialise(args);
    appendFile(logFilePath, formatFileLine(level, message), "utf8")
      .catch((error) => originalError("Failed to write log file:", error));
  }

  console.log = (...args) => {
    const message = serialise(args);
    originalLog(formatTermLine("INFO", message));
    writeFileLine("INFO", args);
  };

  console.warn = (...args) => {
    const message = serialise(args);
    originalWarn(formatTermLine("WARN", message));
    writeFileLine("WARN", args);
  };

  console.error = (...args) => {
    const message = serialise(args);
    originalError(formatTermLine("ERROR", message));
    writeFileLine("ERROR", args);
  };

  console.log(`[Bot] File logging enabled → ${logFilePath}`);
}
