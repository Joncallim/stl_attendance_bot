import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const REQUIRED_ENV = {
  GOOGLE_PRIVATE_KEY: "test-key",
  TELEGRAM_BOT_TOKEN: "test-token",
  GOOGLE_SHEETS_SPREADSHEET_ID: "test-sheet",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "bot@example.com"
};

for (const [name, value] of Object.entries(REQUIRED_ENV)) {
  process.env[name] ??= value;
}

test("attendance options fall back to ATTENDANCE_OPTIONS when no stored override exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "attendance-config-"));
  process.env.ATTENDANCE_OPTIONS = "PRESENT,WFH,OS";
  process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;

  try {
    const module = await import(`../src/config.js?case=${Date.now()}`);
    const appliedConfig = await module.applyStoredConfigOverrides();

    assert.deepEqual(appliedConfig.onboardingAttendanceOptions, ["PRESENT", "WFH", "OS"]);
    assert.deepEqual(appliedConfig.attendanceOptions, ["PRESENT", "WFH", "OS"]);
  } finally {
    delete process.env.ATTENDANCE_BOT_DATA_DIR;
    delete process.env.ATTENDANCE_OPTIONS;
    await rm(tempDir, { recursive: true, force: true });
  }
});
