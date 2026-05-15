import test from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_PRIVATE_KEY ??= "test-key";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.GOOGLE_SHEETS_SPREADSHEET_ID ??= "test-sheet";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ??= "bot@example.com";

const { __testing } = await import("../src/bot.js");
const { detectSnapshotDivergences, snapshotAppointmentHasData } = __testing;

// Helper: build a minimal snapshot with appointments and optional per-day data.
function makeSnapshot(appointments, dataByAppointment = {}) {
  const statusesByDay = new Map();

  for (let day = 1; day <= 31; day++) {
    const row = appointments.map((apt) => {
      const values = dataByAppointment[apt] ?? [];
      return String(values[day - 1] ?? "").trim();
    });
    statusesByDay.set(day, row);
  }

  return { appointments, statusesByDay };
}

// Helper: build a minimal snapshot bundle.
function makeBundle(snapshots) {
  return { snapshots: new Map(Object.entries(snapshots)) };
}

test("snapshotAppointmentHasData: returns false when appointment has no data", () => {
  const snapshot = makeSnapshot(["ALPHA", "BRAVO"]);
  assert.equal(snapshotAppointmentHasData(snapshot, "ALPHA"), false);
  assert.equal(snapshotAppointmentHasData(snapshot, "BRAVO"), false);
});

test("snapshotAppointmentHasData: returns false for unknown appointment", () => {
  const snapshot = makeSnapshot(["ALPHA"]);
  assert.equal(snapshotAppointmentHasData(snapshot, "CHARLIE"), false);
});

test("snapshotAppointmentHasData: returns true when at least one day has data", () => {
  const snapshot = makeSnapshot(["ALPHA", "BRAVO"], {
    ALPHA: Array(31).fill(""),     // ALPHA: all blank
    BRAVO: ["P", "", "", "MC"]    // BRAVO: has entries on day 1 and 4
  });
  assert.equal(snapshotAppointmentHasData(snapshot, "ALPHA"), false);
  assert.equal(snapshotAppointmentHasData(snapshot, "BRAVO"), true);
});

test("detectSnapshotDivergences: returns empty when snapshots match registry", () => {
  const bundle = makeBundle({
    "May 26": makeSnapshot(["ALPHA", "BRAVO"])
  });
  const result = detectSnapshotDivergences(bundle, ["ALPHA", "BRAVO"]);
  assert.deepEqual(result, []);
});

test("detectSnapshotDivergences: detects missing appointment", () => {
  const bundle = makeBundle({
    "May 26": makeSnapshot(["ALPHA"])  // BRAVO is missing
  });
  const result = detectSnapshotDivergences(bundle, ["ALPHA", "BRAVO"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].sheetTitle, "May 26");
  assert.deepEqual(result[0].missingFromSheet, ["BRAVO"]);
  assert.deepEqual(result[0].unexpectedInSheet, []);
  assert.deepEqual(result[0].unexpectedWithData, []);
});

test("detectSnapshotDivergences: detects unexpected appointment without data", () => {
  const bundle = makeBundle({
    "May 26": makeSnapshot(["ALPHA", "CHARLIE"])  // CHARLIE not in registry
  });
  const result = detectSnapshotDivergences(bundle, ["ALPHA", "BRAVO"]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].missingFromSheet, ["BRAVO"]);
  assert.deepEqual(result[0].unexpectedInSheet, ["CHARLIE"]);
  assert.deepEqual(result[0].unexpectedWithData, []);  // no data in CHARLIE
});

test("detectSnapshotDivergences: flags unexpected appointment with data", () => {
  const bundle = makeBundle({
    "May 26": makeSnapshot(["ALPHA", "CHARLIE"], {
      CHARLIE: ["P", "MC"]  // CHARLIE has attendance data
    })
  });
  const result = detectSnapshotDivergences(bundle, ["ALPHA", "BRAVO"]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].unexpectedWithData, ["CHARLIE"]);
});

test("detectSnapshotDivergences: handles multiple sheets independently", () => {
  const bundle = makeBundle({
    "Apr 26": makeSnapshot(["ALPHA", "CHARLIE"]),   // CHARLIE unexpected, BRAVO missing
    "May 26": makeSnapshot(["ALPHA", "BRAVO"])      // correct — no divergence
  });
  const result = detectSnapshotDivergences(bundle, ["ALPHA", "BRAVO"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].sheetTitle, "Apr 26");
});

test("detectSnapshotDivergences: comparison is case-insensitive", () => {
  const bundle = makeBundle({
    "May 26": makeSnapshot(["alpha", "bravo"])  // lowercase in sheet
  });
  const result = detectSnapshotDivergences(bundle, ["ALPHA", "BRAVO"]);
  assert.deepEqual(result, []);  // should match — normalised to uppercase
});

test("detectSnapshotDivergences: returns empty when bundle has no snapshots", () => {
  const result = detectSnapshotDivergences({ snapshots: new Map() }, ["ALPHA"]);
  assert.deepEqual(result, []);
});

test("detectSnapshotDivergences: returns empty when bundle is null", () => {
  const result = detectSnapshotDivergences(null, ["ALPHA"]);
  assert.deepEqual(result, []);
});

test("rename scenario: missing ALPHA, unexpected BRAVO with data", () => {
  // Simulates: someone renamed 'ALPHA' to 'BRAVO' in the sheet.
  const bundle = makeBundle({
    "Apr 26": makeSnapshot(["BRAVO"], {
      BRAVO: ["P", "P", "MC"]  // data exists under the renamed row
    })
  });
  const result = detectSnapshotDivergences(bundle, ["ALPHA"]);
  assert.equal(result.length, 1);
  const [div] = result;
  assert.deepEqual(div.missingFromSheet, ["ALPHA"]);
  assert.deepEqual(div.unexpectedInSheet, ["BRAVO"]);
  assert.deepEqual(div.unexpectedWithData, ["BRAVO"]);
});
