import { config } from "./config.js";
import { createAttendanceBot } from "./bot.js";

async function main() {
  const bot = createAttendanceBot(config);

  await bot.launch();
  console.log("Attendance bot is running.");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((error) => {
  console.error("Failed to start attendance bot:", error);
  process.exitCode = 1;
});
