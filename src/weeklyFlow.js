/*
 * Weekly attendance is kept as a small, pure state machine so Telegram UI code
 * does not own the business rules. Nothing in this module performs I/O.
 *
 * `weeklyAttendanceEntries` contains only choices made during the current flow.
 * Existing sheet values are consulted later by `resolveWeeklyAttendanceEntries`.
 * A staged choice always wins over an existing value for the same date.
 *
 * Keeping dates as YYYY-MM-DD strings is important: a workweek may cross a
 * month or year boundary, and row/column positions in Sheets are not identities.
 */

function normalizeWeeklyDate(date, toIsoDateString) {
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return date;
  }

  return toIsoDateString(date instanceof Date ? date : new Date(date));
}

/** Return the most recent staged value for a date, if the user changed it. */
export function getStagedAttendanceStatus(entries, date, toIsoDateString) {
  const isoDate = normalizeWeeklyDate(date, toIsoDateString);
  const entry = [...entries].reverse().find((value) => value.date === isoDate);
  return entry?.status ?? "";
}

/**
 * Replace the staged value for one date without mutating the caller's array.
 * There should be only one effective staged value per date when the flow is
 * finally resolved.
 */
export function upsertWeeklyAttendanceEntry(entries, date, status, toIsoDateString) {
  const isoDate = normalizeWeeklyDate(date, toIsoDateString);
  const nextEntries = entries.filter((entry) => entry.date !== isoDate);
  nextEntries.push({ date: isoDate, status });
  return nextEntries;
}

/**
 * Produce the final per-day values shown/submitted by the weekly flow.
 * A freshly staged value takes precedence; otherwise the existing attendance
 * value is retained. This prevents merely opening the weekly editor from
 * clearing days that already have attendance recorded.
 */
export function resolveWeeklyAttendanceEntries(
  weeklyDates,
  stagedEntries,
  getExistingStatus,
  toIsoDateString
) {
  return weeklyDates.map((dateValue) => {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    const isoDate = normalizeWeeklyDate(date, toIsoDateString);
    const stagedStatus = getStagedAttendanceStatus(
      stagedEntries,
      isoDate,
      toIsoDateString
    );
    const existingStatus = stagedStatus
      ? ""
      : String(getExistingStatus(date, isoDate) ?? "").trim();

    return {
      date: isoDate,
      status: stagedStatus || existingStatus
    };
  });
}

/** Create the Telegram-session state used when a weekly flow begins. */
export function createWeeklyFlowState(weeklyAttendanceDates) {
  return {
    awaitingWeeklyAttendance: true,
    weeklyAttendanceDates,
    weeklyAttendanceIndex: 0,
    weeklyAttendanceResults: [],
    weeklyAttendanceEntries: []
  };
}

/**
 * Advance the weekly UI by one day. `skip` means "leave this day unchanged",
 * not "write an empty attendance value". The returned state is a new object so
 * callers can safely persist/replace session state without hidden mutation.
 */
export function applyWeeklyAttendanceSelection(
  state,
  {
    action,
    dateValue,
    currentStatus,
    pickedStatus,
    formatWeekDateLabel
  }
) {
  const label = formatWeekDateLabel(new Date(dateValue));
  let resultLine = `${label}: skipped`;
  let nextEntries = state.weeklyAttendanceEntries;

  if (action !== "skip" && pickedStatus) {
    nextEntries = pickedStatus.entries;
    resultLine = `${label}: ${pickedStatus.status}`;
  } else if (currentStatus) {
    resultLine = `${label}: ${currentStatus}`;
  }

  return {
    awaitingWeeklyAttendance: state.weeklyAttendanceIndex + 1 < state.weeklyAttendanceDates.length,
    weeklyAttendanceDates: state.weeklyAttendanceDates,
    weeklyAttendanceIndex: state.weeklyAttendanceIndex + 1,
    weeklyAttendanceResults: [...state.weeklyAttendanceResults, resultLine],
    weeklyAttendanceEntries: nextEntries
  };
}
