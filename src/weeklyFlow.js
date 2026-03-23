export function getStagedAttendanceStatus(entries, date, toIsoDateString) {
  const isoDate = typeof date === "string" ? date : toIsoDateString(date);
  const entry = [...entries].reverse().find((value) => value.date === isoDate);
  return entry?.status ?? "";
}

export function upsertWeeklyAttendanceEntry(entries, date, status, toIsoDateString) {
  const isoDate = typeof date === "string" ? date : toIsoDateString(date);
  const nextEntries = entries.filter((entry) => entry.date !== isoDate);
  nextEntries.push({ date: isoDate, status });
  return nextEntries;
}

export function createWeeklyFlowState(weeklyAttendanceDates) {
  return {
    awaitingWeeklyAttendance: true,
    weeklyAttendanceDates,
    weeklyAttendanceIndex: 0,
    weeklyAttendanceResults: [],
    weeklyAttendanceEntries: []
  };
}

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
