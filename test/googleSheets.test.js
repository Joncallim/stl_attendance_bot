import test from "node:test";
import assert from "node:assert/strict";
import { __testing } from "../src/googleSheets.js";

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

test("monthly managed-row writes preserve rows below Remarks and stay batched", async () => {
  const fake = createFakeSheets(["ALPHA", "Remarks", "Manual note"]);

  await __testing.writeMonthlySheetRows(
    fake.client,
    "spreadsheet-id",
    123,
    "Mar 26",
    3,
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

test("managed area grows by inserting a row instead of clearing and rewriting the block", async () => {
  const fake = createFakeSheets(["ALPHA", "Remarks", "Manual note"]);

  await __testing.writeMonthlySheetRows(
    fake.client,
    "spreadsheet-id",
    123,
    "Mar 26",
    3,
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
