import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWeeklyAttendanceSelection,
  createWeeklyFlowState,
  getStagedAttendanceStatus,
  resolveWeeklyAttendanceEntries,
  upsertWeeklyAttendanceEntry
} from "../src/weeklyFlow.js";

test("weekly flow stores and overwrites staged entries by date", () => {
  const toIsoDateString = (value) => value.toISOString().slice(0, 10);
  const firstEntries = upsertWeeklyAttendanceEntry([], "2026-03-23", "PRESENT", toIsoDateString);
  const secondEntries = upsertWeeklyAttendanceEntry(firstEntries, "2026-03-23", "WFH", toIsoDateString);

  assert.equal(secondEntries.length, 1);
  assert.equal(
    getStagedAttendanceStatus(secondEntries, "2026-03-23", toIsoDateString),
    "WFH"
  );
});

test("weekly flow normalizes timestamp date strings to their attendance date", () => {
  const toIsoDateString = (value) => value.toISOString().slice(0, 10);
  const entries = [{ date: "2026-03-23", status: "PRESENT" }];

  assert.equal(
    getStagedAttendanceStatus(
      entries,
      "2026-03-23T12:00:00.000Z",
      toIsoDateString
    ),
    "PRESENT"
  );
});

test("weekly submission resolves one recorded response for every weekday", () => {
  const weeklyDates = [
    "2026-03-23T12:00:00.000Z",
    "2026-03-24T12:00:00.000Z",
    "2026-03-25T12:00:00.000Z",
    "2026-03-26T12:00:00.000Z",
    "2026-03-27T12:00:00.000Z"
  ];
  const stagedEntries = [
    { date: "2026-03-23", status: "PRESENT" },
    { date: "2026-03-25", status: "WFH" },
    { date: "2026-03-27", status: "DUTY" }
  ];
  const existingByDate = new Map([
    ["2026-03-24", "MC"],
    ["2026-03-26", "PH"]
  ]);
  const toIsoDateString = (value) => value.toISOString().slice(0, 10);

  assert.deepEqual(
    resolveWeeklyAttendanceEntries(
      weeklyDates,
      stagedEntries,
      (_date, isoDate) => existingByDate.get(isoDate) ?? "",
      toIsoDateString
    ),
    [
      { date: "2026-03-23", status: "PRESENT" },
      { date: "2026-03-24", status: "MC" },
      { date: "2026-03-25", status: "WFH" },
      { date: "2026-03-26", status: "PH" },
      { date: "2026-03-27", status: "DUTY" }
    ]
  );
});

test("weekly submission exposes missing weekdays instead of dropping them", () => {
  const toIsoDateString = (value) => value.toISOString().slice(0, 10);
  const resolved = resolveWeeklyAttendanceEntries(
    [
      "2026-03-23T12:00:00.000Z",
      "2026-03-24T12:00:00.000Z"
    ],
    [{ date: "2026-03-23", status: "PRESENT" }],
    () => "",
    toIsoDateString
  );

  assert.deepEqual(resolved, [
    { date: "2026-03-23", status: "PRESENT" },
    { date: "2026-03-24", status: "" }
  ]);
});

test("weekly flow skip keeps current status and completes on final day", () => {
  const state = createWeeklyFlowState(["2026-03-23", "2026-03-24"]);
  const nextState = applyWeeklyAttendanceSelection(
    {
      ...state,
      weeklyAttendanceIndex: 1,
      weeklyAttendanceResults: ["Mon 23 Mar: PRESENT"],
      weeklyAttendanceEntries: [{ date: "2026-03-23", status: "PRESENT" }]
    },
    {
      action: "skip",
      dateValue: "2026-03-24",
      currentStatus: "PH",
      pickedStatus: null,
      formatWeekDateLabel: () => "Tue 24 Mar"
    }
  );

  assert.equal(nextState.awaitingWeeklyAttendance, false);
  assert.deepEqual(nextState.weeklyAttendanceResults, [
    "Mon 23 Mar: PRESENT",
    "Tue 24 Mar: PH"
  ]);
});
