import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  __testing,
  preloadAttendanceSnapshots,
  reconcilePendingAttendanceWithSheets,
  syncOnboardingRoster
} from "../src/googleSheets.js";

// Issue #21 and inline write verification. Uses the same in-memory sheet model
// as googleSheets.test.js, with a values.batchGet layered on top.
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

const TIMEZONE = "Asia/Singapore";
const config = {
  spreadsheetId: "spreadsheet-id",
  timezone: TIMEZONE,
  rosterStopMarkers: ["Remarks"],
  onboardingSheetTitle: "ONBOARDING",
  attendanceOptions: ["PRESENT", "WFH", "OS"]
};

async function withEnvironment(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "attendance-batched-reads-"));
  const originalFetch = globalThis.fetch;
  process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;
  globalThis.fetch = async () => ({ ok: true, json: async () => [] });

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ATTENDANCE_BOT_DATA_DIR;
    await rm(tempDir, { recursive: true, force: true });
  }
}

function addBatchGet(fake) {
  const batchGets = [];
  fake.client.spreadsheets.values.batchGet = async ({ ranges }) => {
    batchGets.push([...ranges]);
    const valueRanges = [];
    for (const range of ranges) {
      const response = await fake.client.spreadsheets.values.get({ range });
      valueRanges.push({ range, values: response.data.values });
    }
    return { data: { valueRanges } };
  };
  return batchGets;
}

function monthTitle(offset) {
  return __testing.getMonthParts(__testing.shiftMonth(new Date(), TIMEZONE, offset), TIMEZONE).title;
}

test("preloadAttendanceSnapshots reads all three months in one batchGet and matches the sequential result", async () => {
  await withEnvironment(async () => {
    const sequentialFake = createInMemorySheets();
    await syncOnboardingRoster(sequentialFake.client, config);
    const sequential = await preloadAttendanceSnapshots(sequentialFake.client, config, { force: true });

    const batchedFake = createInMemorySheets();
    await syncOnboardingRoster(batchedFake.client, config);
    const batchGets = addBatchGet(batchedFake);
    const getsBefore = batchedFake.calls.getRanges.length;
    const batched = await preloadAttendanceSnapshots(batchedFake.client, config, { force: true });

    const monthBatches = batchGets.filter((ranges) => ranges.length === 3);
    assert.equal(monthBatches.length, 1, "expected exactly one 3-range batchGet");
    assert.deepEqual(
      monthBatches[0].map((range) => range.match(/^'(.+)'!/)[1]),
      [monthTitle(-1), monthTitle(0), monthTitle(1)]
    );
    // The only direct values.get calls are the ones the batchGet shim made itself.
    assert.equal(batchedFake.calls.getRanges.length - getsBefore, 3);
    assert.deepEqual([...batched.snapshots.keys()], [...sequential.snapshots.keys()]);
    for (const [title, snapshot] of sequential.snapshots) {
      assert.deepEqual(batched.snapshots.get(title).appointments, snapshot.appointments);
    }
  });
});

test("reconcilePendingAttendanceWithSheets reads a cross-month batch with a single slice batchGet (issue #21)", async () => {
  await withEnvironment(async () => {
    const fake = createInMemorySheets();
    await syncOnboardingRoster(fake.client, config);
    const batchGets = addBatchGet(fake);
    const currentMonthDate = new Date();
    const nextMonthDate = __testing.shiftMonth(new Date(), TIMEZONE, 1);

    const result = await reconcilePendingAttendanceWithSheets(fake.client, config, [
      { id: "e1", appointment: "USER1", status: "WFH", date: currentMonthDate, targetSheetTitle: monthTitle(0) },
      { id: "e2", appointment: "USER1", status: "OS", date: nextMonthDate, targetSheetTitle: monthTitle(1) }
    ], { force: true });

    const sliceBatches = batchGets.filter((ranges) =>
      ranges.every((range) => /!A1:AH\d+$/.test(range))
    );
    assert.equal(sliceBatches.length, 1, "month slices should be fetched in one batchGet");
    assert.deepEqual(
      sliceBatches[0].map((range) => range.match(/^'(.+)'!/)[1]),
      [monthTitle(0), monthTitle(1)]
    );
    assert.deepEqual([...result.writtenEventIds].sort(), ["e1", "e2"]);
  });
});

test("refreshMonthSlices falls back to per-sheet reads for structural refreshes", async () => {
  await withEnvironment(async () => {
    const fake = createInMemorySheets();
    await syncOnboardingRoster(fake.client, config);
    const batchGets = addBatchGet(fake);

    const slices = await __testing.refreshMonthSlices(
      fake.client,
      config,
      [monthTitle(0), monthTitle(1)],
      { force: true, structural: true, persist: false }
    );

    assert.equal(batchGets.filter((ranges) => ranges.length === 2).length, 0);
    assert.deepEqual([...slices.keys()], [monthTitle(0), monthTitle(1)]);
  });
});

test("verifyBatchWrite checks Google's updatedData without another API call", () => {
  const writes = [
    { range: "'Nov 26'!C2", values: [["WFH"]] },
    { range: "'Nov 26'!D3", values: [["OS"]] }
  ];
  const warnings = [];
  const logFn = (message) => warnings.push(message);

  const ok = __testing.verifyBatchWrite({
    data: { responses: [
      { updatedData: { values: [["WFH"]] } },
      { updatedData: { values: [["OS"]] } }
    ] }
  }, writes, { enabled: true, logFn });
  assert.equal(ok.ok, true);

  const mismatch = __testing.verifyBatchWrite({
    data: { responses: [
      { updatedData: { values: [["WFH"]] } },
      { updatedData: { values: [["PRESENT"]] } }
    ] }
  }, writes, { enabled: true, logFn });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.discrepancies.length, 1);
  assert.match(warnings.at(-1), /VERIFY MISMATCH/);

  const missing = __testing.verifyBatchWrite({ data: {} }, writes, { enabled: true, logFn });
  assert.equal(missing.ok, false);
  assert.equal(missing.skipped, true);

  assert.deepEqual(__testing.verifyBatchWrite(undefined, writes, { enabled: false }), { ok: true, discrepancies: [] });
});

test("verifyWriteRequestFields only asks Google for values when verification is on", () => {
  assert.deepEqual(__testing.verifyWriteRequestFields(false), {});
  assert.deepEqual(__testing.verifyWriteRequestFields(true), {
    includeValuesInResponse: true,
    responseValueRenderOption: "FORMATTED_VALUE"
  });
});
