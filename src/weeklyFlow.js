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

function weeklyDateStatus(dateValue, stagedEntries, getExistingStatus, toIsoDateString) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  const isoDate = normalizeWeeklyDate(date, toIsoDateString);
  const staged = getStagedAttendanceStatus(stagedEntries, isoDate, toIsoDateString);
  return {
    date,
    isoDate,
    status: staged || String(getExistingStatus(date, isoDate) ?? "").trim()
  };
}

/** ISO dates in the flow that have neither a staged nor an existing value. */
export function listBlankWeeklyDates(weeklyDates, stagedEntries, getExistingStatus, toIsoDateString) {
  return weeklyDates
    .map((dateValue) => weeklyDateStatus(dateValue, stagedEntries, getExistingStatus, toIsoDateString))
    .filter(({ status }) => !status)
    .map(({ isoDate }) => isoDate);
}

/**
 * Stage `status` on every blank day. Days that already have a value (staged in
 * this flow, already on the sheet, or prefilled PH) are never overwritten, so
 * "fill blanks" is always safe to tap.
 */
export function fillBlankWeeklyEntries(weeklyDates, stagedEntries, getExistingStatus, status, toIsoDateString) {
  const blanks = listBlankWeeklyDates(weeklyDates, stagedEntries, getExistingStatus, toIsoDateString);
  let entries = stagedEntries;
  for (const isoDate of blanks) {
    entries = upsertWeeklyAttendanceEntry(entries, isoDate, status, toIsoDateString);
  }
  return { entries, filledDates: blanks };
}

/**
 * Stage last week's value for each blank day. `getSourceStatus(date)` returns
 * the value recorded seven days earlier. Blank sources and PH are not copied:
 * a holiday last week says nothing about this week.
 */
export function copyWeeklyEntriesFromPreviousWeek(
  weeklyDates,
  stagedEntries,
  getExistingStatus,
  getSourceStatus,
  toIsoDateString,
  options = {}
) {
  const skipStatuses = new Set(options.skipStatuses ?? ["PH"]);
  const blanks = new Set(listBlankWeeklyDates(weeklyDates, stagedEntries, getExistingStatus, toIsoDateString));
  let entries = stagedEntries;
  const copiedDates = [];

  for (const dateValue of weeklyDates) {
    const { date, isoDate } = weeklyDateStatus(dateValue, stagedEntries, getExistingStatus, toIsoDateString);
    if (!blanks.has(isoDate)) continue;
    const sourceStatus = String(getSourceStatus(date) ?? "").trim();
    if (!sourceStatus || skipStatuses.has(sourceStatus)) continue;
    entries = upsertWeeklyAttendanceEntry(entries, isoDate, sourceStatus, toIsoDateString);
    copiedDates.push(isoDate);
  }

  return { entries, copiedDates };
}

/**
 * Index of the next blank day after `afterIndex`, wrapping to earlier blank
 * days, or -1 when every day has a value. Used to move straight on to the next
 * day that still needs an answer instead of returning to the overview.
 */
export function findNextBlankWeeklyIndex(weeklyDates, stagedEntries, getExistingStatus, afterIndex, toIsoDateString) {
  const count = weeklyDates.length;
  for (let step = 1; step <= count; step += 1) {
    const index = (afterIndex + step) % count;
    const { status } = weeklyDateStatus(weeklyDates[index], stagedEntries, getExistingStatus, toIsoDateString);
    if (!status) return index;
  }
  return -1;
}
