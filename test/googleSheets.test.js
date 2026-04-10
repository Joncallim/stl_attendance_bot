import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  __testing,
  preloadAttendanceSnapshots,
  reconcilePendingAttendanceWithSheets,
  summarizeAttendanceOptionUsage,
  syncOnboardingRoster
} from "../src/googleSheets.js";

function createFakeSheets(columnValues) {
  const calls = {
    get: [],
    clear: [],
    update: [],
    batchUpdate: [],
    batchValueUpdate: []
  };

  return {
    calls,
    client: {
      spreadsheets: {
        values: {
          get: async (request) => {
            calls.get.push(request.range);
            return {
              data: {
                values: columnValues.map((value) => [value])
              }
            };
          },
          clear: async (request) => {
            calls.clear.push(request.range);
            return {};
          },
          update: async (request) => {
            calls.update.push({
              range: request.range,
              values: request.requestBody.values
            });
            return {};
          },
          batchUpdate: async (request) => {
            calls.batchValueUpdate.push(request.requestBody.data);
            return {};
          }
        },
        batchUpdate: async (request) => {
          calls.batchUpdate.push(request.requestBody.requests);
          return { data: {} };
        }
      }
    }
  };
}

function createInMemorySheets(initialSheets = {}) {
  let nextSheetId = Math.max(
    0,
    ...Object.values(initialSheets).map((sheet) => Number(sheet.sheetId) || 0)
  ) + 1;
  const sheetEntries = new Map(
    Object.entries(initialSheets).map(([title, sheet]) => [
      title,
      {
        sheetId: sheet.sheetId,
        protectedRanges: (sheet.protectedRanges ?? []).map((range) => ({ ...range })),
        values: (sheet.values ?? []).map((row) => [...row])
      }
    ])
  );
  const calls = {
    getSpreadsheet: 0,
    getRanges: [],
    addedSheets: [],
    valueUpdates: [],
    batchValueUpdates: [],
    batchUpdateRequests: []
  };

  function parseColumnLabel(label) {
    return label.split("").reduce((total, character) => (total * 26) + character.charCodeAt(0) - 64, 0) - 1;
  }

  function parseRange(range) {
    const [, title, startLabel, startRowRaw, endLabel, endRowRaw] =
      range.match(/^'(.+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/) ?? [];

    if (!title) {
      throw new Error(`Unsupported range: ${range}`);
    }

    const startColumnIndex = parseColumnLabel(startLabel);
    const endColumnIndex = parseColumnLabel(endLabel ?? startLabel);
    const startRowIndex = Number(startRowRaw) - 1;
    const endRowIndex = endRowRaw ? Number(endRowRaw) - 1 : null;

    return {
      title,
      startColumnIndex,
      endColumnIndex,
      startRowIndex,
      endRowIndex
    };
  }

  function ensureSheetEntry(title) {
    const existing = sheetEntries.get(title);

    if (existing) {
      return existing;
    }

    const created = {
      sheetId: nextSheetId,
      protectedRanges: [],
      values: []
    };
    nextSheetId += 1;
    sheetEntries.set(title, created);
    return created;
  }

  function ensureCell(sheet, rowIndex, columnIndex) {
    while (sheet.values.length <= rowIndex) {
      sheet.values.push([]);
    }

    while (sheet.values[rowIndex].length <= columnIndex) {
      sheet.values[rowIndex].push("");
    }
  }

  function setCell(sheet, rowIndex, columnIndex, value) {
    ensureCell(sheet, rowIndex, columnIndex);
    sheet.values[rowIndex][columnIndex] = String(value ?? "");
  }

  function getRangeValues(sheet, parsedRange) {
    const rows = [];
    const lastRowIndex =
      parsedRange.endRowIndex === null
        ? Math.max(sheet.values.length - 1, parsedRange.startRowIndex)
        : parsedRange.endRowIndex;

    for (let rowIndex = parsedRange.startRowIndex; rowIndex <= lastRowIndex; rowIndex += 1) {
      const sourceRow = sheet.values[rowIndex] ?? [];
      const row = [];

      for (
        let columnIndex = parsedRange.startColumnIndex;
        columnIndex <= parsedRange.endColumnIndex;
        columnIndex += 1
      ) {
        row.push(String(sourceRow[columnIndex] ?? ""));
      }

      while (row.length > 0 && row[row.length - 1] === "") {
        row.pop();
      }

      rows.push(row);
    }

    while (rows.length > 0 && rows[rows.length - 1].length === 0) {
      rows.pop();
    }

    return rows;
  }

  function applyValues(range, values) {
    const parsedRange = parseRange(range);
    const sheet = ensureSheetEntry(parsedRange.title);

    values.forEach((row, rowOffset) => {
      row.forEach((value, columnOffset) => {
        setCell(
          sheet,
          parsedRange.startRowIndex + rowOffset,
          parsedRange.startColumnIndex + columnOffset,
          value
        );
      });
    });
  }

  function clearRange(range) {
    const parsedRange = parseRange(range);
    const sheet = ensureSheetEntry(parsedRange.title);
    const lastRowIndex =
      parsedRange.endRowIndex === null
        ? Math.max(sheet.values.length - 1, parsedRange.startRowIndex)
        : parsedRange.endRowIndex;

    for (let rowIndex = parsedRange.startRowIndex; rowIndex <= lastRowIndex; rowIndex += 1) {
      for (
        let columnIndex = parsedRange.startColumnIndex;
        columnIndex <= parsedRange.endColumnIndex;
        columnIndex += 1
      ) {
        setCell(sheet, rowIndex, columnIndex, "");
      }
    }
  }

  function insertRows(sheetId, startIndex, count) {
    const entry = [...sheetEntries.values()].find((sheet) => sheet.sheetId === sheetId);

    if (!entry) {
      return;
    }

    for (let index = 0; index < count; index += 1) {
      entry.values.splice(startIndex, 0, []);
    }
  }

  function deleteRows(sheetId, startIndex, count) {
    const entry = [...sheetEntries.values()].find((sheet) => sheet.sheetId === sheetId);

    if (!entry) {
      return;
    }

    entry.values.splice(startIndex, count);
  }

  function moveRows(title, startIndex, count, destinationIndex) {
    const entry = ensureSheetEntry(title);
    const movedRows = entry.values.splice(startIndex, count);
    const adjustedDestination = destinationIndex > startIndex
      ? destinationIndex - count
      : destinationIndex;
    entry.values.splice(adjustedDestination, 0, ...movedRows);
  }

  function insertColumns(title, startIndex, count) {
    const entry = ensureSheetEntry(title);

    for (const row of entry.values) {
      row.splice(startIndex, 0, ...Array.from({ length: count }, () => ""));
    }
  }

  function deleteColumns(title, startIndex, count) {
    const entry = ensureSheetEntry(title);

    for (const row of entry.values) {
      row.splice(startIndex, count);
    }
  }

  return {
    calls,
    getSheetValues(title) {
      return (sheetEntries.get(title)?.values ?? []).map((row) => [...row]);
    },
    moveRows,
    insertColumns,
    deleteColumns,
    client: {
      spreadsheets: {
        get: async () => {
          calls.getSpreadsheet += 1;
          return {
            data: {
              sheets: [...sheetEntries.entries()].map(([title, sheet]) => ({
                properties: {
                  title,
                  sheetId: sheet.sheetId
                },
                protectedRanges: sheet.protectedRanges
              }))
            }
          };
        },
        batchUpdate: async (request) => {
          const requests = request.requestBody.requests ?? [];
          calls.batchUpdateRequests.push(requests);

          const replies = [];

          for (const operation of requests) {
            if (operation.addSheet) {
              const title = operation.addSheet.properties.title;
              const sheet = ensureSheetEntry(title);
              calls.addedSheets.push(title);
              replies.push({
                addSheet: {
                  properties: {
                    title,
                    sheetId: sheet.sheetId
                  }
                }
              });
              continue;
            }

            if (operation.addProtectedRange?.protectedRange) {
              const target = [...sheetEntries.values()].find(
                (sheet) => sheet.sheetId === operation.addProtectedRange.protectedRange.range?.sheetId
              );

              if (target) {
                target.protectedRanges.push({ ...operation.addProtectedRange.protectedRange });
              }

              continue;
            }

            if (operation.insertDimension?.range?.dimension === "ROWS") {
              insertRows(
                operation.insertDimension.range.sheetId,
                operation.insertDimension.range.startIndex,
                operation.insertDimension.range.endIndex - operation.insertDimension.range.startIndex
              );
              continue;
            }

            if (operation.deleteDimension?.range?.dimension === "ROWS") {
              deleteRows(
                operation.deleteDimension.range.sheetId,
                operation.deleteDimension.range.startIndex,
                operation.deleteDimension.range.endIndex - operation.deleteDimension.range.startIndex
              );
              continue;
            }

            if (operation.updateCells) {
              const target = [...sheetEntries.values()].find(
                (sheet) => sheet.sheetId === operation.updateCells.start.sheetId
              );
              const title = [...sheetEntries.entries()].find(
                ([, sheet]) => sheet.sheetId === operation.updateCells.start.sheetId
              )?.[0];

              operation.updateCells.rows.forEach((row, rowOffset) => {
                row.values.forEach((cell, columnOffset) => {
                  setCell(
                    target,
                    operation.updateCells.start.rowIndex + rowOffset,
                    operation.updateCells.start.columnIndex + columnOffset,
                    cell.userEnteredValue?.stringValue ?? ""
                  );
                });
              });

              if (title) {
                calls.valueUpdates.push({ range: `'${title}'!A1`, values: target.values[0] });
              }
            }
          }

          return { data: { replies } };
        },
        values: {
          get: async (request) => {
            calls.getRanges.push(request.range);
            const parsedRange = parseRange(request.range);
            const sheet = ensureSheetEntry(parsedRange.title);
            return {
              data: {
                values: getRangeValues(sheet, parsedRange)
              }
            };
          },
          update: async (request) => {
            calls.valueUpdates.push({
              range: request.range,
              values: request.requestBody.values
            });
            applyValues(request.range, request.requestBody.values);
            return {};
          },
          clear: async (request) => {
            clearRange(request.range);
            return {};
          },
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

async function withTempDataDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "attendance-sheet-cache-"));
  process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;

  try {
    await run(tempDir);
  } finally {
    delete process.env.ATTENDANCE_BOT_DATA_DIR;
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function withMockedFetch(jsonPayload, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => jsonPayload
  });

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("monthly managed-row writes preserve rows below Remarks and stay batched", async () => {
  const fake = createFakeSheets(["ALPHA", "Remarks", "Manual note"]);

  await __testing.writeMonthlySheetRows(
    fake.client,
    "spreadsheet-id",
    123,
    "Mar 26",
    3,
    ["Appointment", "1 Mar", "2 Mar"],
    "Asia/Singapore",
    [["ALPHA", "PRESENT", ""]],
    [["ALPHA", "PRESENT", ""]],
    ["Remarks"]
  );

  assert.deepEqual(fake.calls.clear, []);
  assert.deepEqual(fake.calls.batchUpdate, []);
  assert.deepEqual(fake.calls.batchValueUpdate, []);
});

test("managed monthly rows follow onboarding order while preserving existing row data", async () => {
  const result = __testing.buildManagedMonthlyRows({
    preferredAppointments: ["BRAVO", "ALPHA"],
    requestedAppointments: ["ALPHA"],
    existingAppointments: ["ALPHA", "CHARLIE"],
    existingRows: [
      ["ALPHA", "PRESENT", ""],
      ["CHARLIE", "WFH", ""]
    ],
    headerLength: 3,
    mode: "merge"
  });

  assert.deepEqual(result.nextAppointments, ["BRAVO", "ALPHA"]);
  assert.deepEqual(result.nextRows, [
    ["BRAVO", "", ""],
    ["ALPHA", "PRESENT", ""]
  ]);
});

test("canonical appointment ordering keeps top block, departments, and variants grouped", () => {
  const ordered = __testing.orderAppointmentsCanonically([
    "WS 2",
    "SCSE (OUT)",
    "COXN",
    "ANO 2",
    "CC2",
    "CO",
    "SCSE",
    "OPS 2",
    "OPS 1 (B)",
    "OPS 1",
    "MS WPL (69)-1",
    "MS 1",
    "MS Sup 2",
    "Chef 1",
    "CCHEF",
    "ANO",
    "XO"
  ]);

  assert.deepEqual(ordered, [
    "CO",
    "XO",
    "OPS 1",
    "OPS 1 (B)",
    "OPS 2",
    "SCSE",
    "SCSE (OUT)",
    "COXN",
    "ANO",
    "ANO 2",
    "CC2",
    "WS 2",
    "MS Sup 2",
    "MS 1",
    "MS WPL (69)-1",
    "CCHEF",
    "Chef 1"
  ]);
});

test("comms specialist stays distinct from comms in canonical ordering", () => {
  const ordered = __testing.orderAppointmentsCanonically([
    "Comms Specialist 1",
    "Comms 2",
    "Chief Comms Specialist",
    "CComms",
    "Comms Sup",
    "Comms Specialist Sup"
  ]);

  assert.deepEqual(ordered, [
    "CComms",
    "Comms Sup",
    "Comms 2",
    "Chief Comms Specialist",
    "Comms Specialist Sup",
    "Comms Specialist 1"
  ]);
});

test("department classifier maps officers and specialist departments correctly", () => {
  assert.equal(__testing.classifyAppointmentDepartment("SCSE (OUT)"), "Officers");
  assert.equal(__testing.classifyAppointmentDepartment("OPS 3"), "Officers");
  assert.equal(__testing.classifyAppointmentDepartment("Chief Comms Specialist"), "Comms Specialist");
  assert.equal(__testing.classifyAppointmentDepartment("Comms 2"), "Comms");
  assert.equal(__testing.classifyAppointmentDepartment("Unknown Role"), null);
});

test("month slice maps row numbers by live appointment labels instead of row index", () => {
  const slice = __testing.createMonthSliceFromValues(
    new Date("2026-03-01T12:00:00.000Z"),
    [
      ["Appointment", "1 Mar"],
      ["BRAVO", "WFH"],
      ["ALPHA", "PRESENT"],
      ["Remarks", ""]
    ],
    {
      timezone: "Asia/Singapore",
      rosterStopMarkers: ["Remarks"]
    },
    ["ALPHA", "BRAVO"]
  );

  assert.deepEqual(slice.rowNumbersByAppointment, {
    ALPHA: 3,
    BRAVO: 2
  });
  assert.equal(slice.snapshot.statusesByDay.get(1)[0], "PRESENT");
  assert.equal(slice.snapshot.statusesByDay.get(1)[1], "WFH");
});

test("month slice canonicalizes common free-text attendance aliases", () => {
  const slice = __testing.createMonthSliceFromValues(
    new Date("2026-03-01T12:00:00.000Z"),
    [
      ["Appointment", "1 Mar", "2 Mar", "3 Mar"],
      ["ALPHA", "On Course", "Public Holiday", "Work from Home"]
    ],
    {
      timezone: "Asia/Singapore",
      rosterStopMarkers: []
    },
    ["ALPHA"]
  );

  assert.equal(slice.snapshot.statusesByDay.get(1)[0], "OC");
  assert.equal(slice.snapshot.statusesByDay.get(2)[0], "PH");
  assert.equal(slice.snapshot.statusesByDay.get(3)[0], "WFH");
  assert.deepEqual(
    slice.aliasCorrections.map((entry) => ({
      rowNumber: entry.rowNumber,
      columnIndex: entry.columnIndex,
      normalizedValue: entry.normalizedValue
    })),
    [
      { rowNumber: 2, columnIndex: 1, normalizedValue: "OC" },
      { rowNumber: 2, columnIndex: 2, normalizedValue: "PH" },
      { rowNumber: 2, columnIndex: 3, normalizedValue: "WFH" }
    ]
  );
});

test("pure row reordering is repaired by rewriting the managed rows in canonical order", async () => {
  const fake = createInMemorySheets({
    "Mar 26": {
      sheetId: 1,
      values: [
        ["Appointment", "1 Mar"],
        ["BRAVO", "WFH"],
        ["ALPHA", "PRESENT"],
        ["Remarks", ""]
      ]
    }
  });

  await __testing.writeMonthlySheetRows(
    fake.client,
    "spreadsheet-id",
    1,
    "Mar 26",
    2,
    ["Appointment", "1 Mar"],
    "Asia/Singapore",
    [
      ["BRAVO", "WFH"],
      ["ALPHA", "PRESENT"]
    ],
    [
      ["ALPHA", "PRESENT"],
      ["BRAVO", "WFH"]
    ],
    ["Remarks"]
  );

  assert.deepEqual(fake.getSheetValues("Mar 26").slice(1, 3), [
    ["ALPHA", "PRESENT"],
    ["BRAVO", "WFH"]
  ]);
});

test("existing human-managed headers are preserved when already populated", async () => {
  const calls = [];
  const sheets = {
    spreadsheets: {
      values: {
        get: async () => ({
          data: {
            values: [["Custom Appointment", "Custom Code"]]
          }
        }),
        update: async (request) => {
          calls.push(request);
          return {};
        }
      }
    }
  };

  await __testing.ensureHeaderRowIfBlank(
    sheets,
    "spreadsheet-id",
    "ONBOARDING",
    ["Appointment", "Secret Code"]
  );

  assert.equal(calls.length, 0);
});

test("existing monthly sheets get protections for the header row and appointment column", async () => {
  const fake = createInMemorySheets({
    ONBOARDING: {
      sheetId: 1,
      values: [
        ["Appointment", "Secret Code"],
        ["ALPHA", "CODE-1"]
      ]
    },
    "Mar 26": {
      sheetId: 2,
      values: [
        ["Appointment", "1 Mar"],
        ["ALPHA", "PRESENT"]
      ]
    }
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { holidays: [] } })
  });

  try {
    await syncOnboardingRoster(
      fake.client,
      {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: [],
        onboardingSheetTitle: "ONBOARDING",
        attendanceOptions: ["PRESENT", "WFH"],
        googleServiceAccountEmail: "bot@example.com"
      }
    );
  } finally {
    global.fetch = originalFetch;
  }

  const protectionRequests = fake.calls.batchUpdateRequests
    .flat()
    .filter((request) => request.addProtectedRange);

  assert.equal(protectionRequests.length, 4);
  assert.deepEqual(
    protectionRequests.map((request) => request.addProtectedRange.protectedRange.description),
    [
      "attendance-bot:protect-header-row",
      "attendance-bot:protect-appointment-column",
      "attendance-bot:protect-header-row",
      "attendance-bot:protect-appointment-column"
    ]
  );
  assert.deepEqual(
    protectionRequests.map((request) => request.addProtectedRange.protectedRange.editors?.users ?? []),
    [["bot@example.com"], ["bot@example.com"], ["bot@example.com"], ["bot@example.com"]]
  );
});

test("monthly sheet protection failures are treated as best effort", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);

  try {
    await __testing.ensureMonthlySheetProtections(
      {
        spreadsheets: {
          batchUpdate: async () => {
            throw Object.assign(new Error("slow backend"), {
              code: "ETIMEDOUT",
              status: 504,
              isTimeout: true
            });
          }
        }
      },
      "spreadsheet-id",
      {
        properties: { sheetId: 99 },
        protectedRanges: []
      },
      "bot@example.com"
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(warnings.length >= 1);
  assert.match(warnings.at(-1), /Skipping monthly sheet protections for sheet 99/);
});

test("date lookup follows the actual header row instead of fixed column offsets", () => {
  const headerRow = ["Appointment", "Notes", "1 Mar", "2 Mar", "Custom"];
  const date = new Date("2026-03-01T12:00:00.000Z");
  const map = __testing.buildDateColumnMap(headerRow, date, "Asia/Singapore");

  assert.equal(__testing.getExpectedDateHeaderLabel(date, "Asia/Singapore"), "1 Mar");
  assert.equal(map.get(1), 2);
  assert.equal(map.get(2), 3);
});

test("new-sheet header update request targets the real sheet grid", () => {
  const request = __testing.buildHeaderUpdateRequest(456, ["Appointment", "1 Mar"]);

  assert.equal(request.updateCells.start.sheetId, 456);
  assert.deepEqual(
    request.updateCells.rows[0].values.map((cell) => cell.userEnteredValue.stringValue),
    ["Appointment", "1 Mar"]
  );
});

test("month shifting rolls cleanly into the next year", () => {
  const decemberDate = new Date("2026-12-15T12:00:00.000Z");
  const januaryDate = __testing.shiftMonth(decemberDate, "Asia/Singapore", 1);

  assert.equal(__testing.getMonthParts(januaryDate, "Asia/Singapore").title, "Jan 27");
});

test("onboarding parsing keeps unmanaged rows below the terminal stop marker", () => {
  const parsed = __testing.parseOnboardingManagedRows([
    ["Appointment", "Secret Code"],
    ["ALPHA", "A1"],
    ["BRAVO", "B1"],
    ["Remarks", ""],
    ["Manual note", "leave me alone"]
  ], ["Remarks"]);

  assert.deepEqual(parsed.appointments, ["ALPHA", "BRAVO"]);
  assert.equal(parsed.stopRowNumber, 4);
  assert.equal(parsed.stopMarkerMissing, false);
  assert.equal(parsed.hadInlineStopMarkerDrift, true);
});

test("onboarding parsing treats blank rows inside the managed block as drift without truncating trailing appointments", () => {
  const parsed = __testing.parseOnboardingManagedRows([
    ["Appointment", "Secret Code"],
    ["ALPHA", "A1"],
    ["", ""],
    ["BRAVO", "B1"],
    ["Remarks", ""]
  ], ["Remarks"]);

  assert.deepEqual(parsed.appointments, ["ALPHA", "BRAVO"]);
  assert.equal(parsed.hasBlankRowDrift, true);
  assert.deepEqual(parsed.blankRowNumbers, [3]);
  assert.equal(parsed.stopRowNumber, 5);
});

test("onboarding parsing reports duplicates instead of synthesizing new appointment identities", () => {
  const parsed = __testing.parseOnboardingManagedRows([
    ["Appointment", "Secret Code"],
    ["ALPHA", "A1"],
    ["ALPHA", "A2"],
    ["BRAVO", "B1"],
    ["Remarks", ""]
  ], ["Remarks"]);

  assert.deepEqual(parsed.appointments, ["ALPHA", "BRAVO"]);
  assert.deepEqual(parsed.duplicateAppointments, ["ALPHA"]);
  assert.ok(!parsed.appointments.some((appointment) => appointment.includes("-")));
});

test("writeAppointmentColumn clears a legacy remarks boundary instead of rewriting it", async () => {
  const fake = createInMemorySheets({
    ONBOARDING: {
      sheetId: 1,
      values: [
        ["Appointment", "Secret Code"],
        ["ALPHA", "CODE"],
        ["Remarks", ""]
      ]
    }
  });

  await __testing.writeAppointmentColumn(
    fake.client,
    "spreadsheet-id",
    "ONBOARDING",
    ["ALPHA"],
    { stopMarkers: ["Remarks"] }
  );

  assert.equal(fake.calls.batchValueUpdates.length, 1);
  assert.deepEqual(fake.calls.batchValueUpdates[0], [
    {
      range: "'ONBOARDING'!A3:B3",
      values: [["", ""]]
    }
  ]);
  assert.deepEqual(fake.getSheetValues("ONBOARDING").slice(0, 3), [
    ["Appointment", "Secret Code"],
    ["ALPHA", "CODE"],
    ["", ""]
  ]);
});

test("blank bootstrap falls back to USER1, USER2, and USER3", () => {
  assert.deepEqual(
    __testing.getBootstrapAppointments([]),
    __testing.DEFAULT_BOOTSTRAP_APPOINTMENTS
  );
  assert.deepEqual(
    __testing.getBootstrapAppointments(["ALPHA", "BRAVO"]),
    ["ALPHA", "BRAVO"]
  );
});

test("syncOnboardingRoster bootstraps a blank spreadsheet with onboarding and two month sheets", async () => {
  await withMockedFetch([], async () => {
    await withTempDataDir(async () => {
      const fake = createInMemorySheets();
      const currentMonthTitle = __testing.getMonthParts(new Date(), "Asia/Singapore").title;
      const nextMonthTitle = __testing.getMonthParts(
        __testing.shiftMonth(new Date(), "Asia/Singapore", 1),
        "Asia/Singapore"
      ).title;

      const result = await syncOnboardingRoster(fake.client, {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: ["Remarks"],
        onboardingSheetTitle: "ONBOARDING",
        attendanceOptions: ["PRESENT", "WFH", "OS"]
      });

      assert.deepEqual(result.onboardingAppointments, ["USER1", "USER2", "USER3"]);
      assert.equal(result.currentMonthTitle, currentMonthTitle);
      assert.equal(result.nextMonthTitle, nextMonthTitle);
      assert.deepEqual(
        fake.getSheetValues("ONBOARDING").slice(0, 4),
        [
          ["Appointment", "Secret Code"],
          ["USER1", ""],
          ["USER2", ""],
          ["USER3", ""]
        ]
      );
      assert.equal(fake.getSheetValues(currentMonthTitle)[0][0], "Appointment");
      assert.equal(fake.getSheetValues(currentMonthTitle)[1][0], "USER1");
      assert.equal(fake.getSheetValues(nextMonthTitle)[1][0], "USER1");
    });
  });
});

test("syncOnboardingRoster restores onboarding from the latest existing month sheet before using placeholders", async () => {
  await withMockedFetch([], async () => {
    await withTempDataDir(async () => {
      const previousMonthDate = __testing.shiftMonth(new Date(), "Asia/Singapore", -1);
      const previousMonthTitle = __testing.getMonthParts(previousMonthDate, "Asia/Singapore").title;
      const currentMonthTitle = __testing.getMonthParts(new Date(), "Asia/Singapore").title;
      const nextMonthTitle = __testing.getMonthParts(
        __testing.shiftMonth(new Date(), "Asia/Singapore", 1),
        "Asia/Singapore"
      ).title;
      const previousMonthHeader = ["Appointment"];
      const previousMonthParts = __testing.getMonthParts(previousMonthDate, "Asia/Singapore");

      for (let day = 1; day <= 2; day += 1) {
        previousMonthHeader.push(`${day} ${previousMonthParts.month}`);
      }

      const fake = createInMemorySheets({
        [previousMonthTitle]: {
          sheetId: 1,
          values: [
            previousMonthHeader,
            ["ALPHA", "PRESENT", ""],
            ["BRAVO", "", "WFH"],
            ["Remarks"]
          ]
        }
      });

      const result = await syncOnboardingRoster(fake.client, {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: ["Remarks"],
        onboardingSheetTitle: "ONBOARDING",
        attendanceOptions: ["PRESENT", "WFH", "OS"]
      });

      assert.deepEqual(result.onboardingAppointments, ["ALPHA", "BRAVO"]);
      assert.deepEqual(
        fake.getSheetValues("ONBOARDING").slice(0, 3),
        [
          ["Appointment", "Secret Code"],
          ["ALPHA", ""],
          ["BRAVO", ""]
        ]
      );
      assert.equal(fake.getSheetValues(currentMonthTitle)[1][0], "ALPHA");
      assert.equal(fake.getSheetValues(nextMonthTitle)[2][0], "BRAVO");
      assert.ok(!fake.getSheetValues("ONBOARDING").some((row) => row[0] === "USER1"));
    });
  });
});

test("syncOnboardingRoster reuses spreadsheet metadata within one operation", async () => {
  await withMockedFetch([], async () => {
    await withTempDataDir(async () => {
      const fake = createInMemorySheets();

      await syncOnboardingRoster(fake.client, {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: ["Remarks"],
        onboardingSheetTitle: "ONBOARDING",
        attendanceOptions: ["PRESENT", "WFH", "OS"]
      });

      assert.ok(fake.calls.getSpreadsheet <= 2);
    });
  });
});

test("syncOnboardingRoster preserves visible onboarding order as canonical row order", async () => {
  await withMockedFetch([], async () => {
    await withTempDataDir(async () => {
      const currentMonthTitle = __testing.getMonthParts(new Date(), "Asia/Singapore").title;
      const fake = createInMemorySheets({
        ONBOARDING: {
          sheetId: 1,
          values: [
            ["Appointment", "Secret Code"],
            ["BRAVO", "B1"],
            ["ALPHA", "A1"],
            ["Remarks", ""]
          ]
        }
      });

      const result = await syncOnboardingRoster(fake.client, {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: ["Remarks"],
        onboardingSheetTitle: "ONBOARDING",
        attendanceOptions: ["PRESENT", "WFH", "OS"]
      });

      assert.deepEqual(result.onboardingAppointments, ["BRAVO", "ALPHA"]);
      assert.deepEqual(fake.getSheetValues(currentMonthTitle).slice(1, 3).map((row) => row[0]), [
        "BRAVO",
        "ALPHA"
      ]);
    });
  });
});

test("syncOnboardingRoster blocks month repair when unexpected rows exist inside the managed block", async () => {
  await withMockedFetch([], async () => {
    await withTempDataDir(async () => {
      const currentMonthTitle = __testing.getMonthParts(new Date(), "Asia/Singapore").title;
      const nextMonthTitle = __testing.getMonthParts(
        __testing.shiftMonth(new Date(), "Asia/Singapore", 1),
        "Asia/Singapore"
      ).title;
      const fake = createInMemorySheets({
        ONBOARDING: {
          sheetId: 1,
          values: [
            ["Appointment", "Secret Code"],
            ["ALPHA", "A1"],
            ["Remarks", ""]
          ]
        },
        [currentMonthTitle]: {
          sheetId: 2,
          values: [
            ["Appointment", `1 ${__testing.getMonthParts(new Date(), "Asia/Singapore").month}`],
            ["ALPHA", "PRESENT"],
            ["Manual note", "leave me alone"],
            ["Remarks", ""]
          ]
        },
        [nextMonthTitle]: {
          sheetId: 3,
          values: [
            ["Appointment", `1 ${__testing.getMonthParts(__testing.shiftMonth(new Date(), "Asia/Singapore", 1), "Asia/Singapore").month}`],
            ["ALPHA", ""],
            ["Remarks", ""]
          ]
        }
      });

      await syncOnboardingRoster(fake.client, {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: ["Remarks"],
        onboardingSheetTitle: "ONBOARDING",
        attendanceOptions: ["PRESENT", "WFH", "OS"]
      });

      assert.deepEqual(fake.getSheetValues(currentMonthTitle).slice(1, 4), [
        ["ALPHA", "PRESENT"],
        ["Manual note", "leave me alone"],
        ["Remarks", ""]
      ]);
    });
  });
});

test("attendance option usage only scans the latest 2 month sheets", async () => {
  const baseDate = new Date();
  const recentTitles = __testing.getRecentMonthTitles(baseDate, "Asia/Singapore", 2);
  const olderTitle = __testing.getMonthParts(
    __testing.shiftMonth(baseDate, "Asia/Singapore", -2),
    "Asia/Singapore"
  ).title;
  const requestedRanges = [];
  const sheets = {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: [
            { properties: { title: recentTitles[1], sheetId: 1 } },
            { properties: { title: recentTitles[0], sheetId: 2 } },
            { properties: { title: olderTitle, sheetId: 3 } }
          ]
        }
      }),
      values: {
        get: async (request) => {
          requestedRanges.push(request.range);

          if (request.range.startsWith(`'${recentTitles[0]}'`)) {
            return { data: { values: [["Appointment", "Day"], ["ALPHA", "PRESENT"], ["Remarks", ""]] } };
          }

          if (request.range.startsWith(`'${recentTitles[1]}'`)) {
            return { data: { values: [["Appointment", "Day"], ["ALPHA", "WFH"], ["Remarks", ""]] } };
          }

          return { data: { values: [["Appointment", "Day"], ["ALPHA", "OS"], ["Remarks", ""]] } };
        }
      }
    }
  };

  const counts = await summarizeAttendanceOptionUsage(sheets, {
    spreadsheetId: "spreadsheet-id",
    timezone: "Asia/Singapore",
    rosterStopMarkers: ["Remarks"],
    attendanceOptions: ["PRESENT", "WFH", "OS", "MC"]
  });

  assert.equal(counts.PRESENT, 1);
  assert.equal(counts.WFH, 1);
  assert.equal(counts.OS, 0);
  assert.equal(counts.MC, 0);
  assert.ok(requestedRanges.some((range) => range.startsWith(`'${recentTitles[0]}'`)));
  assert.ok(requestedRanges.some((range) => range.startsWith(`'${recentTitles[1]}'`)));
  assert.ok(!requestedRanges.some((range) => range.startsWith(`'${olderTitle}'`)));
});

test("retry wrapper succeeds after retryable 429 errors", async () => {
  const delays = [];
  let attempts = 0;

  const result = await __testing.runGoogleSheetsRequest(
    "retryable-test",
    async () => {
      attempts += 1;

      if (attempts < 3) {
        const error = new Error("Too many requests");
        error.status = 429;
        throw error;
      }

      return "ok";
    },
    {
      sleepFn: async (delayMs) => delays.push(delayMs),
      randomFn: () => 0,
      logFn: () => {}
    }
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [0, 0]);
});

test("retry wrapper stops immediately for non-retryable errors", async () => {
  let attempts = 0;

  await assert.rejects(
    __testing.runGoogleSheetsRequest(
      "non-retryable-test",
      async () => {
        attempts += 1;
        const error = new Error("Bad request");
        error.status = 400;
        throw error;
      },
      {
        sleepFn: async () => {},
        logFn: () => {}
      }
    ),
    /Bad request/
  );

  assert.equal(attempts, 1);
});

test("retry wrapper fails after max retry attempts", async () => {
  let attempts = 0;

  await assert.rejects(
    __testing.runGoogleSheetsRequest(
      "exhausted-test",
      async () => {
        attempts += 1;
        const error = new Error("Quota exceeded");
        error.status = 429;
        throw error;
      },
      {
        maxAttempts: 3,
        sleepFn: async () => {},
        randomFn: () => 0,
        logFn: () => {}
      }
    ),
    /Quota exceeded/
  );

  assert.equal(attempts, 3);
});

test("retry wrapper times out stalled requests instead of hanging forever", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    __testing.runGoogleSheetsRequest(
      "timeout-test",
      async () => new Promise(() => {}),
      {
        maxAttempts: 1,
        timeoutMs: 5,
        logFn: () => {}
      }
    ),
    /timed out/
  );

  assert.ok(Date.now() - startedAt < 250);
});

test("pending attendance overlays replace the snapshot value seen by the bot", async () => {
  const { applyAttendanceEntriesToSnapshotBundle } = await import("../src/googleSheets.js");
  const snapshotBundle = {
    synchronizedAt: new Date().toISOString(),
    snapshots: new Map([["Mar 26", {
      title: "Mar 26",
      appointments: ["ALPHA"],
      statusesByDay: new Map([[24, ["PRESENT"]]]),
      synchronizedAt: new Date().toISOString()
    }]])
  };

  const nextBundle = applyAttendanceEntriesToSnapshotBundle(
    snapshotBundle,
    { timezone: "Asia/Singapore" },
    [{
      appointment: "ALPHA",
      status: "WFH",
      date: new Date("2026-03-24T12:00:00.000Z")
    }]
  );

  assert.equal(nextBundle.snapshots.get("Mar 26").statusesByDay.get(24)[0], "WFH");
});

test("cached summary remains stable when month slices are rebuilt from deserialized snapshots", async () => {
  const { summarizeStatusesFromSnapshot } = await import("../src/googleSheets.js");
  const snapshotBundle = {
    synchronizedAt: new Date().toISOString(),
    snapshots: new Map([["Mar 26", {
      title: "Mar 26",
      appointments: ["ALPHA"],
      statusesByDay: new Map([[24, ["PRESENT"]]]),
      synchronizedAt: new Date().toISOString()
    }]])
  };

  const rebuiltBundle = {
    synchronizedAt: new Date().toISOString(),
    snapshots: new Map(
      [...snapshotBundle.snapshots.entries()].map(([title, snapshot]) => [
        title,
        {
          title: snapshot.title,
          appointments: [...snapshot.appointments],
          statusesByDay: new Map([...snapshot.statusesByDay.entries()]),
          synchronizedAt: snapshot.synchronizedAt
        }
      ])
    )
  };

  const summary = summarizeStatusesFromSnapshot(
    rebuiltBundle,
    { timezone: "Asia/Singapore" },
    { date: new Date("2026-03-24T12:00:00.000Z") }
  );

  assert.equal(summary.summary.present, 1);
  assert.equal(summary.summary.total, 1);
});

test("summary groups statuses into the requested major buckets", async () => {
  const { summarizeStatusesFromSnapshot } = await import("../src/googleSheets.js");
  const snapshotBundle = {
    synchronizedAt: new Date().toISOString(),
    snapshots: new Map([["Mar 26", {
      title: "Mar 26",
      appointments: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"],
      statusesByDay: new Map([[24, [
        "PRESENT",
        "PH",
        "OSD",
        "WFH",
        "RR",
        "OS",
        "MC",
        "LL",
        "OL",
        "68",
        "OC",
        "IPPT"
      ]]]),
      synchronizedAt: new Date().toISOString()
    }]])
  };

  const summary = summarizeStatusesFromSnapshot(
    snapshotBundle,
    { timezone: "Asia/Singapore" },
    { date: new Date("2026-03-24T12:00:00.000Z") }
  );

  assert.equal(summary.summary.present, 1);
  assert.equal(summary.summary.ph, 1);
  assert.equal(summary.summary.osd, 1);
  assert.equal(summary.summary.wfh, 1);
  assert.equal(summary.summary.off, 1);
  assert.equal(summary.summary.outstationed, 1);
  assert.equal(summary.summary.reportSick, 1);
  assert.equal(summary.summary.localLeave, 1);
  assert.equal(summary.summary.overseasLeave, 1);
  assert.equal(summary.summary.attachedOut, 1);
  assert.equal(summary.summary.onCourse, 1);
  assert.equal(summary.summary.inBase, 1);
});

test("managed area grows by inserting a row instead of clearing and rewriting the block", async () => {
  const fake = createFakeSheets(["ALPHA", "Remarks", "Manual note"]);

  await __testing.writeMonthlySheetRows(
    fake.client,
    "spreadsheet-id",
    123,
    "Mar 26",
    3,
    ["Appointment", "1 Mar", "2 Mar"],
    "Asia/Singapore",
    [["ALPHA", "PRESENT", ""]],
    [
      ["ALPHA", "PRESENT", ""],
      ["BRAVO", "", ""]
    ],
    ["Remarks"]
  );

  assert.deepEqual(fake.calls.clear, []);
  assert.equal(fake.calls.batchUpdate.length, 1);
  assert.deepEqual(fake.calls.batchUpdate[0], [{
    insertDimension: {
      range: {
        sheetId: 123,
        dimension: "ROWS",
        startIndex: 2,
        endIndex: 3
      },
      inheritFromBefore: true
    }
  }]);
  assert.deepEqual(fake.calls.batchValueUpdate, [[{
    range: "'Mar 26'!A3:C3",
    values: [["BRAVO", "", ""]]
  }]]);
});

test("five-minute reconciliation prefers direct sheet edits over queued bot changes", async () => {
  await withTempDataDir(async (tempDir) => {
    await writeFile(
      path.join(tempDir, "sheet-cache.json"),
      JSON.stringify({
        updatedAt: "2026-03-24T00:00:00.000Z",
        spreadsheetMetadata: {
          fetchedAt: "2026-03-24T00:00:00.000Z",
          sheetIdsByTitle: {
            ONBOARDING: 1,
            "Mar 26": 2
          }
        },
        onboardingSlice: null,
        monthSlices: {
          "Mar 26": {
            title: "Mar 26",
            headerRow: ["Appointment", "24 Mar"],
            recognizedDateColumns: { "24": 1 },
            appointments: ["ALPHA"],
            rowNumbersByAppointment: { ALPHA: 2 },
            managedAreaHash: "baseline",
            fetchedAt: "2026-03-24T00:00:00.000Z",
            snapshot: {
              title: "Mar 26",
              appointments: ["ALPHA"],
              statusesByDay: { "24": ["PRESENT"] },
              synchronizedAt: "2026-03-24T00:00:00.000Z"
            }
          }
        },
        snapshots: {}
      })
    );

    const calls = {
      batchValueUpdate: []
    };
    const sheets = {
      spreadsheets: {
        get: async () => ({
          data: {
            sheets: [
              { properties: { title: "ONBOARDING", sheetId: 1 } },
              { properties: { title: "Mar 26", sheetId: 2 } }
            ]
          }
        }),
        batchUpdate: async () => ({ data: {} }),
        values: {
          get: async (request) => {
            if (request.range === "'ONBOARDING'!A1:B1000") {
              return {
                data: {
                  values: [
                    ["Appointment", "Secret Code"],
                    ["ALPHA", "CODE"],
                    ["Remarks", ""]
                  ]
                }
              };
            }

            if (request.range === "'Mar 26'!A1:ZZ1000" || request.range === "'Mar 26'!A1:ZZ1") {
              return {
                data: {
                  values: [
                    ["Appointment", "24 Mar"],
                    ["ALPHA", "WFH"],
                    ["Remarks", ""]
                  ]
                }
              };
            }

            if (request.range === "'Mar 26'!A2:A") {
              return {
                data: {
                  values: [["ALPHA"], ["Remarks"]]
                }
              };
            }

            if (request.range.startsWith("'Mar 26'!A2:")) {
              return {
                data: {
                  values: [
                    ["ALPHA", "WFH"],
                    ["Remarks", ""]
                  ]
                }
              };
            }

            return { data: { values: [] } };
          },
          update: async () => ({}),
          clear: async () => ({}),
          batchUpdate: async (request) => {
            calls.batchValueUpdate.push(request.requestBody.data);
            return {};
          }
        }
      }
    };

    const result = await reconcilePendingAttendanceWithSheets(
      sheets,
      {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: ["Remarks"],
        onboardingSheetTitle: "ONBOARDING",
        attendanceOptions: ["PRESENT", "WFH", "OS"]
      },
      [{
        id: "event-1",
        appointment: "ALPHA",
        status: "OS",
        date: new Date("2026-03-24T12:00:00.000Z"),
        targetSheetTitle: "Mar 26"
      }],
      { force: true }
    );

    assert.equal(calls.batchValueUpdate.length, 0);
    assert.deepEqual(result.writtenEventIds, []);
    assert.equal(result.conflictedEvents.length, 1);
    assert.equal(result.conflictedEvents[0].reason, "cell_value_changed_by_human");
  });
});

test("forced snapshot preload rewrites common aliases back to canonical attendance codes", async () => {
  await withTempDataDir(async (tempDir) => {
    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "CODE-1"]
        ]
      },
      "Mar 26": {
        sheetId: 2,
        values: [
          ["Appointment", "24 Mar", "25 Mar"],
          ["ALPHA", "On Course", "Public Holiday"]
        ]
      }
    });

    process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;

    await preloadAttendanceSnapshots(
      fake.client,
      {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: [],
        onboardingSheetTitle: "ONBOARDING"
      },
      {
        force: true,
        normalizeAliases: true,
        date: new Date("2026-03-24T12:00:00.000Z"),
        targetDates: [new Date("2026-03-24T12:00:00.000Z")]
      }
    );

    assert.deepEqual(fake.calls.batchValueUpdates.at(-1), [
      { range: "'Mar 26'!B2", values: [["OC"]] },
      { range: "'Mar 26'!C2", values: [["PH"]] }
    ]);
    assert.deepEqual(fake.getSheetValues("Mar 26").slice(1, 2), [["ALPHA", "OC", "PH"]]);
  });
});

test("reconciliation blocks writes when a month sheet contains duplicate appointment rows", async () => {
  await withTempDataDir(async (tempDir) => {
    await writeFile(
      path.join(tempDir, "sheet-cache.json"),
      JSON.stringify({
        updatedAt: "2026-03-24T00:00:00.000Z",
        spreadsheetMetadata: {
          fetchedAt: "2026-03-24T00:00:00.000Z",
          sheetIdsByTitle: { ONBOARDING: 1, "Mar 26": 2 }
        },
        onboardingSlice: null,
        monthSlices: {
          "Mar 26": {
            title: "Mar 26",
            headerRow: ["Appointment", "24 Mar"],
            recognizedDateColumns: { "24": 1 },
            appointments: ["ALPHA"],
            rowNumbersByAppointment: { ALPHA: 2 },
            managedAreaHash: "baseline",
            fetchedAt: "2026-03-24T00:00:00.000Z",
            snapshot: {
              title: "Mar 26",
              appointments: ["ALPHA"],
              statusesByDay: { "24": ["PRESENT"] },
              synchronizedAt: "2026-03-24T00:00:00.000Z"
            }
          }
        },
        snapshots: {}
      })
    );

    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "CODE"],
          ["Remarks", ""]
        ]
      },
      "Mar 26": {
        sheetId: 2,
        values: [
          ["Appointment", "24 Mar"],
          ["ALPHA", "PRESENT"],
          ["ALPHA", "WFH"],
          ["Remarks", ""]
        ]
      }
    });

    const result = await reconcilePendingAttendanceWithSheets(
      fake.client,
      {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: ["Remarks"],
        onboardingSheetTitle: "ONBOARDING",
        attendanceOptions: ["PRESENT", "WFH", "OS"]
      },
      [{
        id: "event-dup",
        appointment: "ALPHA",
        status: "OS",
        date: new Date("2026-03-24T12:00:00.000Z"),
        targetSheetTitle: "Mar 26"
      }],
      { force: true }
    );

    assert.deepEqual(result.writtenEventIds, []);
    assert.equal(result.conflictedEvents[0].reason, "duplicate_appointment_row");
    assert.equal(fake.calls.batchValueUpdates.length, 0);
  });
});

test("reconciliation ignores legacy rows that appear after the full canonical onboarding roster", async () => {
  await withTempDataDir(async (tempDir) => {
    await writeFile(
      path.join(tempDir, "sheet-cache.json"),
      JSON.stringify({
        updatedAt: "2026-03-24T00:00:00.000Z",
        spreadsheetMetadata: {
          fetchedAt: "2026-03-24T00:00:00.000Z",
          sheetIdsByTitle: { ONBOARDING: 1, "Mar 26": 2 }
        },
        onboardingSlice: null,
        monthSlices: {},
        snapshots: {}
      })
    );

    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "CODE"],
          ["Remarks", ""]
        ]
      },
      "Mar 26": {
        sheetId: 2,
        values: [
          ["Appointment", "24 Mar"],
          ["ALPHA", "PRESENT"],
          ["Manual note", "leave me alone"],
          ["Remarks", ""]
        ]
      }
    });

    const result = await reconcilePendingAttendanceWithSheets(
      fake.client,
      {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: ["Remarks"],
        onboardingSheetTitle: "ONBOARDING",
        attendanceOptions: ["PRESENT", "WFH", "OS"]
      },
      [{
        id: "event-layout",
        appointment: "ALPHA",
        status: "OS",
        date: new Date("2026-03-24T12:00:00.000Z"),
        targetSheetTitle: "Mar 26"
      }],
      { force: true }
    );

    assert.deepEqual(result.writtenEventIds, ["event-layout"]);
    assert.deepEqual(result.conflictedEvents, []);
    assert.deepEqual(fake.getSheetValues("Mar 26").slice(1, 4), [
      ["ALPHA", "OS"],
      ["Manual note", "leave me alone"],
      ["Remarks", ""]
    ]);
  });
});

test("reconciliation fails safely when a managed appointment row has been deleted", async () => {
  await withTempDataDir(async (tempDir) => {
    await writeFile(
      path.join(tempDir, "sheet-cache.json"),
      JSON.stringify({
        updatedAt: "2026-03-24T00:00:00.000Z",
        spreadsheetMetadata: {
          fetchedAt: "2026-03-24T00:00:00.000Z",
          sheetIdsByTitle: { ONBOARDING: 1, "Mar 26": 2 }
        },
        onboardingSlice: null,
        monthSlices: {
          "Mar 26": {
            title: "Mar 26",
            headerRow: ["Appointment", "24 Mar"],
            recognizedDateColumns: { "24": 1 },
            appointments: ["ALPHA", "BRAVO"],
            rowNumbersByAppointment: { ALPHA: 2, BRAVO: 3 },
            managedAreaHash: "baseline",
            fetchedAt: "2026-03-24T00:00:00.000Z",
            snapshot: {
              title: "Mar 26",
              appointments: ["ALPHA", "BRAVO"],
              statusesByDay: { "24": ["PRESENT", "WFH"] },
              synchronizedAt: "2026-03-24T00:00:00.000Z"
            }
          }
        },
        snapshots: {}
      })
    );

    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "CODE1"],
          ["BRAVO", "CODE2"],
          ["Remarks", ""]
        ]
      },
      "Mar 26": {
        sheetId: 2,
        values: [
          ["Appointment", "24 Mar"],
          ["BRAVO", "WFH"],
          ["Remarks", ""]
        ]
      }
    });

    const result = await reconcilePendingAttendanceWithSheets(
      fake.client,
      {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: ["Remarks"],
        onboardingSheetTitle: "ONBOARDING",
        attendanceOptions: ["PRESENT", "WFH", "OS"]
      },
      [{
        id: "event-missing",
        appointment: "ALPHA",
        status: "OS",
        date: new Date("2026-03-24T12:00:00.000Z"),
        targetSheetTitle: "Mar 26"
      }],
      { force: true }
    );

    assert.deepEqual(result.writtenEventIds, []);
    assert.equal(result.conflictedEvents[0].reason, "appointment_missing");
    assert.deepEqual(fake.getSheetValues("Mar 26").slice(1, 3), [
      ["BRAVO", "WFH"],
      ["Remarks", ""]
    ]);
  });
});

test("reconciliation resolves moved rows by appointment identity instead of stale row number", async () => {
  await withTempDataDir(async (tempDir) => {
    await writeFile(
      path.join(tempDir, "sheet-cache.json"),
      JSON.stringify({
        updatedAt: "2026-03-24T00:00:00.000Z",
        spreadsheetMetadata: {
          fetchedAt: "2026-03-24T00:00:00.000Z",
          sheetIdsByTitle: { ONBOARDING: 1, "Mar 26": 2 }
        },
        onboardingSlice: null,
        monthSlices: {
          "Mar 26": {
            title: "Mar 26",
            headerRow: ["Appointment", "24 Mar"],
            recognizedDateColumns: { "24": 1 },
            appointments: ["ALPHA", "BRAVO"],
            rowNumbersByAppointment: { ALPHA: 2, BRAVO: 3 },
            managedAreaHash: "baseline",
            fetchedAt: "2026-03-24T00:00:00.000Z",
            snapshot: {
              title: "Mar 26",
              appointments: ["ALPHA", "BRAVO"],
              statusesByDay: { "24": ["PRESENT", "WFH"] },
              synchronizedAt: "2026-03-24T00:00:00.000Z"
            }
          }
        },
        snapshots: {}
      })
    );

    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "CODE1"],
          ["BRAVO", "CODE2"],
          ["Remarks", ""]
        ]
      },
      "Mar 26": {
        sheetId: 2,
        values: [
          ["Appointment", "24 Mar"],
          ["ALPHA", "PRESENT"],
          ["BRAVO", "WFH"],
          ["Remarks", ""]
        ]
      }
    });
    fake.moveRows("Mar 26", 2, 1, 1);

    const result = await reconcilePendingAttendanceWithSheets(
      fake.client,
      {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: ["Remarks"],
        onboardingSheetTitle: "ONBOARDING",
        attendanceOptions: ["PRESENT", "WFH", "OS"]
      },
      [{
        id: "event-move",
        appointment: "ALPHA",
        status: "OS",
        date: new Date("2026-03-24T12:00:00.000Z"),
        targetSheetTitle: "Mar 26"
      }],
      { force: true }
    );

    assert.deepEqual(result.writtenEventIds, ["event-move"]);
    assert.deepEqual(fake.calls.batchValueUpdates.at(-1), [{
      range: "'Mar 26'!B3",
      values: [["OS"]]
    }]);
    assert.deepEqual(fake.getSheetValues("Mar 26").slice(1, 4), [
      ["BRAVO", "WFH"],
      ["ALPHA", "OS"],
      ["Remarks", ""]
    ]);
  });
});

test("reconciliation fails closed when the live date header no longer matches the expected label", async () => {
  await withTempDataDir(async (tempDir) => {
    await writeFile(
      path.join(tempDir, "sheet-cache.json"),
      JSON.stringify({
        updatedAt: "2026-03-24T00:00:00.000Z",
        spreadsheetMetadata: {
          fetchedAt: "2026-03-24T00:00:00.000Z",
          sheetIdsByTitle: { ONBOARDING: 1, "Mar 26": 2 }
        },
        onboardingSlice: null,
        monthSlices: {
          "Mar 26": {
            title: "Mar 26",
            headerRow: ["Appointment", "24 Mar"],
            recognizedDateColumns: { "24": 1 },
            appointments: ["ALPHA"],
            rowNumbersByAppointment: { ALPHA: 2 },
            managedAreaHash: "baseline",
            fetchedAt: "2026-03-24T00:00:00.000Z",
            snapshot: {
              title: "Mar 26",
              appointments: ["ALPHA"],
              statusesByDay: { "24": ["PRESENT"] },
              synchronizedAt: "2026-03-24T00:00:00.000Z"
            }
          }
        },
        snapshots: {}
      })
    );

    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "CODE"],
          ["Remarks", ""]
        ]
      },
      "Mar 26": {
        sheetId: 2,
        values: [
          ["Appointment", "24-Mar"],
          ["ALPHA", "PRESENT"],
          ["Remarks", ""]
        ]
      }
    });

    const result = await reconcilePendingAttendanceWithSheets(
      fake.client,
      {
        spreadsheetId: "spreadsheet-id",
        timezone: "Asia/Singapore",
        rosterStopMarkers: ["Remarks"],
        onboardingSheetTitle: "ONBOARDING",
        attendanceOptions: ["PRESENT", "WFH", "OS"]
      },
      [{
        id: "event-header",
        appointment: "ALPHA",
        status: "OS",
        date: new Date("2026-03-24T12:00:00.000Z"),
        targetSheetTitle: "Mar 26"
      }],
      { force: true }
    );

    assert.deepEqual(result.writtenEventIds, []);
    assert.equal(result.conflictedEvents[0].reason, "date_column_changed");
    assert.equal(fake.calls.batchValueUpdates.length, 0);
  });
});

test("syncOnboardingRoster reuses one live month snapshot per active sheet refresh", async () => {
  await withTempDataDir(async () => {
    const currentMonthTitle = __testing.getMonthParts(new Date(), "Asia/Singapore").title;
    const nextMonthTitle = __testing.getMonthParts(
      __testing.shiftMonth(new Date(), "Asia/Singapore", 1),
      "Asia/Singapore"
    ).title;
    const fake = createInMemorySheets({
      ONBOARDING: {
        sheetId: 1,
        values: [
          ["Appointment", "Secret Code"],
          ["ALPHA", "A1"],
          ["BRAVO", "B2"]
        ]
      },
      [currentMonthTitle]: {
        sheetId: 2,
        values: [
          ["Appointment", "1"],
          ["ALPHA", "PRESENT"],
          ["BRAVO", "WFH"]
        ]
      },
      [nextMonthTitle]: {
        sheetId: 3,
        values: [
          ["Appointment", "1"],
          ["ALPHA", ""],
          ["BRAVO", ""]
        ]
      }
    });

    await syncOnboardingRoster(fake.client, {
      spreadsheetId: "spreadsheet-1",
      onboardingSheetTitle: "ONBOARDING",
      googleServiceAccountEmail: "bot@example.com",
      timezone: "Asia/Singapore",
      rosterStopMarkers: ["Remarks"],
      attendanceOptions: ["PRESENT", "WFH"]
    }, { persist: false });

    const currentMonthReads = fake.calls.getRanges.filter(
      (range) => range === `'${currentMonthTitle}'!A1:ZZ1000`
    );
    const nextMonthReads = fake.calls.getRanges.filter(
      (range) => range === `'${nextMonthTitle}'!A1:ZZ1000`
    );

    assert.equal(currentMonthReads.length, 1);
    assert.equal(nextMonthReads.length, 1);
    assert.ok(!fake.calls.getRanges.includes(`'${currentMonthTitle}'!A2:A`));
    assert.ok(!fake.calls.getRanges.includes(`'${currentMonthTitle}'!A1:ZZ1`));
    assert.ok(!fake.calls.getRanges.includes(`'${nextMonthTitle}'!A2:A`));
    assert.ok(!fake.calls.getRanges.includes(`'${nextMonthTitle}'!A1:ZZ1`));
  });
});
