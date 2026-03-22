import { google } from "googleapis";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../data");
const SHEET_CACHE_FILE = path.join(DATA_DIR, "sheet-cache.json");

function normalizeAppointmentLabel(value) {
  return String(value ?? "").trim();
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readJsonFile(filePath, fallbackValue) {
  await ensureDataDir();

  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }

    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  await ensureDataDir();
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

function isStopMarker(value, stopMarkers) {
  const normalizedValue = normalizeAppointmentLabel(value).toUpperCase();
  return stopMarkers.some((marker) => normalizedValue === marker.toUpperCase());
}

function sanitizeAppointments(values, stopMarkers) {
  const appointments = [];
  let stopped = false;

  for (const rawValue of values) {
    const value = normalizeAppointmentLabel(rawValue);

    if (!value) {
      continue;
    }

    if (isStopMarker(value, stopMarkers)) {
      stopped = true;
      break;
    }

    appointments.push(value);
  }

  const uniqueAppointments = uniquifyAppointments(appointments);

  return {
    appointments: uniqueAppointments,
    stopped,
    hadDuplicates: appointments.some((value, index) => value !== uniqueAppointments[index])
  };
}

function uniquifyAppointments(appointments) {
  const counts = new Map();

  for (const appointment of appointments) {
    counts.set(appointment, (counts.get(appointment) ?? 0) + 1);
  }

  const seen = new Map();

  return appointments.map((appointment) => {
    const total = counts.get(appointment) ?? 0;

    if (total <= 1) {
      return appointment;
    }

    const nextIndex = (seen.get(appointment) ?? 0) + 1;
    seen.set(appointment, nextIndex);
    return `${appointment}-${nextIndex}`;
  });
}

function columnNumberToLabel(columnNumber) {
  let current = columnNumber;
  let label = "";

  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }

  return label;
}

function getMonthParts(date, timezone) {
  const month = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short"
  }).format(date);
  const year = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "2-digit"
  }).format(date);
  const numericYear = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(date)
  );
  const numericMonth =
    Number(
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "numeric" }).format(date)
    ) - 1;

  return {
    title: `${month} ${year}`,
    month,
    numericYear,
    numericMonth
  };
}

function shiftMonth(date, timezone, monthOffset) {
  const { numericYear, numericMonth } = getMonthParts(date, timezone);
  return new Date(Date.UTC(numericYear, numericMonth + monthOffset, 1));
}

function daysInMonth(date, timezone) {
  const { numericYear, numericMonth } = getMonthParts(date, timezone);
  return new Date(Date.UTC(numericYear, numericMonth + 1, 0)).getUTCDate();
}

function dayOfMonth(date, timezone) {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, day: "numeric" }).format(date)
  );
}

function buildMonthHeader(date, timezone) {
  const { month } = getMonthParts(date, timezone);
  const header = ["Appointment"];

  for (let day = 1; day <= daysInMonth(date, timezone); day += 1) {
    header.push(`${day} ${month}`);
  }

  return header;
}

function parseMonthSheetTitle(title) {
  const match = title.match(/^([A-Z][a-z]{2}) (\d{2})$/);

  if (!match) {
    return null;
  }

  const months = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11
  };

  return {
    title,
    monthIndex: months[match[1]],
    year: 2000 + Number(match[2])
  };
}

async function getSpreadsheet(sheets, spreadsheetId) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: false
  });
  return response.data;
}

async function getSheetByTitle(sheets, spreadsheetId, title) {
  const spreadsheet = await getSpreadsheet(sheets, spreadsheetId);
  return spreadsheet.sheets?.find((entry) => entry.properties?.title === title) ?? null;
}

async function addSheet(sheets, spreadsheetId, title) {
  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title,
              gridProperties: {
                frozenRowCount: 1,
                frozenColumnCount: 1
              }
            }
          }
        }
      ]
    }
  });

  return response.data.replies?.[0]?.addSheet ?? null;
}

async function ensureSheet(sheets, spreadsheetId, title) {
  const existing = await getSheetByTitle(sheets, spreadsheetId, title);

  if (existing) {
    return existing;
  }

  return addSheet(sheets, spreadsheetId, title);
}

async function readAppointmentColumn(sheets, spreadsheetId, title, stopMarkers = []) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title}'!A2:A`
  });

  const rawValues = (response.data.values ?? []).map(([value]) => value);
  return sanitizeAppointments(rawValues, stopMarkers);
}

async function writeAppointmentColumn(
  sheets,
  spreadsheetId,
  title,
  appointments,
  options = {}
) {
  const clearRange = options.clearFullRows ? "A2:ZZ1000" : "A2:A1000";
  const values = appointments.map((appointment) => [appointment]);
  const endRow = Math.max(appointments.length + 1, 2);

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${title}'!${clearRange}`
  });

  if (values.length === 0) {
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${title}'!A2:A${endRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values
    }
  });

  if (options.trimTrailingRows) {
    const startRow = appointments.length + 2;
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${title}'!A${startRow}:ZZ1000`
    });
  }
}

async function readMonthlySheetRows(sheets, spreadsheetId, title, headerLength, stopMarkers) {
  const values = await readSheetValues(
    sheets,
    spreadsheetId,
    title,
    `A2:${columnNumberToLabel(headerLength)}1000`
  );
  const rows = [];

  for (const row of values) {
    const normalizedRow = normalizeRowValues(row, headerLength);
    const appointment = normalizeAppointmentLabel(normalizedRow[0]);

    if (!appointment) {
      continue;
    }

    if (isStopMarker(appointment, stopMarkers)) {
      break;
    }

    rows.push(normalizedRow);
  }

  return rows;
}

async function writeMonthlySheetRows(sheets, spreadsheetId, title, headerLength, rows) {
  const lastColumn = columnNumberToLabel(headerLength);

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${title}'!A2:${lastColumn}1000`
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${title}'!A2:${lastColumn}${rows.length + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: rows
      }
    });
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${title}'!A${rows.length + 2}:ZZ1000`
  });
}

async function writeHeaderRow(sheets, spreadsheetId, title, header) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${title}'!A1:${columnNumberToLabel(header.length)}1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [header]
    }
  });
}

async function writeOnboardingRows(sheets, spreadsheetId, title, rows) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${title}'!A2:B1000`
  });

  if (rows.length === 0) {
    return;
  }

  const endRow = rows.length + 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${title}'!A2:B${endRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: rows
    }
  });
}

async function applyAttendanceValidation(sheets, spreadsheetId, sheetId, headerLength, options) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: 1,
              startColumnIndex: 1,
              endColumnIndex: headerLength
            },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: options.map((value) => ({ userEnteredValue: value }))
              },
              strict: true,
              showCustomUi: true
            }
          }
        }
      ]
    }
  });
}

async function readCanonicalOnboardingAppointments(sheets, config) {
  const onboarding = await readAppointmentColumn(
    sheets,
    config.spreadsheetId,
    config.onboardingSheetTitle,
    config.rosterStopMarkers
  );

  return onboarding.appointments;
}

async function ensureMonthlyAttendanceSheet(sheets, config, date, appointments, mode) {
  const { title } = getMonthParts(date, config.timezone);
  const sheet = await ensureSheet(sheets, config.spreadsheetId, title);
  const header = buildMonthHeader(date, config.timezone);

  await writeHeaderRow(sheets, config.spreadsheetId, title, header);
  await applyAttendanceValidation(
    sheets,
    config.spreadsheetId,
    sheet.properties.sheetId,
    header.length,
    config.attendanceOptions
  );

  const existingAppointments = await readAppointmentColumn(
    sheets,
    config.spreadsheetId,
    title,
    config.rosterStopMarkers
  );
  const existingRows = await readMonthlySheetRows(
    sheets,
    config.spreadsheetId,
    title,
    header.length,
    config.rosterStopMarkers
  );
  const rowByAppointment = new Map(
    existingRows.map((row) => [normalizeAppointmentLabel(row[0]), row])
  );
  const onboardingAppointments = await readCanonicalOnboardingAppointments(sheets, config);
  // ONBOARDING is the canonical row order for monthly sheets. Interactive writes may
  // only mention one appointment, but we still rebuild against the full roster order.
  const preferredAppointments = onboardingAppointments.length > 0
    ? onboardingAppointments
    : appointments;

  const nextAppointments =
    mode === "replace"
      ? preferredAppointments
      : [
          ...preferredAppointments,
          ...appointments.filter((value) => !preferredAppointments.includes(value)),
          ...existingAppointments.appointments.filter(
            (value) => !preferredAppointments.includes(value) && !appointments.includes(value)
          )
        ];

  const nextRows = nextAppointments.map((appointment) => {
    const existingRow = rowByAppointment.get(normalizeAppointmentLabel(appointment));

    if (existingRow) {
      const nextRow = [...existingRow];
      nextRow[0] = appointment;
      return nextRow;
    }

    const blankRow = Array.from({ length: header.length }, () => "");
    blankRow[0] = appointment;
    return blankRow;
  });

  await writeMonthlySheetRows(
    sheets,
    config.spreadsheetId,
    title,
    header.length,
    nextRows
  );

  return {
    title,
    appointments: nextAppointments
  };
}

async function readSheetColumnValues(sheets, spreadsheetId, title, columnLabel) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title}'!${columnLabel}2:${columnLabel}1000`
  });

  return (response.data.values ?? []).map(([value]) => String(value ?? "").trim());
}

function countStatuses(values, statuses) {
  const normalizedStatuses = new Set(statuses.map((status) => String(status).trim()));
  return values.reduce(
    (count, value) => (normalizedStatuses.has(String(value).trim()) ? count + 1 : count),
    0
  );
}

function buildSummaryCounts(values) {
  const excludedFromTotal = new Set(["ORD", "POST OUT"]);
  const activeValues = values.filter((value) => !excludedFromTotal.has(String(value).trim()));
  const accountedAttendance = activeValues.filter(Boolean).length;
  const total = activeValues.length;

  return {
    total,
    present: countStatuses(activeValues, [
      "PRESENT",
      "CNB (AM)",
      "CNB (PM)",
      "CNB",
      "DUTY",
      "D1",
      "D2",
      "D3",
      "POOD (DAY)",
      "U/S",
      "OOD"
    ]),
    tnb: countStatuses(activeValues, ["TNB"]),
    accountedAttendance,
    unaccounted: total - accountedAttendance,
    os: countStatuses(activeValues, ["OS"]),
    osd: countStatuses(activeValues, ["OSD"]),
    ippt: countStatuses(activeValues, ["IPPT"]),
    orca: countStatuses(activeValues, ["ORCA"]),
    fmss: countStatuses(activeValues, ["FMSS"]),
    oe: countStatuses(activeValues, ["OE"]),
    ll: countStatuses(activeValues, ["LL", "AM LEAVE", "PM LEAVE"]),
    ol: countStatuses(activeValues, ["OL"]),
    oc: countStatuses(activeValues, ["OC"]),
    ao: countStatuses(activeValues, ["AO", "68", "69", "70", "71", "73"]),
    rsoRsi: countStatuses(activeValues, ["RSO", "RSI"]),
    mcOml: countStatuses(activeValues, ["MC", "OML"]),
    ccl: countStatuses(activeValues, ["CCL", "CCL (AM)", "CCL (PM)"]),
    csl: countStatuses(activeValues, ["CSL", "CSL (AM)", "CSL (PM)"]),
    ptl: countStatuses(activeValues, ["PTL"]),
    pcl: countStatuses(activeValues, ["PCL", "PCL (AM)", "PCL (PM)"]),
    rr: countStatuses(activeValues, ["RR"]),
    sr: countStatuses(activeValues, ["SR"]),
    ma: countStatuses(activeValues, ["MA"]),
    wfh: countStatuses(activeValues, ["WFH"]),
    offOil: countStatuses(activeValues, [
      "OFF",
      "OIL",
      "OFF (AM)",
      "OFF (PM)",
      "DISEMBARK OFF",
      "EMBARK OFF"
    ]),
    compassionate: countStatuses(activeValues, ["COMPASSIONATE"]),
    hl: countStatuses(activeValues, ["HL"]),
    ph: countStatuses(activeValues, ["PH"]),
    shro: countStatuses(activeValues, ["SHRO"]),
    yard: countStatuses(activeValues, ["YARD", "YARD (AM)", "YARD (PM)"]),
    fishing: countStatuses(activeValues, ["FISHING"])
  };
}

function normalizeRowValues(row, rowLength) {
  return Array.from({ length: rowLength }, (_, index) => String(row?.[index] ?? "").trim());
}

function createEmptyMonthlySnapshot(date, timezone, appointments = []) {
  const monthLength = daysInMonth(date, timezone);
  const statusesByDay = new Map();

  for (let day = 1; day <= monthLength; day += 1) {
    statusesByDay.set(day, Array.from({ length: appointments.length }, () => ""));
  }

  return {
    title: getMonthParts(date, timezone).title,
    appointments: [...appointments],
    statusesByDay,
    synchronizedAt: null
  };
}

function alignSnapshotToAppointments(snapshot, appointments, date, timezone) {
  const alignedSnapshot = createEmptyMonthlySnapshot(date, timezone, appointments);

  for (let index = 0; index < appointments.length; index += 1) {
    const appointment = appointments[index];
    const sourceIndex = snapshot.appointments.findIndex((value) => value === appointment);

    if (sourceIndex === -1) {
      continue;
    }

    for (let day = 1; day <= daysInMonth(date, timezone); day += 1) {
      const sourceValues = snapshot.statusesByDay.get(day) ?? [];
      alignedSnapshot.statusesByDay.get(day)[index] = String(sourceValues[sourceIndex] ?? "").trim();
    }
  }

  alignedSnapshot.synchronizedAt = snapshot.synchronizedAt ?? null;
  return alignedSnapshot;
}

function createMonthlySnapshotFromValues(date, values, config) {
  const rows = values.slice(1);
  const appointments = [];
  const statusesByDay = new Map();
  const headerLength = buildMonthHeader(date, config.timezone).length;

  for (const row of rows) {
    const appointment = normalizeAppointmentLabel(row?.[0]);

    if (!appointment) {
      continue;
    }

    if (isStopMarker(appointment, config.rosterStopMarkers)) {
      break;
    }

    appointments.push(appointment);
    const normalizedRow = normalizeRowValues(row, headerLength);

    for (let day = 1; day <= daysInMonth(date, config.timezone); day += 1) {
      if (!statusesByDay.has(day)) {
        statusesByDay.set(day, []);
      }

      statusesByDay.get(day).push(normalizedRow[day] ?? "");
    }
  }

  return {
    title: getMonthParts(date, config.timezone).title,
    appointments,
    statusesByDay,
    synchronizedAt: null
  };
}

function serializeSnapshot(snapshot) {
  return {
    title: snapshot.title,
    appointments: snapshot.appointments,
    statusesByDay: Object.fromEntries(
      [...snapshot.statusesByDay.entries()].map(([day, values]) => [String(day), values])
    ),
    synchronizedAt: snapshot.synchronizedAt ?? null
  };
}

function deserializeSnapshot(payload) {
  if (!payload || !Array.isArray(payload.appointments)) {
    return null;
  }

  return {
    title: String(payload.title ?? ""),
    appointments: payload.appointments.map((value) => String(value ?? "").trim()),
    statusesByDay: new Map(
      Object.entries(payload.statusesByDay ?? {}).map(([day, values]) => [
        Number(day),
        Array.isArray(values) ? values.map((value) => String(value ?? "").trim()) : []
      ])
    ),
    synchronizedAt: payload.synchronizedAt ?? null
  };
}

async function readLocalSheetCache() {
  return readJsonFile(SHEET_CACHE_FILE, {
    updatedAt: null,
    snapshots: {}
  });
}

async function writeLocalSheetCache(cache) {
  await writeJsonFile(SHEET_CACHE_FILE, cache);
}

function countFilledAttendanceCells(snapshot) {
  let count = 0;

  for (const values of snapshot.statusesByDay.values()) {
    for (const value of values) {
      if (String(value ?? "").trim()) {
        count += 1;
      }
    }
  }

  return count;
}

function shouldRestoreLocalSnapshot(localSnapshot, remoteSnapshot) {
  if (!localSnapshot) {
    return false;
  }

  const localFilled = countFilledAttendanceCells(localSnapshot);
  const remoteFilled = countFilledAttendanceCells(remoteSnapshot);

  // Only recover when the remote sheet looks effectively wiped, not just "less full".
  return localFilled > 0 && remoteFilled === 0;
}

function buildRowsFromSnapshot(snapshot, date, timezone) {
  const headerLength = buildMonthHeader(date, timezone).length;

  return snapshot.appointments.map((appointment, index) => {
    const row = Array.from({ length: headerLength }, () => "");
    row[0] = appointment;

    for (let day = 1; day <= daysInMonth(date, timezone); day += 1) {
      const values = snapshot.statusesByDay.get(day) ?? [];
      row[day] = String(values[index] ?? "").trim();
    }

    return row;
  });
}

async function restoreMonthlySheetFromSnapshot(sheets, config, date, snapshot) {
  const { title } = getMonthParts(date, config.timezone);
  const header = buildMonthHeader(date, config.timezone);
  const canonicalAppointments = await readCanonicalOnboardingAppointments(sheets, config);
  const alignedSnapshot = alignSnapshotToAppointments(
    snapshot,
    canonicalAppointments,
    date,
    config.timezone
  );

  await ensureMonthlyAttendanceSheet(sheets, config, date, canonicalAppointments, "replace");
  await writeMonthlySheetRows(
    sheets,
    config.spreadsheetId,
    title,
    header.length,
    buildRowsFromSnapshot(alignedSnapshot, date, config.timezone)
  );
}

async function persistSnapshotBundleToLocalCache(snapshotBundle) {
  const existingCache = await readLocalSheetCache();
  const snapshots = { ...(existingCache.snapshots ?? {}) };

  for (const [title, snapshot] of snapshotBundle.snapshots.entries()) {
    snapshots[title] = serializeSnapshot(snapshot);
  }

  await writeLocalSheetCache({
    updatedAt: new Date().toISOString(),
    snapshots
  });
}

async function persistAttendanceEntriesToLocalCache(sheets, config, entries) {
  if (!entries.length) {
    return;
  }

  const cache = await readLocalSheetCache();
  const snapshots = { ...(cache.snapshots ?? {}) };
  const canonicalAppointments = await readCanonicalOnboardingAppointments(sheets, config);
  const canonicalSet = new Set(canonicalAppointments);

  for (const entry of entries) {
    const date = entry.date ?? new Date();
    const { title } = getMonthParts(date, config.timezone);
    const existingSnapshot = alignSnapshotToAppointments(
      deserializeSnapshot(snapshots[title]) ?? createEmptyMonthlySnapshot(date, config.timezone),
      canonicalAppointments,
      date,
      config.timezone
    );

    if (!canonicalSet.has(entry.appointment)) {
      continue;
    }

    const appointmentIndex = existingSnapshot.appointments.findIndex(
      (value) => value === entry.appointment
    );

    const day = dayOfMonth(date, config.timezone);

    if (!existingSnapshot.statusesByDay.has(day)) {
      existingSnapshot.statusesByDay.set(
        day,
        Array.from({ length: existingSnapshot.appointments.length }, () => "")
      );
    }

    const dayValues = existingSnapshot.statusesByDay.get(day);

    while (dayValues.length < existingSnapshot.appointments.length) {
      dayValues.push("");
    }

    dayValues[appointmentIndex] = String(entry.status ?? "").trim();
    existingSnapshot.synchronizedAt = new Date().toISOString();
    snapshots[title] = serializeSnapshot(existingSnapshot);
  }

  await writeLocalSheetCache({
    updatedAt: new Date().toISOString(),
    snapshots
  });
}

function buildSummaryPayload(date, sheetTitle, rosterValues) {
  const counts = new Map();

  for (const value of rosterValues) {
    if (!value) {
      continue;
    }

    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return {
    date,
    sheetTitle,
    day: date.getUTCDate(),
    summary: buildSummaryCounts(rosterValues),
    counts: [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]))
  };
}

async function readSheetValues(sheets, spreadsheetId, title, range = "A1:ZZ1000") {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title}'!${range}`
  });

  return response.data.values ?? [];
}

async function seedOnboardingSheet(sheets, config) {
  const spreadsheet = await getSpreadsheet(sheets, config.spreadsheetId);
  const currentMonthTitle = getMonthParts(new Date(), config.timezone).title;
  const currentSheet = spreadsheet.sheets?.find(
    (entry) => entry.properties?.title === currentMonthTitle
  );

  if (currentSheet) {
    return (
      await readAppointmentColumn(
        sheets,
        config.spreadsheetId,
        currentMonthTitle,
        config.rosterStopMarkers
      )
    ).appointments;
  }

  const latestMonthSheet = (spreadsheet.sheets ?? [])
    .map((entry) => entry.properties?.title)
    .filter(Boolean)
    .map(parseMonthSheetTitle)
    .filter(Boolean)
    .sort((left, right) => {
      if (left.year !== right.year) {
        return right.year - left.year;
      }

      return right.monthIndex - left.monthIndex;
    })[0];

  if (!latestMonthSheet) {
    return [];
  }

  return (
    await readAppointmentColumn(
      sheets,
      config.spreadsheetId,
      latestMonthSheet.title,
      config.rosterStopMarkers
    )
  ).appointments;
}

async function readCurrentMonthAppointments(sheets, config) {
  const currentMonthTitle = getMonthParts(new Date(), config.timezone).title;
  const currentSheet = await getSheetByTitle(sheets, config.spreadsheetId, currentMonthTitle);

  if (!currentSheet) {
    return [];
  }

  return (
    await readAppointmentColumn(
      sheets,
      config.spreadsheetId,
      currentMonthTitle,
      config.rosterStopMarkers
    )
  ).appointments;
}

export function createGoogleSheetsClient(config) {
  const auth = new google.auth.JWT({
    email: config.googleServiceAccountEmail,
    key: config.googlePrivateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({ version: "v4", auth });
}

export async function syncOnboardingRoster(sheets, config) {
  const title = config.onboardingSheetTitle;
  const existingOnboardingSheet = await getSheetByTitle(sheets, config.spreadsheetId, title);
  const onboardingSheetWasMissing = !existingOnboardingSheet;
  await ensureSheet(sheets, config.spreadsheetId, title);
  await writeHeaderRow(sheets, config.spreadsheetId, title, ["Appointment", "Secret Code"]);

  let onboardingAppointments = await readAppointmentColumn(
    sheets,
    config.spreadsheetId,
    title,
    config.rosterStopMarkers
  );

  if (onboardingAppointments.appointments.length === 0) {
    onboardingAppointments = onboardingSheetWasMissing
      ? await readCurrentMonthAppointments(sheets, config)
      : await seedOnboardingSheet(sheets, config);
    await writeAppointmentColumn(
      sheets,
      config.spreadsheetId,
      title,
      onboardingAppointments,
      { trimTrailingRows: true }
    );
  } else if (onboardingAppointments.stopped) {
    await writeAppointmentColumn(
      sheets,
      config.spreadsheetId,
      title,
      onboardingAppointments.appointments,
      { trimTrailingRows: true }
    );
    onboardingAppointments = onboardingAppointments.appointments;
  } else if (onboardingAppointments.hadDuplicates) {
    await writeAppointmentColumn(
      sheets,
      config.spreadsheetId,
      title,
      onboardingAppointments.appointments,
      { trimTrailingRows: true }
    );
    onboardingAppointments = onboardingAppointments.appointments;
  } else {
    onboardingAppointments = onboardingAppointments.appointments;
  }

  const currentMonth = await ensureMonthlyAttendanceSheet(
    sheets,
    config,
    new Date(),
    onboardingAppointments,
    "merge"
  );
  const nextMonth = await ensureMonthlyAttendanceSheet(
    sheets,
    config,
    shiftMonth(new Date(), config.timezone, 1),
    onboardingAppointments,
    "replace"
  );

  return {
    onboardingAppointments,
    currentMonthTitle: currentMonth.title,
    nextMonthTitle: nextMonth.title
  };
}

export async function syncOnboardingCodeColumn(sheets, config, codeEntries) {
  const title = config.onboardingSheetTitle;
  await ensureSheet(sheets, config.spreadsheetId, title);
  await writeHeaderRow(sheets, config.spreadsheetId, title, ["Appointment", "Secret Code"]);

  const rows = codeEntries.map((entry) => [entry.appointment, entry.secretCode]);
  await writeOnboardingRows(sheets, config.spreadsheetId, title, rows);
}

export async function writeAttendanceStatus(sheets, config, entry) {
  const date = entry.date ?? new Date();
  const { title } = getMonthParts(date, config.timezone);
  await ensureMonthlyAttendanceSheet(
    sheets,
    config,
    date,
    [entry.appointment],
    "merge"
  );
  const appointments = await readAppointmentColumn(sheets, config.spreadsheetId, title);
  const rowIndex = appointments.appointments.findIndex((value) => value === entry.appointment);

  if (rowIndex === -1) {
    throw new Error(`Appointment row not found for ${entry.appointment}`);
  }

  const rowNumber = rowIndex + 2;
  const columnNumber = dayOfMonth(date, config.timezone) + 1;
  const cell = `${columnNumberToLabel(columnNumber)}${rowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `'${title}'!${cell}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[entry.status]]
    }
  });

  await persistAttendanceEntriesToLocalCache(sheets, config, [{
    appointment: entry.appointment,
    status: entry.status,
    date
  }]);

  return {
    sheetTitle: title,
    cell
  };
}

export async function writeAttendanceStatuses(sheets, config, entries) {
  if (!entries.length) {
    return [];
  }

  const entriesBySheet = new Map();

  for (const entry of entries) {
    const date = entry.date ?? new Date();
    const { title } = getMonthParts(date, config.timezone);

    if (!entriesBySheet.has(title)) {
      entriesBySheet.set(title, []);
    }

    entriesBySheet.get(title).push({ ...entry, date, sheetTitle: title });
  }

  const results = [];

  for (const [sheetTitle, sheetEntries] of entriesBySheet.entries()) {
    const appointments = [...new Set(sheetEntries.map((entry) => entry.appointment))];
    await ensureMonthlyAttendanceSheet(sheets, config, sheetEntries[0].date, appointments, "merge");
    const sheetAppointments = await readAppointmentColumn(
      sheets,
      config.spreadsheetId,
      sheetTitle,
      config.rosterStopMarkers
    );

    const appointmentRows = new Map(
      sheetAppointments.appointments.map((appointment, index) => [appointment, index + 2])
    );

    const data = sheetEntries.map((entry) => {
      const rowNumber = appointmentRows.get(entry.appointment);

      if (!rowNumber) {
        throw new Error(`Appointment row not found for ${entry.appointment}`);
      }

      const columnNumber = dayOfMonth(entry.date, config.timezone) + 1;
      const cell = `${columnNumberToLabel(columnNumber)}${rowNumber}`;

      results.push({
        appointment: entry.appointment,
        status: entry.status,
        date: entry.date,
        sheetTitle,
        cell
      });

      return {
        range: `'${sheetTitle}'!${cell}`,
        values: [[entry.status]]
      };
    });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data
      }
    });
  }

  await persistAttendanceEntriesToLocalCache(sheets, config, entries);

  return results;
}

export async function ensureNextMonthSheetExists(sheets, config) {
  const roster = await syncOnboardingRoster(sheets, config);
  return roster.nextMonthTitle;
}

export async function preloadAttendanceSnapshots(sheets, config, options = {}) {
  const baseDate = options.date ?? new Date();
  const targetDates = [
    shiftMonth(baseDate, config.timezone, -1),
    baseDate,
    shiftMonth(baseDate, config.timezone, 1)
  ];
  const snapshots = new Map();
  const localCache = await readLocalSheetCache();
  const canonicalAppointments = await readCanonicalOnboardingAppointments(sheets, config);

  for (const date of targetDates) {
    const { title } = getMonthParts(date, config.timezone);
    await ensureMonthlyAttendanceSheet(sheets, config, date, [], "merge");
    const values = await readSheetValues(sheets, config.spreadsheetId, title);
    const remoteSnapshot = alignSnapshotToAppointments(
      createMonthlySnapshotFromValues(date, values, config),
      canonicalAppointments,
      date,
      config.timezone
    );
    const localSnapshot = deserializeSnapshot(localCache.snapshots?.[title])
      ? alignSnapshotToAppointments(
        deserializeSnapshot(localCache.snapshots?.[title]),
        canonicalAppointments,
        date,
        config.timezone
      )
      : null;
    // Recovery is intentionally conservative: we only restore from disk if the remote
    // month has effectively been wiped, and we always clamp restored rows to ONBOARDING.
    const chosenSnapshot = shouldRestoreLocalSnapshot(localSnapshot, remoteSnapshot)
      ? localSnapshot
      : remoteSnapshot;

    if (chosenSnapshot === localSnapshot) {
      await restoreMonthlySheetFromSnapshot(sheets, config, date, localSnapshot);
    }

    snapshots.set(title, {
      ...chosenSnapshot,
      synchronizedAt: new Date().toISOString()
    });
  }

  const snapshotBundle = {
    synchronizedAt: new Date().toISOString(),
    snapshots
  };

  await persistSnapshotBundleToLocalCache(snapshotBundle);
  return snapshotBundle;
}

export function summarizeStatusesFromSnapshot(snapshotBundle, config, options = {}) {
  const date = options.date ?? new Date();
  const { title } = getMonthParts(date, config.timezone);
  const snapshot = snapshotBundle?.snapshots?.get(title);

  if (!snapshot) {
    return null;
  }

  const day = dayOfMonth(date, config.timezone);
  const rosterValues = snapshot.statusesByDay.get(day) ?? [];
  const summary = buildSummaryPayload(date, title, rosterValues);

  return {
    ...summary,
    synchronizedAt: snapshotBundle.synchronizedAt ?? snapshot.synchronizedAt ?? null
  };
}

export async function summarizeStatuses(sheets, config, options = {}) {
  const date = options.date ?? new Date();
  const { title } = getMonthParts(date, config.timezone);
  await ensureMonthlyAttendanceSheet(sheets, config, date, [], "merge");

  const day = dayOfMonth(date, config.timezone);
  const columnNumber = day + 1;
  const columnLabel = columnNumberToLabel(columnNumber);
  const values = await readSheetColumnValues(
    sheets,
    config.spreadsheetId,
    title,
    columnLabel
  );
  const appointments = await readAppointmentColumn(
    sheets,
    config.spreadsheetId,
    title,
    config.rosterStopMarkers
  );
  const rosterValues = appointments.appointments.map(
    (_, index) => String(values[index] ?? "").trim()
  );
  return buildSummaryPayload(date, title, rosterValues);
}
