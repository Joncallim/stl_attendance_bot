import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { __testing, reconcilePendingAttendanceWithSheets } from "../src/googleSheets.js";

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

  assert.deepEqual(result.nextAppointments, ["BRAVO", "ALPHA", "CHARLIE"]);
  assert.deepEqual(result.nextRows, [
    ["BRAVO", "", ""],
    ["ALPHA", "PRESENT", ""],
    ["CHARLIE", "WFH", ""]
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
  assert.equal(parsed.hadInlineStopMarkerDrift, false);
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
