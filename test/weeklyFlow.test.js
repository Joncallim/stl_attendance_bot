import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWeeklyAttendanceSelection,
  createWeeklyFlowState,
  getStagedAttendanceStatus,
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
