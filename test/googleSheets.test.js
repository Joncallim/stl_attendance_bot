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

test("owl stays distinct from comms in canonical ordering", () => {
  const ordered = __testing.orderAppointmentsCanonically([
    "Owl 1",
    "Comms 2",
    "C Owl",
    "CComms",
    "Comms Sup",
    "Owl Sup"
  ]);

  assert.deepEqual(ordered, [
    "CComms",
    "Comms Sup",
    "Comms 2",
    "C Owl",
    "Owl Sup",
    "Owl 1"
  ]);
});

test("department classifier maps officers and specialist departments correctly", () => {
  assert.equal(__testing.classifyAppointmentDepartment("SCSE (OUT)"), "Officers");
  assert.equal(__testing.classifyAppointmentDepartment("OPS 3"), "Officers");
  assert.equal(__testing.classifyAppointmentDepartment("C Owl"), "Owl");
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
      const prevMonthTitle = __testing.getMonthParts(
        __testing.shiftMonth(new Date(), "Asia/Singapore", -1),
        "Asia/Singapore"
      ).title;
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
      assert.equal(result.prevMonthTitle, prevMonthTitle);
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
      // Previous month uses layoutOnly — sheet is created with default header but no appointment rows.
      assert.equal(fake.getSheetValues(prevMonthTitle)[0][0], "Appointment");
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

test("syncOnboardingRoster sorts ONBOARDING into canonical order and propagates it to month sheets", async () => {
  await withMockedFetch([], async () => {
    await withTempDataDir(async () => {
      const currentMonthTitle = __testing.getMonthParts(new Date(), "Asia/Singapore").title;
      // BRAVO appears before ALPHA in the sheet; canonical ordering puts ALPHA first.
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

      // After canonical sort, ALPHA precedes BRAVO (unknown appointments sort alphabetically).
      assert.deepEqual(result.onboardingAppointments, ["ALPHA", "BRAVO"]);
      assert.deepEqual(fake.getSheetValues(currentMonthTitle).slice(1, 3).map((row) => row[0]), [
        "ALPHA",
        "BRAVO"
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
  // randomFn returns 0 so jitter is 0, but the 1500ms floor applies.
  assert.deepEqual(delays, [1500, 1500]);
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

  // The request itself should time out in ~5ms. The semaphore may add up to
  // GOOGLE_SHEETS_INTER_REQUEST_DELAY_MS (1000ms) of queuing before it starts
  // if a previous test left a pending inter-request delay, so allow 3s total —
  // the point is to confirm the timeout fires rather than the call hanging forever.
  assert.ok(Date.now() - startedAt < 3000);
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
            if (request.range.startsWith("'ONBOARDING'!A1:B")) {
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

            if (request.range.startsWith("'Mar 26'!A1:AH")) {
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
      (range) => range.startsWith(`'${currentMonthTitle}'!A1:AH`)
    );
    const nextMonthReads = fake.calls.getRanges.filter(
      (range) => range.startsWith(`'${nextMonthTitle}'!A1:AH`)
    );

    assert.equal(currentMonthReads.length, 1);
    assert.equal(nextMonthReads.length, 1);
    assert.ok(!fake.calls.getRanges.includes(`'${currentMonthTitle}'!A2:A`));
    assert.ok(!fake.calls.getRanges.some((r) => r.startsWith(`'${currentMonthTitle}'!A1:AH`) && r.endsWith("1")));
    assert.ok(!fake.calls.getRanges.includes(`'${nextMonthTitle}'!A2:A`));
    assert.ok(!fake.calls.getRanges.some((r) => r.startsWith(`'${nextMonthTitle}'!A1:AH`) && r.endsWith("1")));
  });
});

// --- reconcileOnboardingWithConfig ---

test("reconcileOnboardingWithConfig: no-op when configuredAppointments is empty", () => {
  const { reconciled, changed } = __testing.reconcileOnboardingWithConfig(
    ["WS 6", "ECS 4", "Chef 2"],
    []
  );
  assert.deepEqual(reconciled, ["WS 6", "ECS 4", "Chef 2"]);
  assert.equal(changed, false);
});

test("reconcileOnboardingWithConfig: reorders matched appointments to yaml order", () => {
  const { reconciled, changed } = __testing.reconcileOnboardingWithConfig(
    ["ECS 4", "WS 6", "CO"],
    ["CO", "WS 6", "ECS 4"]
  );
  assert.deepEqual(reconciled, ["CO", "WS 6", "ECS 4"]);
  assert.equal(changed, true);
});

test("reconcileOnboardingWithConfig: renames appointment to canonical settings.yaml casing", () => {
  const { reconciled, changed } = __testing.reconcileOnboardingWithConfig(
    ["rav", "WS 6"],
    ["Rav", "WS 6"]
  );
  assert.deepEqual(reconciled, ["Rav", "WS 6"]);
  assert.equal(changed, true);
});

test("reconcileOnboardingWithConfig: unmatched appointments go to the bottom (never dropped)", () => {
  const { reconciled, changed } = __testing.reconcileOnboardingWithConfig(
    ["CO", "WS 6", "Unknown Appt", "ECS 4"],
    ["CO", "ECS 4", "WS 6"]
  );
  // "Unknown Appt" is not in settings.yaml; it must be preserved at the bottom.
  assert.ok(reconciled.includes("Unknown Appt"), "unmatched must be kept");
  assert.deepEqual(reconciled.slice(0, 3), ["CO", "ECS 4", "WS 6"]);
  assert.equal(reconciled[3], "Unknown Appt");
  assert.equal(changed, true);
});

test("reconcileOnboardingWithConfig: no change when already consistent", () => {
  const { reconciled, changed } = __testing.reconcileOnboardingWithConfig(
    ["CO", "WS 6", "ECS 4"],
    ["CO", "WS 6", "ECS 4"]
  );
  assert.deepEqual(reconciled, ["CO", "WS 6", "ECS 4"]);
  assert.equal(changed, false);
});

test("reconcileOnboardingWithConfig: configured appointments not in ONBOARDING are excluded", () => {
  const { reconciled } = __testing.reconcileOnboardingWithConfig(
    ["WS 6", "ECS 4"],
    ["CO", "WS 6", "ECS 4", "XO"] // CO and XO not in ONBOARDING
  );
  assert.deepEqual(reconciled, ["WS 6", "ECS 4"]);
});

// --- reconcileOnboardingWithConfig with officer type patterns ---

function makePatterns(...prefixes) {
  return prefixes.map((prefix) => ({
    prefix: prefix.toUpperCase(),
    pattern: new RegExp(`^${prefix.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s+\\d+)?$`)
  }));
}

test("reconcileOnboardingWithConfig: officer type pattern keeps unlisted numbered variant", () => {
  // OPS 1 is explicit; OPS 2 only exists in ONBOARDING — should be kept via pattern.
  const { reconciled, changed } = __testing.reconcileOnboardingWithConfig(
    ["CO", "OPS 1", "OPS 2"],
    ["CO", "OPS 1"],
    makePatterns("OPS")
  );
  // Canonical order: CO (top-block 0), OPS 1 (top-block 2, number 1), OPS 2 (top-block 2, number 2)
  assert.deepEqual(reconciled, ["CO", "OPS 1", "OPS 2"]);
  assert.equal(changed, false); // order and count already correct
});

test("reconcileOnboardingWithConfig: officer type pattern keeps bare prefix (no number)", () => {
  const { reconciled, changed } = __testing.reconcileOnboardingWithConfig(
    ["CO", "AOPS", "OPS 1"],
    ["CO", "OPS 1"],
    makePatterns("OPS", "AOPS")
  );
  // Canonical order: CO (0), OPS 1 (OPS bucket, number 1), AOPS (AOPS bucket)
  assert.ok(reconciled.includes("AOPS"), "AOPS must be kept via pattern");
  assert.ok(reconciled.includes("CO"), "CO must be kept (explicit)");
  assert.ok(reconciled.includes("OPS 1"), "OPS 1 must be kept (explicit)");
  assert.equal(reconciled.length, 3);
  assert.equal(changed, true); // AOPS was added to the list
});

test("reconcileOnboardingWithConfig: non-officer unmatched appointment goes to bottom with patterns active", () => {
  const { reconciled } = __testing.reconcileOnboardingWithConfig(
    ["CO", "OPS 1", "ECS UNKNOWN", "OPS 2"],
    ["CO", "OPS 1"],
    makePatterns("OPS")
  );
  // "ECS UNKNOWN" does not match OPS pattern → kept but placed at bottom
  assert.ok(reconciled.includes("ECS UNKNOWN"), "ECS UNKNOWN must be kept (never dropped)");
  assert.ok(reconciled.includes("OPS 2"), "OPS 2 must be kept via pattern");
  // ECS UNKNOWN must come after pattern-matched OPS 2
  assert.ok(reconciled.indexOf("ECS UNKNOWN") > reconciled.indexOf("OPS 2"), "ECS UNKNOWN after pattern-matched");
});

test("reconcileOnboardingWithConfig: duplicate pattern-matched entry is de-duplicated", () => {
  const { reconciled } = __testing.reconcileOnboardingWithConfig(
    ["CO", "OPS 1", "OPS 1", "OPS 2"], // OPS 1 duplicated
    ["CO"],
    makePatterns("OPS")
  );
  const ops1Count = reconciled.filter((a) => a.toUpperCase() === "OPS 1").length;
  assert.equal(ops1Count, 1, "OPS 1 must appear only once");
});

test("reconcileOnboardingWithConfig: officer type pattern is case-insensitive", () => {
  const { reconciled } = __testing.reconcileOnboardingWithConfig(
    ["CO", "ops 2"], // lowercase in sheet
    ["CO"],
    makePatterns("OPS")
  );
  assert.ok(reconciled.includes("ops 2"), "lowercase ops 2 must be kept");
});

test("reconcileOnboardingWithConfig: no patterns — unmatched kept at bottom", () => {
  // Without patterns, non-explicit appointments must be preserved at the bottom.
  const { reconciled } = __testing.reconcileOnboardingWithConfig(
    ["CO", "OPS 2"],
    ["CO"],
    [] // no patterns
  );
  assert.ok(reconciled.includes("CO"), "CO must be kept (explicit)");
  assert.ok(reconciled.includes("OPS 2"), "OPS 2 must be kept at bottom (never dropped)");
  assert.equal(reconciled[0], "CO");
});

// --- sortWithConfig ---

function makeConfig({ yamlOrder = [], officerPatterns = [], hierarchy = [] } = {}) {
  const appointmentOrderIndex = new Map(
    yamlOrder.map(([name, idx]) => [name.toUpperCase(), idx])
  );
  const officerAppointmentTypePatterns = officerPatterns.map((prefix) => ({
    prefix: prefix.toUpperCase(),
    pattern: new RegExp(`^${prefix.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s+\\d+)?$`)
  }));
  return { appointmentOrderIndex, officerAppointmentTypePatterns, hierarchy };
}

test("sortWithConfig: explicitly configured appointments follow yaml order", () => {
  const config = makeConfig({ yamlOrder: [["CO", 0], ["AOPS", 1], ["OPS 1", 2]] });
  const sorted = __testing.sortWithConfig(["OPS 1", "CO", "AOPS"], config);
  assert.deepEqual(sorted, ["CO", "AOPS", "OPS 1"]);
});

test("sortWithConfig: pattern-matched variants slot after last explicit of their type", () => {
  // yaml: CO(0), OPS 1(1) — OPS 2 is pattern-matched
  const config = makeConfig({
    yamlOrder: [["CO", 0], ["OPS 1", 1]],
    officerPatterns: ["OPS"]
  });
  const sorted = __testing.sortWithConfig(["OPS 2", "CO", "OPS 1"], config);
  assert.deepEqual(sorted, ["CO", "OPS 1", "OPS 2"]);
});

test("sortWithConfig: unmatched appointments go after configured+pattern entries", () => {
  const config = makeConfig({
    yamlOrder: [["CO", 0]],
    officerPatterns: ["OPS"],
    hierarchy: [{ label: "Officers", order: 0 }, { label: "WS", order: 1 }]
  });
  const sorted = __testing.sortWithConfig(["WS 1", "CO", "OPS 2", "UNKNOWN"], config);
  assert.equal(sorted[0], "CO", "CO first (yaml explicit)");
  assert.equal(sorted[1], "OPS 2", "OPS 2 second (pattern-matched)");
  // WS 1 and UNKNOWN are unmatched; they follow the configured entries
  assert.ok(sorted.indexOf("WS 1") > sorted.indexOf("OPS 2"), "WS 1 after OPS 2");
  assert.ok(sorted.indexOf("UNKNOWN") >= 0, "UNKNOWN is kept");
});

test("sortWithConfig: stable when config is null — falls back to canonical order", () => {
  // sortWithConfig(appointments, null) must not throw and must return a sorted array.
  const sorted = __testing.sortWithConfig(["ECS 1", "CO", "XO"], null);
  assert.ok(Array.isArray(sorted) && sorted.length === 3, "returns array of same length");
  assert.equal(sorted[0], "CO", "CO first in canonical order");
});

test("sortWithConfig: pattern-matched officers without yaml entries sort after all key officers", () => {
  // yaml: CO(0) … ME(14). ASE/ANO/YO have no yaml entries.
  // They must sort AFTER ME, not before it.
  const config = makeConfig({
    yamlOrder: [
      ["CO", 0], ["XO", 1], ["COXN", 2],
      ["OPS 1", 3], ["OPS 2", 4], ["OPS 3", 5], ["OPS 4", 6], ["OPS 5", 7],
      ["NO", 8], ["AOPS 1", 9], ["AOPS 2", 10], ["AOPS 3", 11],
      ["SME", 12], ["SCSE", 13], ["ME", 14]
    ],
    officerPatterns: ["OPS", "AOPS", "SME", "SCSE", "ME", "ASE", "ANO", "YO"]
  });
  const sorted = __testing.sortWithConfig(["ASE 1", "ME", "ANO", "YO 2"], config);
  assert.equal(sorted[0], "ME", "ME (last explicit) sorts before pattern-only entries");
  assert.ok(sorted.indexOf("ASE 1") > sorted.indexOf("ME"), "ASE 1 after ME");
  assert.ok(sorted.indexOf("ANO") > sorted.indexOf("ME"), "ANO after ME");
  assert.ok(sorted.indexOf("YO 2") > sorted.indexOf("ME"), "YO 2 after ME");
  // Family ordering within "other officers": ASE(9) < ANO(10) < YO(11)
  assert.ok(sorted.indexOf("ASE 1") < sorted.indexOf("ANO"), "ASE before ANO");
  assert.ok(sorted.indexOf("ANO") < sorted.indexOf("YO 2"), "ANO before YO");
});

// --- department appointment parsing (compact forms, PO role, chief variants) ---

test("department parsing: compact forms without spaces are recognised", () => {
  const ordered = __testing.orderAppointmentsCanonically([
    "WSOJT1",   // WS OJT 1
    "WSPO1",    // WS PO 1
    "C2WPL1",   // C2 WPL 1
    "MSSUP1",   // MS Sup 1
    "WS 2",     // WS Seat 2 (spaced)
    "CWS",      // Chief WS
    "C2 1"      // C2 Seat 1
  ]);
  // Dept order: C2(0) < WS(1) < MS(8).
  // Within WS: CHIEF(0) < PO(2) < SEAT(3) < OJT(5).
  // Within C2: SEAT(3) < WPL(4).
  // Expected full order: C2 1, C2WPL1, CWS, WSPO1, WS 2, WSOJT1, MSSUP1
  assert.deepEqual(ordered, ["C2 1", "C2WPL1", "CWS", "WSPO1", "WS 2", "WSOJT1", "MSSUP1"]);

  // Also verify relative within each department:
  const wsPoIdx  = ordered.indexOf("WSPO1");
  const ws2Idx   = ordered.indexOf("WS 2");
  const wsOjtIdx = ordered.indexOf("WSOJT1");
  assert.ok(wsPoIdx < ws2Idx,   "WS PO (roleOrder 2) before WS Seat (roleOrder 3)");
  assert.ok(ws2Idx < wsOjtIdx,  "WS Seat (roleOrder 3) before WS OJT (roleOrder 5)");

  const c2WplIdx = ordered.indexOf("C2WPL1");
  const c21Idx   = ordered.indexOf("C2 1");
  assert.ok(c21Idx < c2WplIdx,  "C2 Seat (roleOrder 3) before C2 WPL (roleOrder 4)");

  // MSSUP1 belongs to MS (dept order 8), so it sorts after C2 (order 0) and WS (order 1)
  assert.ok(ordered.indexOf("MSSUP1") > ordered.indexOf("WS 2"), "MS Sup after WS entries");
});

test("department parsing: S abbreviation for supervisor is recognized", () => {
  const ordered = __testing.orderAppointmentsCanonically([
    "ECS S1",   // ECS Sup 1 (spaced with S)
    "ECSS1",    // ECS Sup 1 (compact)
    "ECS 1",    // ECS Seat 1
    "CECS"      // Chief ECS
  ]);
  assert.equal(ordered[0], "CECS",  "CECS is chief");
  assert.equal(ordered[1], "ECS S1",  "ECS S1 is SUP (roleOrder 1)");
  assert.equal(ordered[2], "ECSS1",   "ECSS1 is also SUP (roleOrder 1), same number → stable");
  assert.equal(ordered[3], "ECS 1",  "ECS Seat (roleOrder 3) after SUP");
});

test("department parsing: chief pattern recognises C-space-LABEL and CHIEF-space-LABEL", () => {
  const meta = (appt) => __testing.parseAppointmentOrderingMetadata(appt, 0);

  const cwsChief  = meta("C WS");
  const chiefWS   = meta("Chief WS");
  const cws       = meta("CWS");
  assert.equal(cwsChief.family,  "WS:CHIEF", "C WS → WS:CHIEF");
  assert.equal(chiefWS.family,   "WS:CHIEF", "Chief WS → WS:CHIEF");
  assert.equal(cws.family,       "WS:CHIEF", "CWS → WS:CHIEF");
  assert.equal(cwsChief.roleOrder, 0, "chief has roleOrder 0");

  const cecsChief = meta("C ECS");
  assert.equal(cecsChief.family, "ECS:CHIEF", "C ECS → ECS:CHIEF");

  const chiefRav = meta("Chief Rav");
  assert.equal(chiefRav.family, "RAV:CHIEF",
    "Chief Rav → RAV:CHIEF");
});

test("department parsing: PO role slots between SUP and SEAT", () => {
  const ordered = __testing.orderAppointmentsCanonically([
    "WS PO 2",   // WS PO 2
    "WS Sup 1",  // WS Sup
    "WS 3",      // WS Seat
    "WS PO 1",   // WS PO 1
    "C WS"       // Chief
  ]);
  assert.deepEqual(ordered, [
    "C WS",
    "WS Sup 1",
    "WS PO 1",
    "WS PO 2",
    "WS 3"
  ]);
});

test("canonical ordering: departments fully clustered, role order within each dept", () => {
  // Validates the primary sort invariant: all entries for each department appear
  // together (clustered), with internal role order Chief→Sup→PO→Seat→WPL→OJT→Other.
  const ordered = __testing.orderAppointmentsCanonically([
    "Chef 1",
    "ECS OJT",
    "ECS WPL 2",
    "ECS WPL 1",
    "ECS 2",
    "ECS 1",
    "ECS S2",
    "ECS S1",
    "CECS",
    "C Chef",
  ]);
  assert.deepEqual(ordered, [
    "CECS",
    "ECS S1",
    "ECS S2",
    "ECS 1",
    "ECS 2",
    "ECS WPL 1",
    "ECS WPL 2",
    "ECS OJT",
    "C Chef",
    "Chef 1"
  ]);
});

test("canonical ordering: officers cluster before all departments", () => {
  const ordered = __testing.orderAppointmentsCanonically([
    "ECS 1",
    "XO",
    "CECS",
    "CO",
    "OPS 2",
    "C2 1"
  ]);
  // All officers first (CO, XO, OPS), then C2 (dept order 0), then ECS (dept order 9).
  assert.deepEqual(ordered, ["CO", "XO", "OPS 2", "C2 1", "CECS", "ECS 1"]);
});

test("sortWithConfig: departments cluster by dept first, then role within dept", () => {
  // Reproduces the role-first bug: when config.hierarchy nodes lack an `order` field,
  // all dept buckets collapse to 0 and entries sort by roleOrder across all depts.
  // After the fix (hierarchy nodes carry `order`), each dept gets its own bucket.
  const config = {
    appointmentOrderIndex: new Map([
      ["CO", 0],
      ["XO", 1]
    ]),
    officerAppointmentTypePatterns: [],
    hierarchy: [
      { key: "OFFICERS", label: "Officers", order: 0 },
      { key: "C2",       label: "C2",       order: 1 },
      { key: "WS",       label: "WS",       order: 2 },
      { key: "ECS",      label: "ECS",      order: 10 }
    ]
  };

  // Unmatched dept entries: chiefs across C2, WS, ECS; seats across C2, WS, ECS.
  // Dept-first order: all C2 together, then all WS, then all ECS.
  // Role-first (buggy) order: all chiefs, then all seats (interleaved across depts).
  const sorted = __testing.sortWithConfig(
    ["CWS", "ECS 1", "CECS", "WS 1", "C2 1", "CC2"],
    config
  );
  // Expect: C2 cluster (CC2, C2 1) → WS cluster (CWS, WS 1) → ECS cluster (CECS, ECS 1)
  assert.deepEqual(sorted, ["CC2", "C2 1", "CWS", "WS 1", "CECS", "ECS 1"]);
});

