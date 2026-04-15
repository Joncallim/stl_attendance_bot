import { applyStoredConfigOverrides, config } from "./config.js";
import { createAttendanceBot, BOT_VERSION } from "./bot.js";
import { setupLogging } from "./logger.js";
import { configureNetworkStack } from "./network.js";

async function main() {
  configureNetworkStack();
  await setupLogging();
  await applyStoredConfigOverrides();
  const bot = createAttendanceBot(config);

  await bot.launch();
  await bot.telegram.setMyCommands([
    { command: "start", description: "Open the main menu" },
    { command: "help", description: "Open the user manual" },
    { command: "attendance", description: "Submit today's attendance" },
    { command: "week", description: "Submit weekly attendance" },
    { command: "summary", description: "View attendance summary" },
    { command: "deregister", description: "Deregister this Telegram account" }
  ]);

  const maskedSpreadsheetId = config.spreadsheetId
    ? `${config.spreadsheetId.slice(0, 6)}…`
    : "(not set)";
  const maskedServiceAccount = config.googleServiceAccountEmail
    ? config.googleServiceAccountEmail.replace(/^(.{6}).*(@.*)$/, "$1…$2")
    : "(not set)";

  console.log(
    `Attendance bot started. ${BOT_VERSION} | ` +
    `spreadsheet=${maskedSpreadsheetId} | ` +
    `timezone=${config.timezone} | ` +
    `account=${maskedServiceAccount} | ` +
    `node=${process.version}`
  );

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((error) => {
  console.error("Failed to start attendance bot:", error);
  process.exitCode = 1;
});
