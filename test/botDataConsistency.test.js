import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

process.env.GOOGLE_PRIVATE_KEY ??= "test-key";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.GOOGLE_SHEETS_SPREADSHEET_ID ??= "test-sheet";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ??= "bot@example.com";

const { __testing } = await import("../src/bot.js");
const {
  getAppointmentRegistry,
  getSettings,
  syncAppointmentRegistry
} = await import("../src/storage.js");

async function withTempDataDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bot-consistency-"));
  process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;
  try {
    await run();
  } finally {
    delete process.env.ATTENDANCE_BOT_DATA_DIR;
    await rm(tempDir, { recursive: true, force: true });
  }
}

function config() {
  return {
    spreadsheetId: "sheet-1",
    onboardingSheetTitle: "ONBOARDING",
    rosterStopMarkers: ["STOP"],
    timezone: "Asia/Singapore",
    attendanceOptions: ["PRESENT"],
    defaultAdminAppointments: []
  };
}

function cache() {
  return {
    sheetSnapshots: {},
    summaryMemoVersion: "stale"
  };
}

function unavailableSheets() {
  return {
    spreadsheets: {
      get: async () => {
        throw new Error("Sheets unavailable");
      }
    }
  };
}

test("appointment additions remain durable and report pending sync when Sheets fails", async () => {
  await withTempDataDir(async () => {
    const result = await __testing.addManagedAppointment(
      unavailableSheets(),
      config(),
      cache(),
      "ALPHA"
    );

    assert.equal(result.ok, true);
    assert.equal(result.syncPending, true);
    const registry = await getAppointmentRegistry();
    assert.equal(registry.appointments.find((entry) => entry.appointment === "ALPHA")?.active, true);
  });
});

test("appointment removals retain a durable tombstone when Sheets fails", async () => {
  await withTempDataDir(async () => {
    await syncAppointmentRegistry(["ALPHA"]);
    const result = await __testing.removeManagedAppointment(
      unavailableSheets(),
      config(),
      cache(),
      "ALPHA"
    );

    assert.equal(result.ok, true);
    assert.equal(result.syncPending, true);
    const registry = await getAppointmentRegistry();
    const alpha = registry.appointments.find((entry) => entry.appointment === "ALPHA");
    assert.equal(alpha.active, false);
    assert.ok(alpha.removedByBotAt);
  });
});

test("attendance option changes remain durable and report pending sync when Sheets fails", async () => {
  await withTempDataDir(async () => {
    const currentConfig = config();
    const result = await __testing.applyAttendanceOptionChange(
      unavailableSheets(),
      currentConfig,
      cache(),
      ["PRESENT", "WFH"]
    );

    assert.equal(result.ok, true);
    assert.equal(result.syncPending, true);
    assert.deepEqual(currentConfig.attendanceOptions, ["PRESENT", "WFH"]);
    assert.deepEqual((await getSettings()).attendanceOptions, ["PRESENT", "WFH"]);
  });
});
