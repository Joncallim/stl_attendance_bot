import { applyStoredConfigOverrides, config } from "./config.js";
import { createAttendanceBot, BOT_VERSION } from "./bot.js";
import { setupLogging } from "./logger.js";
import { configureNetworkStack } from "./network.js";
import { secureRuntimeFilePermissions } from "./dataDir.js";

// ── Startup helpers ───────────────────────────────────────────────────────────

function maskSpreadsheetId(id) {
  return id ? `${id.slice(0, 6)}…` : "(not set)";
}

function maskServiceAccount(email) {
  return email
    ? email.replace(/^(.{6}).*(@.*)$/, "$1…$2")
    : "(not set)";
}

function logStartup(message) {
  console.log(`[Bot] [Startup] ${message}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await secureRuntimeFilePermissions();

  // 1. Network stack (IPv4-first keep-alive agents) — must come first so all
  //    subsequent HTTP/HTTPS calls use the correct agents.
  configureNetworkStack();
  logStartup("Network stack configured (IPv4-first keep-alive agents).");

  // 2. Logging — truncates the log file and installs console overrides.
  await setupLogging();

  // 3. Config overrides stored on disk (admin-adjusted values).
  logStartup("Loading stored config overrides…");
  await applyStoredConfigOverrides();
  logStartup(`Config ready. timezone=${config.timezone} | onboarding=${config.onboardingSheetTitle}`);

  // 4. Bot instance and Telegram long-polling.
  if (process.env.GOOGLE_SHEETS_VERIFY_WRITES === "true") {
    logStartup(
      "GOOGLE_SHEETS_VERIFY_WRITES is enabled — attendance and onboarding writes are " +
      "verified from Google's write response (no extra API call)."
    );
  }

  if (!process.env.GITHUB_TOKEN) {
    logStartup(
      "GITHUB_TOKEN is not set — the 🐛 Report Issue button is hidden from the home menu. " +
      "Add it to .env and recreate the container (docker compose up -d) to enable reporting."
    );
  }

  logStartup(`Creating bot instance (${BOT_VERSION})…`);
  const bot = await createAttendanceBot(config);

  logStartup("Launching Telegram bot (connecting to Telegram API)…");
  await bot.launch();

  // 5. Register bot commands visible in the Telegram UI.
  logStartup("Registering Telegram command list…");
  await bot.telegram.setMyCommands([
    { command: "start",       description: "Open the main menu" },
    { command: "help",        description: "Open the user manual" },
    { command: "attendance",  description: "Submit today's attendance" },
    { command: "week",        description: "Submit weekly attendance" },
    { command: "summary",     description: "View attendance summary" },
    { command: "deregister",  description: "Deregister this Telegram account" }
  ]);

  // 6. Final ready banner.
  logStartup("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  logStartup(`Attendance bot READY  ${BOT_VERSION}`);
  logStartup(`  spreadsheet : ${maskSpreadsheetId(config.spreadsheetId)}`);
  logStartup(`  account     : ${maskServiceAccount(config.googleServiceAccountEmail)}`);
  logStartup(`  timezone    : ${config.timezone}`);
  logStartup(`  node        : ${process.version}`);
  logStartup("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // 7. Hourly memory line so growth shows up in `docker logs` long before it
  //    becomes a problem. unref() keeps it from holding the process open.
  const logMemory = () => {
    const { rss, heapUsed, heapTotal, external } = process.memoryUsage();
    const mb = (bytes) => Math.round(bytes / 1024 / 1024);
    console.log(
      `[Bot] [Memory] rss=${mb(rss)}MB heapUsed=${mb(heapUsed)}MB heapTotal=${mb(heapTotal)}MB external=${mb(external)}MB uptime=${Math.round(process.uptime() / 3600)}h`
    );
  };
  logMemory();
  setInterval(logMemory, 60 * 60 * 1000).unref();

  // 8. Graceful shutdown hooks.
  process.once("SIGINT",  () => {
    logStartup("SIGINT received — shutting down.");
    bot.stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    logStartup("SIGTERM received — shutting down.");
    bot.stop("SIGTERM");
  });
}

main().catch((error) => {
  console.error("[Bot] [Startup] FATAL: failed to start attendance bot:", error);
  process.exitCode = 1;
});
