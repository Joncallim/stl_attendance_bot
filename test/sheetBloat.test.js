import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

// Sheet bloat and growth regressions:
// - conditional-format rules must not stack on every layout run
// - routine metadata must not request rules/protections
// - sheet-cache.json must not keep every month forever
// - no-op queue events must be compactable
const tempDir = await mkdtemp(path.join(os.tmpdir(), "attendance-bloat-"));
process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;
await writeFile(
  path.join(tempDir, "conditional-format-rules.json"),
  JSON.stringify({
    rules: [
      { booleanRule: { condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "MC" }] }, format: {} } },
      { booleanRule: { condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "OS" }] }, format: {} } }
    ]
  })
);
globalThis.fetch = async () => ({ ok: true, json: async () => [] });

const { __testing, syncOnboardingRoster } = await import("../src/googleSheets.js");
const {
  compactAttendanceQueue,
  enqueueAttendanceEvent,
  flushAttendanceQueue,
  loadAttendanceQueueState
} = await import("../src/attendanceQueue.js");

test.after(async () => {
  delete process.env.ATTENDANCE_BOT_DATA_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

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
  attendanceOptions: ["PRESENT", "WFH", "OS", "MC"]
};

// Adds conditional-format state to the in-memory model and records every
// spreadsheets.get field mask so tests can see what each call asked for.
function withConditionalFormats(fake) {
  const rulesBySheetId = new Map();
  const getFields = [];
  const originalGet = fake.client.spreadsheets.get;
  const originalBatchUpdate = fake.client.spreadsheets.batchUpdate;

  fake.client.spreadsheets.get = async (request) => {
    getFields.push(request?.fields ?? "");
    const response = await originalGet(request);
    for (const sheet of response.data.sheets) {
      sheet.conditionalFormats = (rulesBySheetId.get(sheet.properties.sheetId) ?? []).map((rule) => ({ ...rule }));
    }
    return response;
  };

  fake.client.spreadsheets.batchUpdate = async (request) => {
    for (const operation of request.requestBody.requests ?? []) {
      if (operation.deleteConditionalFormatRule) {
        const { sheetId, index } = operation.deleteConditionalFormatRule;
        const rules = rulesBySheetId.get(sheetId) ?? [];
        assert.ok(index < rules.length, `delete index ${index} out of range (${rules.length})`);
        rules.splice(index, 1);
        rulesBySheetId.set(sheetId, rules);
      }
      if (operation.addConditionalFormatRule) {
        const { rule, index = 0 } = operation.addConditionalFormatRule;
        const sheetId = rule.ranges[0].sheetId;
        const rules = rulesBySheetId.get(sheetId) ?? [];
        rules.splice(index, 0, rule);
        rulesBySheetId.set(sheetId, rules);
      }
    }
    return originalBatchUpdate(request);
  };

  return { rulesBySheetId, getFields };
}

function monthTitle(offset) {
  return __testing.getMonthParts(__testing.shiftMonth(new Date(), TIMEZONE, offset), TIMEZONE).title;
}

test("repeated structural syncs keep exactly one copy of each bot conditional-format rule", async () => {
  const fake = createInMemorySheets();
  const { rulesBySheetId } = withConditionalFormats(fake);

  await syncOnboardingRoster(fake.client, config);
  const currentSheetId = (await fake.client.spreadsheets.get({})).data.sheets
    .find((sheet) => sheet.properties.title === monthTitle(0)).properties.sheetId;

  // A rule a person added on column A must survive bot maintenance.
  const humanRule = {
    ranges: [{ sheetId: currentSheetId, startRowIndex: 0, startColumnIndex: 0, endRowIndex: 50, endColumnIndex: 1 }],
    booleanRule: { condition: { type: "NOT_BLANK" }, format: {} }
  };
  rulesBySheetId.get(currentSheetId).push(humanRule);

  for (let run = 0; run < 3; run += 1) {
    await syncOnboardingRoster(fake.client, config);
  }

  for (const [sheetId, rules] of rulesBySheetId) {
    const botRules = rules.filter((rule) => __testing.isBotManagedConditionalFormat(rule, sheetId));
    assert.equal(botRules.length, 2, `sheet ${sheetId} has ${botRules.length} bot rules after 4 syncs`);
  }
  assert.ok(rulesBySheetId.get(currentSheetId).includes(humanRule), "human rule was deleted");
});

test("routine spreadsheet metadata requests properties only", async () => {
  const fake = createInMemorySheets();
  const { getFields } = withConditionalFormats(fake);

  await syncOnboardingRoster(fake.client, config);

  const routine = getFields.filter((fields) => fields.startsWith("spreadsheetId,"));
  assert.ok(routine.length >= 1, "expected at least one routine metadata call");
  for (const fields of routine) {
    assert.doesNotMatch(fields, /conditionalFormats|protectedRanges/);
  }
});

test("isBotManagedConditionalFormat only matches single-range rules anchored at B2", () => {
  const bot = { ranges: [{ sheetId: 7, startRowIndex: 1, startColumnIndex: 1, endRowIndex: 40, endColumnIndex: 32 }] };
  assert.equal(__testing.isBotManagedConditionalFormat(bot, 7), true);
  assert.equal(__testing.isBotManagedConditionalFormat(bot, 8), false);
  assert.equal(__testing.isBotManagedConditionalFormat({ ranges: [{ sheetId: 7 }] }, 7), false);
  assert.equal(__testing.isBotManagedConditionalFormat({ ranges: [bot.ranges[0], bot.ranges[0]] }, 7), false);
  // The API omits zero-valued fields, including sheetId 0.
  assert.equal(__testing.isBotManagedConditionalFormat({ ranges: [{ startRowIndex: 1, startColumnIndex: 1 }] }, 0), true);
});

test("pruneLocalSheetCacheMonths keeps the recent window and drops older months", () => {
  const now = new Date();
  const titles = [-8, -4, -3, -2, -1, 0, 1, 2].map((offset) => monthTitle(offset));
  const cache = {
    monthSlices: Object.fromEntries(titles.map((title) => [title, {}])),
    snapshots: Object.fromEntries(titles.map((title) => [title, {}]))
  };
  cache.monthSlices.ONBOARDING = {};

  const removed = __testing.pruneLocalSheetCacheMonths(cache, now, TIMEZONE);

  const expected = [-3, -2, -1, 0, 1].map((offset) => monthTitle(offset));
  assert.deepEqual(Object.keys(cache.snapshots).sort(), [...expected].sort());
  assert.deepEqual(Object.keys(cache.monthSlices).sort(), [...expected, "ONBOARDING"].sort());
  assert.equal(removed, 6);
});

test("compactAttendanceQueue removes no-op (skipped_noop) events, not just flushed ones", async () => {
  const queueConfig = { timezone: TIMEZONE };
  const date = new Date("2026-03-24T00:00:00.000Z");
  await enqueueAttendanceEvent(queueConfig, { appointment: "ALPHA", status: "WFH", date, source: "daily" });
  await enqueueAttendanceEvent(queueConfig, { appointment: "BRAVO", status: "OS", date, source: "daily" });

  await flushAttendanceQueue(async (entries) => {
    const alpha = entries.find((entry) => entry.appointment === "ALPHA");
    const bravo = entries.find((entry) => entry.appointment === "BRAVO");
    return {
      writtenEventIds: [alpha.id],
      skippedEvents: [{ eventId: bravo.id, reason: "noop" }],
      conflictedEvents: []
    };
  });

  const before = await loadAttendanceQueueState();
  assert.deepEqual(
    [...before.events.values()].map((event) => event.queueStatus).sort(),
    ["flushed", "skipped_noop"]
  );

  const result = await compactAttendanceQueue();
  assert.equal(result.compacted, true);
  const after = await loadAttendanceQueueState();
  assert.equal(after.events.size, 0);
  assert.equal(after.records.length, 0);
});
