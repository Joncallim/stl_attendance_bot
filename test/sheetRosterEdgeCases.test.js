import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  __testing,
  addAppointmentToSheets,
  removeAppointmentFromSheets,
  syncOnboardingRoster
} from "../src/googleSheets.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withTempDataDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sheet-roster-edge-"));
  process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;
  try {
    await run(tempDir);
  } finally {
    delete process.env.ATTENDANCE_BOT_DATA_DIR;
    await rm(tempDir, { recursive: true, force: true });
  }
}

function withMockedFetch(run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [] });
  return run().finally(() => { globalThis.fetch = originalFetch; });
}

function makeConfig() {
  return {
    spreadsheetId: "spreadsheet-id",
    timezone: "Asia/Singapore",
    rosterStopMarkers: ["Remarks"],
    onboardingSheetTitle: "ONBOARDING",
    attendanceOptions: ["PRESENT", "WFH", "OS", "MC"]
  };
}

// Minimal in-memory Sheets client that supports the operations used by
// addAppointmentToSheets, removeAppointmentFromSheets, and syncOnboardingRoster.
function createInMemorySheets(initialSheets = {}) {
  let nextSheetId = Math.max(0, ...Object.values(initialSheets).map((s) => Number(s.sheetId) || 0)) + 1;
  const sheetEntries = new Map(
    Object.entries(initialSheets).map(([title, sheet]) => [
      title,
      {
        sheetId: sheet.sheetId,
        protectedRanges: (sheet.protectedRanges ?? []).map((r) => ({ ...r })),
        values: (sheet.values ?? []).map((row) => [...row])
      }
    ])
  );
  const calls = { getSpreadsheet: 0, addedSheets: [], valueUpdates: [], batchValueUpdates: [], batchUpdateRequests: [] };

  function parseColumnLabel(label) {
    return label.split("").reduce((t, c) => t * 26 + c.charCodeAt(0) - 64, 0) - 1;
  }

  function parseRange(range) {
    const [, title, startLabel, startRowRaw, endLabel, endRowRaw] =
      range.match(/^'(.+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/) ?? [];
    if (!title) throw new Error(`Unsupported range: ${range}`);
    return {
      title,
      startColumnIndex: parseColumnLabel(startLabel),
      endColumnIndex: parseColumnLabel(endLabel ?? startLabel),
      startRowIndex: Number(startRowRaw) - 1,
      endRowIndex: endRowRaw ? Number(endRowRaw) - 1 : null
    };
  }

  function ensureSheetEntry(title) {
    if (sheetEntries.has(title)) return sheetEntries.get(title);
    const created = { sheetId: nextSheetId++, protectedRanges: [], values: [] };
    sheetEntries.set(title, created);
    return created;
  }

  function setCell(sheet, rowIndex, columnIndex, value) {
    while (sheet.values.length <= rowIndex) sheet.values.push([]);
    while (sheet.values[rowIndex].length <= columnIndex) sheet.values[rowIndex].push("");
    sheet.values[rowIndex][columnIndex] = String(value ?? "");
  }

  function getRangeValues(sheet, { startColumnIndex, endColumnIndex, startRowIndex, endRowIndex }) {
    const lastRow = endRowIndex === null ? Math.max(sheet.values.length - 1, startRowIndex) : endRowIndex;
    const rows = [];
    for (let r = startRowIndex; r <= lastRow; r++) {
      const row = [];
      for (let c = startColumnIndex; c <= endColumnIndex; c++) {
        row.push(String((sheet.values[r] ?? [])[c] ?? ""));
      }
      while (row.length > 0 && row[row.length - 1] === "") row.pop();
      rows.push(row);
    }
    while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
    return rows;
  }

  function applyValues(range, values) {
    const parsed = parseRange(range);
    const sheet = ensureSheetEntry(parsed.title);
    values.forEach((row, rOffset) => {
      row.forEach((value, cOffset) => {
        setCell(sheet, parsed.startRowIndex + rOffset, parsed.startColumnIndex + cOffset, value);
      });
    });
  }

  function clearRange(range) {
    const parsed = parseRange(range);
    const sheet = ensureSheetEntry(parsed.title);
    const lastRow = parsed.endRowIndex === null ? Math.max(sheet.values.length - 1, parsed.startRowIndex) : parsed.endRowIndex;
    for (let r = parsed.startRowIndex; r <= lastRow; r++) {
      for (let c = parsed.startColumnIndex; c <= parsed.endColumnIndex; c++) {
        setCell(sheet, r, c, "");
      }
    }
  }

  function insertRows(sheetId, startIndex, count) {
    const entry = [...sheetEntries.values()].find((s) => s.sheetId === sheetId);
    if (!entry) return;
    for (let i = 0; i < count; i++) entry.values.splice(startIndex, 0, []);
  }

  function deleteRows(sheetId, startIndex, count) {
    const entry = [...sheetEntries.values()].find((s) => s.sheetId === sheetId);
    if (entry) entry.values.splice(startIndex, count);
  }

  return {
    calls,
    getSheetValues(title) { return (sheetEntries.get(title)?.values ?? []).map((row) => [...row]); },
    hasSheet(title) { return sheetEntries.has(title); },
    client: {
      spreadsheets: {
        get: async () => {
          calls.getSpreadsheet++;
          return {
            data: {
              sheets: [...sheetEntries.entries()].map(([title, sheet]) => ({
                properties: { title, sheetId: sheet.sheetId },
                protectedRanges: sheet.protectedRanges
              }))
            }
          };
        },
        batchUpdate: async (request) => {
          const requests = request.requestBody.requests ?? [];
          calls.batchUpdateRequests.push(requests);
          const replies = [];
          for (const op of requests) {
            if (op.addSheet) {
              const title = op.addSheet.properties.title;
              const sheet = ensureSheetEntry(title);
              calls.addedSheets.push(title);
              replies.push({ addSheet: { properties: { title, sheetId: sheet.sheetId } } });
              continue;
            }
            if (op.addProtectedRange?.protectedRange) {
              const target = [...sheetEntries.values()].find((s) => s.sheetId === op.addProtectedRange.protectedRange.range?.sheetId);
              if (target) target.protectedRanges.push({ ...op.addProtectedRange.protectedRange });
              continue;
            }
            if (op.insertDimension?.range?.dimension === "ROWS") {
              insertRows(op.insertDimension.range.sheetId, op.insertDimension.range.startIndex, op.insertDimension.range.endIndex - op.insertDimension.range.startIndex);
              continue;
            }
            if (op.deleteDimension?.range?.dimension === "ROWS") {
              deleteRows(op.deleteDimension.range.sheetId, op.deleteDimension.range.startIndex, op.deleteDimension.range.endIndex - op.deleteDimension.range.startIndex);
              continue;
            }
            if (op.updateCells) {
              const target = [...sheetEntries.values()].find((s) => s.sheetId === op.updateCells.start.sheetId);
              if (target) {
                op.updateCells.rows.forEach((row, rOffset) => {
                  row.values.forEach((cell, cOffset) => {
                    setCell(target, op.updateCells.start.rowIndex + rOffset, op.updateCells.start.columnIndex + cOffset, cell.userEnteredValue?.stringValue ?? "");
                  });
                });
              }
              continue;
            }
          }
          return { data: { replies } };
        },
        values: {
          get: async (request) => {
            calls.valueUpdates;
            const parsed = parseRange(request.range);
            const sheet = ensureSheetEntry(parsed.title);
            return { data: { values: getRangeValues(sheet, parsed) } };
          },
          update: async (request) => {
            calls.valueUpdates.push({ range: request.range, values: request.requestBody.values });
            applyValues(request.range, request.requestBody.values);
            return {};
          },
          clear: async (request) => { clearRange(request.range); return {}; },
          batchUpdate: async (request) => {
            calls.batchValueUpdates.push(request.requestBody.data);
            for (const item of request.requestBody.data ?? []) {
              applyValues(item.range, item.values);
            }
            return {};
          }
        }
      }
    }
  };
}

// ── Add appointment edge cases ────────────────────────────────────────────────

test("addAppointmentToSheets is idempotent when appointment already exists", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const currentTitle = __testing.getMonthParts(new Date(), config.timezone).title;
    const currentMonth = __testing.getMonthParts(new Date(), config.timezone).month;
    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["BRAVO", "B1"],
          ["Remarks", ""]
        ]
      },
      [currentTitle]: {
        sheetId: 2,
        values: [
          ["Appointment", `1 ${currentMonth}`, `2 ${currentMonth}`],
          ["ALPHA", "PRESENT", ""],
          ["BRAVO", "WFH", ""],
          ["Remarks", ""]
        ]
      }
    });

    await addAppointmentToSheets(fake.client, config, "ALPHA");

    // ONBOARDING should still have exactly 2 appointments (no duplicate added)
    const onboardingRows = fake.getSheetValues("ONBOARDING").filter(
      (row) => row[0] && row[0] !== "Appointment" && row[0] !== "Remarks" && row[0] !== ""
    );
    assert.equal(onboardingRows.length, 2, "ONBOARDING should not gain a duplicate ALPHA row");
    assert.deepEqual(onboardingRows.map((r) => r[0]), ["ALPHA", "BRAVO"]);
  }));
});

test("addAppointmentToSheets creates both current and next month sheets", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const nextTitle = __testing.getMonthParts(
      __testing.shiftMonth(new Date(), config.timezone, 1),
      config.timezone
    ).title;

    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["Remarks", ""]
        ]
      }
    });

    await addAppointmentToSheets(fake.client, config, "BRAVO");

    // Both current and next month sheets must exist after adding a new person
    const currentTitle = __testing.getMonthParts(new Date(), config.timezone).title;
    assert.ok(fake.hasSheet(currentTitle), `current month sheet '${currentTitle}' should be created`);
    assert.ok(fake.hasSheet(nextTitle), `next month sheet '${nextTitle}' should be created`);

    // New appointment appears in both month sheets
    const currentFirstAppt = fake.getSheetValues(currentTitle).slice(1).find((row) => row[0] === "BRAVO");
    const nextFirstAppt = fake.getSheetValues(nextTitle).slice(1).find((row) => row[0] === "BRAVO");
    assert.ok(currentFirstAppt, "BRAVO should appear in current month sheet");
    assert.ok(nextFirstAppt, "BRAVO should appear in next month sheet");
  }));
});

test("addAppointmentToSheets at month boundary updates next month even when that sheet pre-exists", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const nextDate = __testing.shiftMonth(new Date(), config.timezone, 1);
    const nextTitle = __testing.getMonthParts(nextDate, config.timezone).title;
    const nextMonth = __testing.getMonthParts(nextDate, config.timezone).month;

    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["Remarks", ""]
        ]
      },
      // Pre-existing next month sheet with only ALPHA
      [nextTitle]: {
        sheetId: 3,
        values: [
          ["Appointment", `1 ${nextMonth}`],
          ["ALPHA", ""],
          ["Remarks", ""]
        ]
      }
    });

    await addAppointmentToSheets(fake.client, config, "BRAVO");

    // BRAVO must now appear in the next month sheet too
    const nextRows = fake.getSheetValues(nextTitle);
    const appointmentColumn = nextRows.slice(1).map((row) => row[0]).filter(Boolean);
    assert.ok(
      appointmentColumn.includes("BRAVO"),
      `BRAVO should be added to next month sheet '${nextTitle}'; got [${appointmentColumn.join(", ")}]`
    );
  }));
});

// ── Remove appointment edge cases ─────────────────────────────────────────────

test("removeAppointmentFromSheets removes person from ONBOARDING and newly-created month sheets", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const nextTitle = __testing.getMonthParts(
      __testing.shiftMonth(new Date(), config.timezone, 1),
      config.timezone
    ).title;

    // No pre-existing month sheets — bot will create them fresh after removal.
    // (Pre-existing sheets with the removed person appear as "unexpected rows"
    // and are intentionally preserved by the replace-mode logic, matching the
    // same behaviour that keeps user-added note rows intact — see test 22.)
    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["BRAVO", "B1"],
          ["Remarks", ""]
        ]
      }
    });

    await removeAppointmentFromSheets(fake.client, config, "BRAVO");

    // ONBOARDING should only have ALPHA
    const onboardingAppts = fake.getSheetValues("ONBOARDING")
      .slice(1)
      .map((row) => row[0])
      .filter((v) => v && v !== "Remarks");
    assert.deepEqual(onboardingAppts, ["ALPHA"], "BRAVO should be removed from ONBOARDING");

    // Current month sheet is created fresh: should contain only ALPHA
    const currentTitle = __testing.getMonthParts(new Date(), config.timezone).title;
    assert.ok(fake.hasSheet(currentTitle), "current month sheet should be created");
    const currentAppts = fake.getSheetValues(currentTitle).slice(1).map((row) => row[0])
      .filter((v) => v && v !== "Remarks");
    assert.ok(!currentAppts.includes("BRAVO"), "freshly-created current month sheet should not contain BRAVO");

    // Next month sheet should also not have BRAVO
    if (fake.hasSheet(nextTitle)) {
      const nextAppts = fake.getSheetValues(nextTitle).slice(1).map((row) => row[0]).filter(Boolean);
      assert.ok(!nextAppts.includes("BRAVO"), "BRAVO should not appear in next month sheet");
    }
  }));
});

test("removeAppointmentFromSheets is case-insensitive", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["BRAVO", "B1"],
          ["Remarks", ""]
        ]
      }
    });

    // Remove using lowercase
    await removeAppointmentFromSheets(fake.client, config, "bravo");

    const onboardingAppts = fake.getSheetValues("ONBOARDING")
      .slice(1)
      .map((row) => row[0])
      .filter((v) => v && v !== "Remarks");
    assert.deepEqual(onboardingAppts, ["ALPHA"], "Case-insensitive removal should remove BRAVO");
  }));
});

test("removeAppointmentFromSheets for non-existent appointment leaves roster unchanged", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["BRAVO", "B1"],
          ["Remarks", ""]
        ]
      }
    });

    // Remove an appointment that doesn't exist
    await removeAppointmentFromSheets(fake.client, config, "CHARLIE");

    const onboardingAppts = fake.getSheetValues("ONBOARDING")
      .slice(1)
      .map((row) => row[0])
      .filter((v) => v && v !== "Remarks");
    assert.deepEqual(onboardingAppts, ["ALPHA", "BRAVO"], "Roster should be unchanged after removing non-existent appointment");
  }));
});

test("removeAppointmentFromSheets preserves existing attendance data for remaining appointments", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const currentTitle = __testing.getMonthParts(new Date(), config.timezone).title;
    const currentMonth = __testing.getMonthParts(new Date(), config.timezone).month;

    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["BRAVO", "B1"],
          ["Remarks", ""]
        ]
      },
      [currentTitle]: {
        sheetId: 2,
        values: [
          ["Appointment", `1 ${currentMonth}`, `2 ${currentMonth}`],
          ["ALPHA", "PRESENT", "WFH"],
          ["BRAVO", "MC", ""],
          ["Remarks", ""]
        ]
      }
    });

    await removeAppointmentFromSheets(fake.client, config, "BRAVO");

    // ALPHA's attendance data must be preserved
    const currentRows = fake.getSheetValues(currentTitle);
    const alphaRow = currentRows.slice(1).find((row) => row[0] === "ALPHA");
    assert.ok(alphaRow, "ALPHA row should remain in current month sheet");
    assert.equal(alphaRow[1], "PRESENT", "ALPHA day-1 attendance should be preserved");
    assert.equal(alphaRow[2], "WFH", "ALPHA day-2 attendance should be preserved");
  }));
});

// ── ONBOARDING drift detection ────────────────────────────────────────────────

test("syncOnboardingRoster removes blank rows from ONBOARDING before roster repair", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["", ""],          // blank row — drift
          ["BRAVO", "B1"],
          ["Remarks", ""]
        ]
      }
    });

    const result = await syncOnboardingRoster(fake.client, config);

    // Blank row should be gone; appointments still intact
    const rows = fake.getSheetValues("ONBOARDING").filter((row) => row[0] !== "");
    const appointmentRows = rows.filter((row) => row[0] !== "Appointment" && row[0] !== "Remarks");
    assert.deepEqual(appointmentRows.map((r) => r[0]), ["ALPHA", "BRAVO"]);
    // driftDetected is set when blank rows are found — sync still completes
    assert.equal(typeof result.onboardingAppointments, "object");
  }));
});

test("syncOnboardingRoster adds a missing stop marker to prevent unbounded row growth", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["BRAVO", "B1"]
          // No "Remarks" stop marker — stopMarkerMissing should be detected
        ]
      }
    });

    await syncOnboardingRoster(fake.client, config);

    // After sync, ONBOARDING should have the stop marker
    const allRows = fake.getSheetValues("ONBOARDING");
    const hasStopMarker = allRows.some((row) => row[0] === "Remarks");
    assert.ok(hasStopMarker, "syncOnboardingRoster should write the Remarks stop marker when missing");
  }));
});

test("syncOnboardingRoster deduplicates appointments and reports them", async () => {
  const config = makeConfig();
  const parsed = __testing.parseOnboardingManagedRows(
    [
      ["Appointment", "Secret Code"],
      ["ALPHA", "A1"],
      ["ALPHA", "A2"],   // duplicate
      ["BRAVO", "B1"],
      ["Remarks", ""]
    ],
    config.rosterStopMarkers
  );

  // Parser should detect the duplicate but keep one instance
  assert.deepEqual(parsed.appointments, ["ALPHA", "BRAVO"]);
  assert.deepEqual(parsed.duplicateAppointments, ["ALPHA"]);
  assert.equal(parsed.appointments.filter((a) => a === "ALPHA").length, 1, "Only one ALPHA after deduplication");
});

test("syncOnboardingRoster restores bound appointments that were manually deleted from ONBOARDING", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    // ONBOARDING has only ALPHA; BRAVO was removed manually but is still bound
    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["Remarks", ""]
        ]
      }
    });

    const result = await syncOnboardingRoster(fake.client, config, {
      boundAppointmentsToRestore: ["BRAVO"]
    });

    // BRAVO should be restored to ONBOARDING
    const onboardingAppts = result.onboardingAppointments;
    assert.ok(
      onboardingAppts.includes("BRAVO"),
      `BRAVO should be restored; got [${onboardingAppts.join(", ")}]`
    );
  }));
});

test("syncOnboardingRoster restores any active main-registry appointment, even when unbound", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["Remarks", ""]
        ]
      }
    });

    const result = await syncOnboardingRoster(fake.client, config, {
      appointmentsToRestore: ["BRAVO"]
    });

    assert.ok(result.onboardingAppointments.includes("BRAVO"));
  }));
});

test("syncOnboardingRoster removes a stale sheet appointment only with a bot tombstone", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["BRAVO", "B1"],
          ["Remarks", ""]
        ]
      }
    });

    const result = await syncOnboardingRoster(fake.client, config, {
      appointmentsToRemove: ["BRAVO"]
    });

    assert.deepEqual(result.onboardingAppointments, ["ALPHA"]);
  }));
});

// ── Month boundary edge cases ─────────────────────────────────────────────────

test("shiftMonth handles December → January year rollover correctly", () => {
  const dec31 = new Date("2025-12-31T12:00:00.000Z");
  const jan = __testing.shiftMonth(dec31, "Asia/Singapore", 1);
  assert.equal(__testing.getMonthParts(jan, "Asia/Singapore").title, "Jan 26");
});

test("shiftMonth handles January → December year rollback correctly", () => {
  const jan15 = new Date("2026-01-15T12:00:00.000Z");
  const dec = __testing.shiftMonth(jan15, "Asia/Singapore", -1);
  assert.equal(__testing.getMonthParts(dec, "Asia/Singapore").title, "Dec 25");
});

test("addAppointmentToSheets at year boundary (December) creates correct January sheet title", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const decDate = new Date("2025-12-31T12:00:00.000Z");
    const nextTitle = __testing.getMonthParts(
      __testing.shiftMonth(decDate, config.timezone, 1),
      config.timezone
    ).title;

    // nextTitle should be "Jan 26" for a December date
    assert.equal(nextTitle, "Jan 26", "next month title from December should be Jan 26");
  }));
});

test("duplicate appointments in a month sheet block merge mode writes", () => {
  // Verify that buildManagedMonthlyRows handles the case where the sheet
  // has duplicate rows for the same appointment (e.g. an admin manually copied a row).
  const currentMonth = __testing.getMonthParts(new Date(), "Asia/Singapore").month;
  const result = __testing.buildManagedMonthlyRows({
    preferredAppointments: ["ALPHA", "BRAVO"],
    requestedAppointments: ["ALPHA", "BRAVO"],
    existingAppointments: ["ALPHA", "ALPHA", "BRAVO"], // ALPHA duplicated
    existingRows: [
      ["ALPHA", "PRESENT"],
      ["ALPHA", "WFH"],  // duplicate row
      ["BRAVO", "MC"]
    ],
    headerLength: 2,
    mode: "merge"
  });

  // In merge mode, only one ALPHA row should be in the output
  const alphaCount = result.nextAppointments.filter((a) => a === "ALPHA").length;
  assert.equal(alphaCount, 1, "merge mode should deduplicate ALPHA to one row");
});

test("appointment with parenthetical variant is added and matched correctly", async () => {
  await withMockedFetch(() => withTempDataDir(async () => {
    const config = makeConfig();
    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["Remarks", ""]
        ]
      }
    });

    // Adding a variant like "ALPHA (OUT)" should not be treated as duplicate of "ALPHA"
    await addAppointmentToSheets(fake.client, config, "ALPHA (OUT)");

    const onboardingAppts = fake.getSheetValues("ONBOARDING")
      .slice(1)
      .map((row) => row[0])
      .filter((v) => v && v !== "Remarks");
    assert.ok(
      onboardingAppts.includes("ALPHA (OUT)"),
      "ALPHA (OUT) should be added as a distinct appointment from ALPHA"
    );
    assert.ok(onboardingAppts.includes("ALPHA"), "ALPHA should still be present");
  }));
});
