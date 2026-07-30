import { mkdir, appendFile, chmod, writeFile } from "node:fs/promises";
import path from "node:path";

// ── TTY detection ─────────────────────────────────────────────────────────────
// When running under pm2 (or any process manager) stdout is not a TTY.
// Emitting ANSI codes in that context either produces invisible output (if pm2
// strips them) or raw escape sequences in the log files (if it doesn't).
// FORCE_COLOR=1 overrides the detection for environments that support colour
// but don't expose a TTY (e.g. some Docker setups with explicit tty allocation).
const USE_ANSI = process.stdout.isTTY === true || process.env.FORCE_COLOR === "1";

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
  const ts = new Date().toISOString();

  if (!USE_ANSI) {
    // Plain text — identical to the file format so non-TTY output (pm2, pipes,
    // Docker without tty) is clean and grep-friendly. No trailing newline;
    // console.log adds it.
    const { fileLabel } = LEVELS[level] ?? LEVELS.INFO;
    return `[${ts}] [${fileLabel}] ${message}`;
  }

  const { termColour } = LEVELS[level] ?? LEVELS.INFO;
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

  await mkdir(path.dirname(logFilePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(logFilePath), 0o700);

  // Truncate the log file on every startup so each pm2 restart begins with a
  // clean slate. Old runs are not retained — if you need history, configure
  // pm2's own log rotation. The log file is excluded from git via .gitignore.
  await writeFile(logFilePath, "", { encoding: "utf8", mode: 0o600 });
  await chmod(logFilePath, 0o600);

  const originalLog   = console.log.bind(console);
  const originalError = console.error.bind(console);
  const originalWarn  = console.warn.bind(console);

  function writeFileLine(level, args) {
    const message = serialise(args);
    appendFile(logFilePath, formatFileLine(level, message), {
      encoding: "utf8",
      mode: 0o600
    })
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

  console.log(`[Bot] File logging active → ${logFilePath} (truncated on startup)`);
}
