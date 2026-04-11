import { google } from "googleapis";
import { getDataFile } from "./dataDir.js";
import {
  readJsonFile as readJsonFileFromStore,
  writeJsonFile as writeJsonFileToStore
} from "./fileStore.js";
import { getSingaporePublicHolidaySet } from "./holidays.js";
import { ipv4HttpsAgent } from "./network.js";

const SHEET_CACHE_FILE = () => getDataFile("sheet-cache.json");
const SPREADSHEET_METADATA_TTL_MS = 15 * 60 * 1000;
const ONBOARDING_SLICE_TTL_MS = 2 * 60 * 1000;
const MONTH_SLICE_TTL_MS = 60 * 1000;
const DEFAULT_MAX_MANAGED_ROWS = 1000;
const DEFAULT_BOOTSTRAP_APPOINTMENTS = ["USER1", "USER2", "USER3"];
const ATTENDANCE_OPTION_USAGE_MONTH_WINDOW = 2;
const GOOGLE_SHEETS_MAX_RETRY_ATTEMPTS = 5;
const GOOGLE_SHEETS_INITIAL_RETRY_DELAY_MS = 1000;
const GOOGLE_SHEETS_MIN_RETRY_DELAY_MS = 500;
const GOOGLE_SHEETS_MAX_RETRY_DELAY_MS = 32000;
const GOOGLE_SHEETS_REQUEST_TIMEOUT_MS = 15000;
const GOOGLE_SHEETS_SLOW_REQUEST_THRESHOLD_MS = 5000;
const MONTHLY_PROTECTION_FAILURE_COOLDOWN_MS = 30 * 60 * 1000;
const runtimeSheetContext = new WeakMap();
const ensuredMonthlySheetProtectionIds = new Set();
const monthlySheetProtectionFailureUntil = new Map();
let activeGoogleSheetsRequests = 0;

function logSheetsSuccess(message, details = null) {
  if (details) {
    console.log(`${message} ${JSON.stringify(details)}`);
    return;
  }

  console.log(message);
}
const ATTENDANCE_STATUS_ALIAS_MAP = new Map([
  ["PUBLIC HOLIDAY", "PH"],
  ["OVERSEAS DUTY", "OSD"],
  ["OUTSIDE EVENT", "OE"],
  ["WORK FROM HOME", "WFH"],
  ["OFF IN LIEU", "OIL"],
  ["SUNDAY ROUTINE", "SR"],
  ["OUTSTATIONED", "OS"],
  ["REPORT SICK OUTSIDE", "RSO"],
  ["MEDICAL CERTIFICATE", "MC"],
  ["OTHER MEDICAL LEAVE", "OML"],
  ["MEDICAL APPOINTMENT", "MA"],
  ["HOSPITALISATION LEAVE", "HL"],
  ["HOSPITALIZATION LEAVE", "HL"],
  ["REPORT SICK IN CAMP", "RSI"],
  ["REPORT SICK IN-CAMP", "RSI"],
  ["LOCAL LEAVE", "LL"],
  ["CHILD CARE LEAVE", "CCL"],
  ["PARENT CARE LEAVE", "PCL"],
  ["CHILD SICK LEAVE", "CSL"],
  ["PATERNITY LEAVE", "PTL"],
  ["OVERSEAS LEAVE", "OL"],
  ["ATTACHED OUT", "AO"],
  ["ON COURSE", "OC"],
  ["POSTED OUT", "POST OUT"],
  ["TUAS NAVAL BASE", "TNB"],
  ["CHANGI NAVAL BASE", "CNB"]
]);

function normalizeAppointmentLabel(value) {
  return String(value ?? "").trim();
}

function normalizeAppointmentIdentity(value) {
  return normalizeAppointmentLabel(value).toUpperCase();
}

function normalizeAppointmentForOrdering(value) {
  return normalizeAppointmentIdentity(value)
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAttendanceAliasKey(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[–—]/g, "-")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function canonicalizeAttendanceStatus(value) {
  const trimmed = String(value ?? "").trim();

  if (!trimmed) {
    return "";
  }

  const aliasKey = normalizeAttendanceAliasKey(trimmed);

  if (ATTENDANCE_STATUS_ALIAS_MAP.has(aliasKey)) {
    return ATTENDANCE_STATUS_ALIAS_MAP.get(aliasKey);
  }

  return trimmed.toUpperCase();
}

const TOP_BLOCK_ORDER = new Map([
  ["CO", 0],
  ["XO", 1],
  ["OPS", 2],
  ["NO", 3],
  ["AOPS", 4],
  ["SCSE", 5],
  ["SME", 6],
  ["ME", 7],
  ["COXN", 8],
  ["ASE", 9],
  ["ANO", 10],
  ["YO", 11],
  ["MID", 12]
]);

const DEPARTMENT_SPECS = [
  { label: "C2", order: 0, chiefPatterns: [/^CC2(.*)$/] },
  { label: "WS", order: 1, chiefPatterns: [/^CWS(.*)$/] },
  { label: "WCS", order: 2, chiefPatterns: [/^CWCS(.*)$/] },
  { label: "UW", order: 3, chiefPatterns: [/^CUW(.*)$/] },
  { label: "NAV", order: 4, chiefPatterns: [] },
  { label: "COMMS", order: 5, chiefPatterns: [/^CCOMMS(.*)$/] },
  { label: "ELECTRONIC SPECIALIST", order: 6, chiefPatterns: [/^CHIEF ELECTRONIC SPECIALIST(.*)$/] },
  { label: "COMMS SPECIALIST", order: 7, chiefPatterns: [/^CHIEF COMMS SPECIALIST(.*)$/] },
  { label: "MS", order: 8, chiefPatterns: [/^CMS(.*)$/] },
  { label: "ECS", order: 9, chiefPatterns: [/^CECS(.*)$/] },
  { label: "CHEF", order: 10, chiefPatterns: [/^CCHEF(.*)$/] }
];
export const DEPARTMENT_BUCKETS = [
  { key: "OFFICERS", label: "Officers" },
  { key: "C2", label: "C2" },
  { key: "WS", label: "WS" },
  { key: "WCS", label: "WCS" },
  { key: "UW", label: "UW" },
  { key: "NAV", label: "Nav" },
  { key: "COMMS", label: "Comms" },
  { key: "ELECTRONIC_SPECIALIST", label: "Electronic Specialist" },
  { key: "COMMS_SPECIALIST", label: "Comms Specialist" },
  { key: "MS", label: "MS" },
  { key: "ECS", label: "ECS" },
  { key: "CHEF", label: "Chef" }
];
const DEPARTMENT_LABEL_BY_KEY = new Map(
  DEPARTMENT_BUCKETS.map((entry) => [entry.key, entry.label])
);

const DEPARTMENT_PARSE_SPECS = [...DEPARTMENT_SPECS].sort(
  (left, right) => right.label.length - left.label.length
);

function compareVariantSuffix(left, right) {
  if (!left && !right) {
    return 0;
  }

  if (!left) {
    return -1;
  }

  if (!right) {
    return 1;
  }

  return left.localeCompare(right);
}

function parseNumberWithSuffix(value) {
  const match = value.match(/^\s*(\d+)(.*)$/);

  if (!match) {
    return {
      number: -1,
      suffix: value.trim()
    };
  }

  return {
    number: Number(match[1]),
    suffix: String(match[2] ?? "").trim()
  };
}

function parseTopBlockAppointment(label, originalIndex) {
  const normalized = normalizeAppointmentForOrdering(label);
  const exactFamilies = ["COXN", "CO", "XO", "NO", "SCSE", "SME", "ME"];

  for (const family of exactFamilies) {
    const match = normalized.match(new RegExp(`^${family}(.*)$`));

    if (match && (match[1] === "" || /^[\s(-]/.test(match[1]))) {
      return {
        bucketOrder: TOP_BLOCK_ORDER.get(family),
        family,
        roleOrder: 0,
        number: -1,
        variantSuffix: String(match[1] ?? "").trim(),
        originalIndex
      };
    }
  }

  for (const family of ["OPS", "AOPS", "ASE", "ANO", "YO"]) {
    const match = normalized.match(new RegExp(`^${family}(.*)$`));

    if (match && (match[1] === "" || /^[\s(-]/.test(match[1]))) {
      const parsed = parseNumberWithSuffix(match[1]);
      return {
        bucketOrder: TOP_BLOCK_ORDER.get(family),
        family,
        roleOrder: 0,
        number: parsed.number,
        variantSuffix: parsed.suffix,
        originalIndex
      };
    }
  }

  const midMatch = normalized.match(/^MIDS?(.*)$/);

  if (midMatch && (midMatch[1] === "" || /^[\s(-]/.test(midMatch[1]))) {
    const parsed = parseNumberWithSuffix(midMatch[1]);
    return {
      bucketOrder: TOP_BLOCK_ORDER.get("MID"),
      family: "MID",
      roleOrder: 0,
      number: parsed.number,
      variantSuffix: parsed.suffix,
      originalIndex
    };
  }

  return null;
}

function parseDepartmentAppointment(label, originalIndex) {
  const normalized = normalizeAppointmentForOrdering(label);

  for (const spec of DEPARTMENT_PARSE_SPECS) {

    for (const pattern of spec.chiefPatterns) {
      const chiefMatch = normalized.match(pattern);

      if (chiefMatch) {
        return {
          bucketOrder: 100 + spec.order,
          family: `${spec.label}:CHIEF`,
          roleOrder: 0,
          number: -1,
          variantSuffix: String(chiefMatch[1] ?? "").trim(),
          originalIndex
        };
      }
    }

    const prefixPattern = new RegExp(`^${spec.label.replace(/\s+/g, "\\s+")}(.*)$`);
    const prefixMatch = normalized.match(prefixPattern);

    if (!prefixMatch || (prefixMatch[1] && !/^[\s(-]/.test(prefixMatch[1]))) {
      continue;
    }

    const remainder = String(prefixMatch[1] ?? "").trim();

    for (const [pattern, roleOrder, familySuffix] of [
      [/^SUP(?:\s+(\d+))?(.*)$/, 1, "SUP"],
      [/^(\d+)(.*)$/, 2, "SEAT"],
      [/^WPL(?:\s+(\d+))?(.*)$/, 3, "WPL"],
      [/^OJT(?:\s+(\d+))?(.*)$/, 4, "OJT"]
    ]) {
      const match = remainder.match(pattern);

      if (!match) {
        continue;
      }

        return {
          bucketOrder: 100 + spec.order,
          family: `${spec.label}:${familySuffix}`,
        roleOrder,
        number: match[1] ? Number(match[1]) : -1,
        variantSuffix: String(match[2] ?? "").trim(),
        originalIndex
      };
    }

    return {
      bucketOrder: 100 + spec.order,
      family: `${spec.label}:OTHER`,
      roleOrder: 5,
      number: -1,
      variantSuffix: remainder,
      originalIndex
    };
  }

  return null;
}

function parseAppointmentOrderingMetadata(label, originalIndex) {
  return parseTopBlockAppointment(label, originalIndex) ??
    parseDepartmentAppointment(label, originalIndex) ?? {
      bucketOrder: Number.MAX_SAFE_INTEGER,
      family: normalizeAppointmentForOrdering(label),
      roleOrder: Number.MAX_SAFE_INTEGER,
      number: -1,
      variantSuffix: "",
      originalIndex
    };
}

export function classifyAppointmentDepartment(appointment) {
  if (parseTopBlockAppointment(appointment, 0)) {
    return DEPARTMENT_LABEL_BY_KEY.get("OFFICERS");
  }

  const departmentMeta = parseDepartmentAppointment(appointment, 0);

  if (!departmentMeta) {
    return null;
  }

  const [rawKey] = String(departmentMeta.family ?? "").split(":");
  const departmentKey = rawKey.replace(/\s+/g, "_");
  return DEPARTMENT_LABEL_BY_KEY.get(departmentKey) ?? null;
}

function orderAppointmentsCanonically(appointments = []) {
  return appointments
    .map((value, originalIndex) => ({ value, originalIndex }))
    .sort((left, right) => {
      const leftMeta = parseAppointmentOrderingMetadata(left.value, left.originalIndex);
      const rightMeta = parseAppointmentOrderingMetadata(right.value, right.originalIndex);

      if (leftMeta.bucketOrder !== rightMeta.bucketOrder) {
        return leftMeta.bucketOrder - rightMeta.bucketOrder;
      }

      if (leftMeta.roleOrder !== rightMeta.roleOrder) {
        return leftMeta.roleOrder - rightMeta.roleOrder;
      }

      if (leftMeta.family !== rightMeta.family) {
        return leftMeta.family.localeCompare(rightMeta.family);
      }

      if (leftMeta.number !== rightMeta.number) {
        return leftMeta.number - rightMeta.number;
      }

      const suffixResult = compareVariantSuffix(leftMeta.variantSuffix, rightMeta.variantSuffix);

      if (suffixResult !== 0) {
        return suffixResult;
      }

      return left.originalIndex - right.originalIndex;
    })
    .map((entry) => entry.value);
}

async function readJsonFile(filePath, fallbackValue) {
  return readJsonFileFromStore(filePath, fallbackValue);
}

async function writeJsonFile(filePath, value) {
  await writeJsonFileToStore(filePath, value);
}

function isStopMarker(value, stopMarkers) {
  const normalizedValue = normalizeAppointmentLabel(value).toUpperCase();
  return stopMarkers.some((marker) => normalizedValue === marker.toUpperCase());
}

function isLegacyRemarksBoundary(value) {
  return normalizeAppointmentIdentity(value) === "REMARKS";
}

function sanitizeAppointments(values, stopMarkers) {
  const appointments = [];
  let stopped = false;

  for (const rawValue of values) {
    const value = normalizeAppointmentLabel(rawValue);

    if (!value) {
      continue;
    }

    if (isStopMarker(value, stopMarkers) || isLegacyRemarksBoundary(value)) {
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

function dedupeAppointmentsPreservingOrder(appointments = []) {
  const seen = new Set();
  const deduped = [];
  const duplicates = [];

  for (const appointment of appointments) {
    const identity = normalizeAppointmentIdentity(appointment);

    if (seen.has(identity)) {
      duplicates.push(appointment);
      continue;
    }

    seen.add(identity);
    deduped.push(appointment);
  }

  return {
    appointments: deduped,
    duplicates
  };
}

function computeManagedAreaHash(value) {
  return JSON.stringify(value);
}

function isSliceFresh(fetchedAt, ttlMs) {
  if (!fetchedAt) {
    return false;
  }

  return Date.now() - new Date(fetchedAt).getTime() < ttlMs;
}

function getPrimaryStopMarker(stopMarkers = []) {
  return stopMarkers[0] ?? "";
}

function buildDefaultSheetCache() {
  return {
    updatedAt: null,
    lastStructuralMaintenanceAt: null,
    maintainedSheetProtectionIds: [],
    spreadsheetMetadata: {
      fetchedAt: null,
      sheetIdsByTitle: {}
    },
    onboardingSlice: null,
    monthSlices: {},
    snapshots: {}
  };
}

function getRuntimeSheetContext(cache) {
  if (!cache) {
    return null;
  }

  if (!runtimeSheetContext.has(cache)) {
    runtimeSheetContext.set(cache, {
      spreadsheet: null
    });
  }

  return runtimeSheetContext.get(cache);
}

function isRetryableGoogleSheetsError(error) {
  if (error?.isTimeout === true) {
    return true;
  }

  const status = Number(error?.code ?? error?.status ?? error?.response?.status ?? 0);
  const reasons = [
    error?.errors?.[0]?.reason,
    error?.response?.data?.error?.status,
    error?.response?.data?.error?.errors?.[0]?.reason
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  return status === 429 ||
    status >= 500 ||
    reasons.some((reason) =>
      reason.includes("ratelimit") ||
      reason.includes("quota") ||
      reason.includes("resource_exhausted") ||
      reason.includes("backenderror")
    );
}

function getGoogleSheetsRetryDelay(attempt, options = {}) {
  const randomFn = options.randomFn ?? Math.random;
  const cappedBaseDelay = Math.min(
    GOOGLE_SHEETS_INITIAL_RETRY_DELAY_MS * (2 ** (attempt - 1)),
    GOOGLE_SHEETS_MAX_RETRY_DELAY_MS
  );

  const jitteredDelay = Math.floor(randomFn() * cappedBaseDelay);
  return Math.max(jitteredDelay, GOOGLE_SHEETS_MIN_RETRY_DELAY_MS);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createGoogleSheetsTimeoutError(operation, timeoutMs) {
  const error = new Error(
    `Google Sheets request timed out after ${timeoutMs}ms for ${operation}`
  );
  error.name = "GoogleSheetsTimeoutError";
  error.code = "ETIMEDOUT";
  error.status = 504;
  error.isTimeout = true;
  return error;
}

async function runGoogleSheetsRequestWithTimeout(operation, request, options = {}) {
  const timeoutMs = options.timeoutMs ?? GOOGLE_SHEETS_REQUEST_TIMEOUT_MS;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const controller = new AbortController();
  let timeoutId = null;

  try {
    return await Promise.race([
      request(controller.signal),
      new Promise((_, reject) => {
        timeoutId = setTimeoutFn(() => {
          controller.abort();
          reject(createGoogleSheetsTimeoutError(operation, timeoutMs));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeoutFn(timeoutId);
    }
    controller.abort();
  }
}

async function runGoogleSheetsRequest(operation, request, options = {}) {
  const maxAttempts = options.maxAttempts ?? GOOGLE_SHEETS_MAX_RETRY_ATTEMPTS;
  const sleepFn = options.sleepFn ?? sleep;
  const logFn = options.logFn ?? console.warn;
  let attempt = 0;

  activeGoogleSheetsRequests += 1;
  const startTime = Date.now();
  const startTs = new Date().toISOString();

  console.log(
    `[${startTs}] [Sheets] START ${operation} (in-flight: ${activeGoogleSheetsRequests})`
  );

  try {
    while (attempt < maxAttempts) {
      attempt += 1;

      try {
        const result = await runGoogleSheetsRequestWithTimeout(operation, request, options);
        const durationMs = Date.now() - startTime;

        if (durationMs >= GOOGLE_SHEETS_SLOW_REQUEST_THRESHOLD_MS) {
          logFn(
            `[${new Date().toISOString()}] [Sheets] SLOW ${operation} completed in ${durationMs}ms`
          );
        }

        return result;
      } catch (error) {
        if (!isRetryableGoogleSheetsError(error) || attempt >= maxAttempts) {
          const durationMs = Date.now() - startTime;
          logFn(
            `[${new Date().toISOString()}] [Sheets] FAIL ${operation} after ${durationMs}ms` +
            ` (attempt ${attempt}/${maxAttempts}): ${error.message}`
          );
          throw error;
        }

        const delayMs = getGoogleSheetsRetryDelay(attempt, options);
        logFn(
          `[${new Date().toISOString()}] [Sheets] retry ${attempt}/${maxAttempts}` +
          ` for ${operation} after ${delayMs}ms: ${error.message}`
        );
        await sleepFn(delayMs);
      }
    }

    throw new Error(`Google Sheets request exhausted retries for ${operation}`);
  } finally {
    activeGoogleSheetsRequests -= 1;
  }
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

function getWeekdayIndex(date, timezone) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short"
  }).format(date);
  const weekdayOrder = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6
  };

  return weekdayOrder[weekday] ?? 0;
}

function buildMonthHeader(date, timezone) {
  const { month } = getMonthParts(date, timezone);
  const header = ["Appointment"];

  for (let day = 1; day <= daysInMonth(date, timezone); day += 1) {
    header.push(`${day} ${month}`);
  }

  return header;
}

function getExpectedDateHeaderLabel(date, timezone) {
  const { month } = getMonthParts(date, timezone);
  return `${dayOfMonth(date, timezone)} ${month}`;
}

function buildDateColumnMap(headerRow, date, timezone) {
  const monthLength = daysInMonth(date, timezone);
  const map = new Map();

  for (let day = 1; day <= monthLength; day += 1) {
    const dayDate = new Date(Date.UTC(
      getMonthParts(date, timezone).numericYear,
      getMonthParts(date, timezone).numericMonth,
      day,
      12
    ));
    const label = getExpectedDateHeaderLabel(dayDate, timezone);
    const columnIndex = headerRow.findIndex((value) => String(value ?? "").trim() === label);

    if (columnIndex !== -1) {
      map.set(day, columnIndex);
    }
  }

  return map;
}

function getDefaultHeaderRow(date, timezone) {
  return buildMonthHeader(date, timezone);
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

async function getSpreadsheet(sheets, spreadsheetId, options = {}) {
  const runtimeContext = getRuntimeSheetContext(options.cache);

  if (runtimeContext?.spreadsheet && options.force !== true) {
    return runtimeContext.spreadsheet;
  }

  const response = await runGoogleSheetsRequest("spreadsheets.get", (signal) =>
    sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false
    }, { signal })
  );
  const spreadsheet = response.data;

  if (runtimeContext) {
    runtimeContext.spreadsheet = spreadsheet;
  }

  return spreadsheet;
}

async function getSheetByTitle(sheets, spreadsheetId, title, options = {}) {
  const spreadsheet = await getSpreadsheet(sheets, spreadsheetId, options);
  return spreadsheet.sheets?.find((entry) => entry.properties?.title === title) ?? null;
}

async function addSheet(sheets, spreadsheetId, title) {
  const response = await runGoogleSheetsRequest(`spreadsheets.batchUpdate:addSheet:${title}`, (signal) =>
    sheets.spreadsheets.batchUpdate({
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
    }, { signal })
  );

  return response.data.replies?.[0]?.addSheet ?? null;
}

async function ensureSheet(sheets, spreadsheetId, title, options = {}) {
  if (options.cache) {
    const metadata = await updateSpreadsheetMetadataCache(
      sheets,
      { spreadsheetId },
      options.cache,
      options.forceMetadata === true
    );
    const existingSheetId = metadata.sheetIdsByTitle?.[title];

    if (Number.isInteger(existingSheetId)) {
      return {
        sheet: {
          properties: {
            title,
            sheetId: existingSheetId
          }
        },
        created: false
      };
    }
  }

  const existing = await getSheetByTitle(sheets, spreadsheetId, title, options);

  if (existing) {
    return {
      sheet: existing,
      created: false
    };
  }

  const addedSheet = await addSheet(sheets, spreadsheetId, title);

  if (options.cache) {
    const metadata = options.cache.spreadsheetMetadata ?? buildDefaultSheetCache().spreadsheetMetadata;
    options.cache.spreadsheetMetadata = {
      ...metadata,
      fetchedAt: new Date().toISOString(),
      sheetIdsByTitle: {
        ...(metadata.sheetIdsByTitle ?? {}),
        [title]: addedSheet?.properties?.sheetId ?? null
      }
    };
    const runtimeContext = getRuntimeSheetContext(options.cache);

    if (runtimeContext?.spreadsheet) {
      runtimeContext.spreadsheet = {
        ...runtimeContext.spreadsheet,
        sheets: [
          ...(runtimeContext.spreadsheet.sheets ?? []),
          addedSheet
        ]
      };
    }
  }

  return {
    sheet: addedSheet,
    created: true
  };
}

async function readAppointmentColumn(sheets, spreadsheetId, title, stopMarkers = []) {
  const response = await runGoogleSheetsRequest(`spreadsheets.values.get:${title}:A2:A`, (signal) =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${title}'!A2:A`
    }, { signal })
  );

  const rawValues = (response.data.values ?? []).map(([value]) => value);
  return sanitizeAppointments(rawValues, stopMarkers);
}

function parseOnboardingManagedRows(values, stopMarkers = []) {
  const rows = values.slice(1);
  const managedRows = [];
  let boundaryRowNumber = null;
  let stopRowNumber = null;
  let stopMarkerMissing = false;
  let hadInlineStopMarkerDrift = false;
  let hasBlankRowDrift = false;
  const blankRowNumbers = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const appointment = normalizeAppointmentLabel(row[0]);
    const rowNumber = index + 2;

    if (!appointment) {
      const hasLaterManagedAppointment = rows.slice(index + 1).some((nextRow) => {
        const nextAppointment = normalizeAppointmentLabel(nextRow?.[0]);
        return nextAppointment && !isStopMarker(nextAppointment, stopMarkers);
      });

      if (hasLaterManagedAppointment) {
        hasBlankRowDrift = true;
        blankRowNumbers.push(rowNumber);
        continue;
      }

      boundaryRowNumber = rowNumber;
      stopMarkerMissing = true;
      break;
    }

    if (isStopMarker(appointment, stopMarkers) || isLegacyRemarksBoundary(appointment)) {
      stopRowNumber = rowNumber;
      boundaryRowNumber = rowNumber;
      hadInlineStopMarkerDrift = rows.slice(index + 1).some((nextRow) =>
        Boolean(normalizeAppointmentLabel(nextRow?.[0]))
      );
      break;
    }

    managedRows.push({
      rowNumber,
      appointment,
      secretCode: String(row[1] ?? "").trim()
    });
  }

  if (!boundaryRowNumber) {
    boundaryRowNumber = managedRows.length + 2;
    stopMarkerMissing = true;
  }

  const dedupedAppointments = dedupeAppointmentsPreservingOrder(
    managedRows.map((row) => row.appointment)
  );
  const canonicalIdentities = new Set(
    dedupedAppointments.appointments.map((appointment) => normalizeAppointmentIdentity(appointment))
  );
  const normalizedManagedRows = managedRows.filter((row) =>
    canonicalIdentities.has(normalizeAppointmentIdentity(row.appointment))
  ).filter((row, index, filteredRows) =>
    filteredRows.findIndex(
      (candidate) =>
        normalizeAppointmentIdentity(candidate.appointment) ===
        normalizeAppointmentIdentity(row.appointment)
    ) === index
  );

  return {
    appointments: dedupedAppointments.appointments,
    managedRows: normalizedManagedRows,
    duplicateAppointments: dedupedAppointments.duplicates,
    stopRowNumber,
    boundaryRowNumber,
    stopMarkerMissing,
    hadInlineStopMarkerDrift,
    hasBlankRowDrift,
    blankRowNumbers,
    managedRangeEndRow: boundaryRowNumber - 1
  };
}

function buildLiveManagedMonthlyRows(values, headerLength, stopMarkers = [], canonicalAppointments = []) {
  const canonicalIdentities = new Set(
    canonicalAppointments.map((appointment) => normalizeAppointmentIdentity(appointment))
  );
  const seenCanonicalIdentities = new Set();
  const rows = [];

  for (let index = 1; index < values.length; index += 1) {
    const normalizedRow = normalizeRowValues(values[index] ?? [], headerLength);
    const appointment = normalizeAppointmentLabel(normalizedRow[0]);

    if (!appointment) {
      continue;
    }

    const appointmentIdentity = normalizeAppointmentIdentity(appointment);

    if (isStopMarker(appointment, stopMarkers)) {
      break;
    }

    if (isLegacyRemarksBoundary(appointment)) {
      if (canonicalIdentities.size === 0 || seenCanonicalIdentities.size >= canonicalIdentities.size) {
        break;
      }
    }

    rows.push({
      rowNumber: index + 1,
      appointment,
      row: normalizedRow
    });

    if (canonicalIdentities.has(appointmentIdentity)) {
      seenCanonicalIdentities.add(appointmentIdentity);
      continue;
    }

    if (canonicalIdentities.size > 0 && seenCanonicalIdentities.size >= canonicalIdentities.size) {
      rows.pop();
      break;
    }
  }

  return rows;
}

async function readHeaderRow(sheets, spreadsheetId, title, fallbackHeader = []) {
  const values = await readSheetValues(sheets, spreadsheetId, title, "A1:ZZ1");
  const headerRow = (values[0] ?? []).map((value) => String(value ?? "").trim());
  const hasHeader = headerRow.some(Boolean);
  return hasHeader ? headerRow : fallbackHeader;
}

async function getStopAwareWriteBoundary(
  sheets,
  spreadsheetId,
  title,
  stopMarkers = [],
  maxRow = 1000
) {
  const response = await runGoogleSheetsRequest(
    `spreadsheets.values.get:${title}:A2:A${maxRow}`,
    (signal) => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${title}'!A2:A${maxRow}`
    }, { signal })
  );
  const rawValues = (response.data.values ?? []).map(([value]) => normalizeAppointmentLabel(value));
  const stopIndex = rawValues.findIndex((value) => isStopMarker(value, stopMarkers));
  const stopRowNumber = stopIndex === -1 ? null : stopIndex + 2;

  return {
    stopRowNumber,
    managedRangeEndRow: stopRowNumber ? stopRowNumber - 1 : maxRow
  };
}

async function writeAppointmentColumn(
  sheets,
  spreadsheetId,
  title,
  appointments,
  options = {}
) {
  const values = await readSheetValues(sheets, spreadsheetId, title, "A1:B1000");
  const parsed = parseOnboardingManagedRows(values, options.stopMarkers ?? []);
  const existingCodes = new Map(parsed.managedRows.map((row) => [row.appointment, row.secretCode]));
  const rows = appointments.map((appointment) => [appointment, existingCodes.get(appointment) ?? ""]);
  await writeOnboardingRows(sheets, spreadsheetId, title, rows, options.stopMarkers ?? [], options);
}

async function readMonthlySheetRows(
  sheets,
  spreadsheetId,
  title,
  headerLength,
  stopMarkers,
  canonicalAppointments = []
) {
  const values = await readSheetValues(
    sheets,
    spreadsheetId,
    title,
    `A2:${columnNumberToLabel(headerLength)}1000`
  );
  return buildLiveManagedMonthlyRows(
    [["Appointment"], ...values],
    headerLength,
    stopMarkers,
    canonicalAppointments
  ).map((entry) => entry.row);
}

function getHeaderRowFromValues(values, fallbackHeader = []) {
  const headerRow = (values[0] ?? []).map((value) => String(value ?? "").trim());
  return headerRow.some(Boolean) ? headerRow : fallbackHeader;
}

function buildMonthlySheetRefreshContext(
  values,
  date,
  config,
  fallbackHeader = [],
  canonicalAppointments = []
) {
  const header = getHeaderRowFromValues(values, fallbackHeader);
  const existingAppointments = sanitizeAppointments(
    values.slice(1).map((row) => row?.[0]),
    config.rosterStopMarkers
  );
  const existingRows = buildLiveManagedMonthlyRows(
    values,
    header.length,
    config.rosterStopMarkers,
    canonicalAppointments
  ).map((entry) => entry.row);
  const liveSlice = createMonthSliceFromValues(date, values, config, canonicalAppointments);

  return {
    header,
    existingAppointments,
    existingRows,
    liveSlice
  };
}

async function writeMonthlySheetRows(
  sheets,
  spreadsheetId,
  sheetId,
  title,
  headerLength,
  headerRow,
  timezone,
  existingRows,
  rows,
  stopMarkers = []
) {
  const existingAppointments = existingRows.map((row) => normalizeAppointmentLabel(row[0]));
  const nextAppointments = rows.map((row) => normalizeAppointmentLabel(row[0]));
  const { operations } = planManagedRowStructureChanges(
    existingAppointments,
    nextAppointments
  );

  if (operations.length > 0) {
    const requests = operations.map((operation) => {
      const rowIndex = operation.index + 1;

      return operation.type === "insert"
        ? {
          insertDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowIndex,
              endIndex: rowIndex + 1
            },
            inheritFromBefore: rowIndex > 1
          }
        }
        : {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowIndex,
              endIndex: rowIndex + 1
            }
          }
        };
    });

    await runGoogleSheetsRequest(`spreadsheets.batchUpdate:${title}:rows`, (signal) =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests
        }
      }, { signal })
    );
  }

  const changedData = [];
  const managedColumnIndices = [0, ...buildDateColumnMap(
    headerRow,
    getDateFromMonthTitle(title) ?? new Date(),
    timezone
  ).values()];
  const managedGroups = groupContiguousIndices(managedColumnIndices);

  for (let index = 0; index < rows.length; index += 1) {
    const nextRow = rows[index];
    const existingRow = normalizeRowValues(existingRows[index] ?? [], headerLength);

    for (const group of managedGroups) {
      const groupChanged = group.some((columnIndex) =>
        String(existingRow?.[columnIndex] ?? "").trim() !== String(nextRow?.[columnIndex] ?? "").trim()
      );

      if (!groupChanged) {
        continue;
      }

      const startColumn = group[0] + 1;
      const endColumn = group[group.length - 1] + 1;
      changedData.push({
        range: `'${title}'!${columnNumberToLabel(startColumn)}${index + 2}:${columnNumberToLabel(endColumn)}${index + 2}`,
        values: [[...group.map((columnIndex) => String(nextRow?.[columnIndex] ?? "").trim())]]
      });
    }
  }

  if (changedData.length > 0) {
    await runGoogleSheetsRequest(`spreadsheets.values.batchUpdate:${title}:managedRows`, (signal) =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: changedData
        }
      }, { signal })
    );
  }
}

async function writeHeaderRow(sheets, spreadsheetId, title, header) {
  await runGoogleSheetsRequest(`spreadsheets.values.update:${title}:header`, (signal) =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${title}'!A1:${columnNumberToLabel(header.length)}1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [header]
      }
    }, { signal })
  );
}

function buildHeaderUpdateRequest(sheetId, header) {
  return {
    updateCells: {
      start: {
        sheetId,
        rowIndex: 0,
        columnIndex: 0
      },
      rows: [
        {
          values: header.map((value) => ({
            userEnteredValue: {
              stringValue: String(value ?? "")
            }
          }))
        }
      ],
      fields: "userEnteredValue"
    }
  };
}

async function writeOnboardingRows(sheets, spreadsheetId, title, rows, stopMarkers = [], options = {}) {
  const sheet = await getSheetByTitle(sheets, spreadsheetId, title, options);
  const values = await readSheetValues(sheets, spreadsheetId, title, "A1:B1000");
  const parsed = parseOnboardingManagedRows(values, stopMarkers);
  const currentCount = parsed.appointments.length;
  const nextCount = rows.length;
  const rowDelta = nextCount - currentCount;
  const boundaryRowNumber = parsed.boundaryRowNumber;

  if (rowDelta !== 0) {
    await runGoogleSheetsRequest(`spreadsheets.batchUpdate:${title}:onboardingRows`, (signal) =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            rowDelta > 0
              ? {
                insertDimension: {
                  range: {
                    sheetId: sheet.properties.sheetId,
                    dimension: "ROWS",
                    startIndex: boundaryRowNumber - 1,
                    endIndex: boundaryRowNumber - 1 + rowDelta
                  },
                  inheritFromBefore: boundaryRowNumber > 2
                }
              }
              : {
                deleteDimension: {
                  range: {
                    sheetId: sheet.properties.sheetId,
                    dimension: "ROWS",
                    startIndex: nextCount + 1,
                    endIndex: currentCount + 1
                  }
                }
              }
          ]
        }
      }, { signal })
    );
  }

  const data = [];

  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 2;
    const nextRow = rows[index];
    const currentRow = parsed.managedRows[index];

    if (
      !currentRow ||
      currentRow.appointment !== String(nextRow[0] ?? "").trim() ||
      currentRow.secretCode !== String(nextRow[1] ?? "").trim()
    ) {
      data.push({
        range: `'${title}'!A${rowNumber}:B${rowNumber}`,
        values: [[String(nextRow[0] ?? "").trim(), String(nextRow[1] ?? "").trim()]]
      });
    }
  }

  if (parsed.stopRowNumber) {
    data.push({
      range: `'${title}'!A${parsed.stopRowNumber}:B${parsed.stopRowNumber}`,
      values: [["", ""]]
    });
  }

  await runGoogleSheetsRequest(`spreadsheets.values.batchUpdate:${title}:onboardingRows`, (signal) =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data
      }
    }, { signal })
  );
}

function buildAttendanceValidationRequest(sheetId, headerLength, options) {
  return {
    setDataValidation: {
      range: {
        sheetId,
        startRowIndex: 1,
        startColumnIndex: 1,
        endRowIndex: 1000,
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
  };
}

async function buildDisabledDayFormattingRequests(sheetId, date, timezone) {
  const requests = [];
  const holidaySet = await getSingaporePublicHolidaySet(
    Number(
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(date)
    )
  );

  for (let day = 1; day <= daysInMonth(date, timezone); day += 1) {
    const dayDate = new Date(Date.UTC(
      getMonthParts(date, timezone).numericYear,
      getMonthParts(date, timezone).numericMonth,
      day,
      12
    ));
    const isoDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(dayDate);
    const isWeekend = getWeekdayIndex(dayDate, timezone) >= 5;
    const isPublicHoliday = holidaySet.has(isoDate);

    if (!isWeekend && !isPublicHoliday) {
      continue;
    }

    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1000,
          startColumnIndex: day,
          endColumnIndex: day + 1
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 }
          }
        },
        fields: "userEnteredFormat.backgroundColor"
      }
    });
  }

  return requests;
}

async function applyMonthlySheetLayout(sheets, spreadsheetId, sheetId, date, header, options, timezone) {
  const requests = [
    buildHeaderUpdateRequest(sheetId, header),
    buildAttendanceValidationRequest(sheetId, header.length, options),
    ...(await buildDisabledDayFormattingRequests(sheetId, date, timezone))
  ];

  await runGoogleSheetsRequest(`spreadsheets.batchUpdate:${sheetId}:layout`, (signal) =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests
      }
    }, { signal })
  );
}

function buildMonthlySheetProtectionRequests(sheet, serviceAccountEmail) {
  const protectedRanges = sheet?.protectedRanges ?? [];
  const existingDescriptions = new Set(
    protectedRanges
      .map((range) => String(range.description ?? "").trim())
      .filter(Boolean)
  );
  const editors = serviceAccountEmail ? { users: [serviceAccountEmail] } : undefined;
  const requests = [];

  if (!existingDescriptions.has("attendance-bot:protect-header-row")) {
    requests.push({
      addProtectedRange: {
        protectedRange: {
          description: "attendance-bot:protect-header-row",
          range: {
            sheetId: sheet.properties.sheetId,
            startRowIndex: 0,
            endRowIndex: 1
          },
          editors,
          warningOnly: false
        }
      }
    });
  }

  if (!existingDescriptions.has("attendance-bot:protect-appointment-column")) {
    requests.push({
      addProtectedRange: {
        protectedRange: {
          description: "attendance-bot:protect-appointment-column",
          range: {
            sheetId: sheet.properties.sheetId,
            startColumnIndex: 0,
            endColumnIndex: 1
          },
          editors,
          warningOnly: false
        }
      }
    });
  }

  return requests;
}

async function ensureMonthlySheetProtections(sheets, spreadsheetId, sheet, serviceAccountEmail, options = {}) {
  const sheetId = Number(sheet?.properties?.sheetId);

  if (!Number.isFinite(sheetId)) {
    return;
  }

  if (ensuredMonthlySheetProtectionIds.has(sheetId)) {
    return;
  }

  const failureUntil = monthlySheetProtectionFailureUntil.get(sheetId) ?? 0;

  if (failureUntil > Date.now()) {
    return;
  }

  const requests = buildMonthlySheetProtectionRequests(sheet, serviceAccountEmail);

  if (requests.length === 0) {
    ensuredMonthlySheetProtectionIds.add(sheetId);
    await persistProtectionId(sheetId, options.cache);
    return;
  }

  try {
    await runGoogleSheetsRequest(
      `spreadsheets.batchUpdate:${sheetId}:protections`,
      (signal) =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests
          }
        }, { signal }),
      {
        maxAttempts: 2,
        timeoutMs: 5000
      }
    );
    ensuredMonthlySheetProtectionIds.add(sheetId);
    monthlySheetProtectionFailureUntil.delete(sheetId);
    await persistProtectionId(sheetId, options.cache);
    logSheetsSuccess("Monthly sheet protections ensured.", {
      title: sheet?.properties?.title ?? null,
      sheetId,
      requestCount: requests.length
    });
  } catch (error) {
    monthlySheetProtectionFailureUntil.set(
      sheetId,
      Date.now() + MONTHLY_PROTECTION_FAILURE_COOLDOWN_MS
    );
    console.warn(
      `Skipping monthly sheet protections for sheet ${sheetId} after failure: ${error.message}`
    );
  }
}

async function persistProtectionId(sheetId, cache) {
  // Persist the sheetId so future process restarts skip re-running the batchUpdate.
  // If a cache object is provided, mutate it in-place and let the caller persist;
  // otherwise do a targeted read-modify-write on the local cache file.
  const MAX_MAINTAINED_IDS = 24; // ~2 years of monthly sheets

  if (cache) {
    if (!Array.isArray(cache.maintainedSheetProtectionIds)) {
      cache.maintainedSheetProtectionIds = [];
    }
    if (!cache.maintainedSheetProtectionIds.includes(sheetId)) {
      cache.maintainedSheetProtectionIds = [
        ...cache.maintainedSheetProtectionIds.slice(-(MAX_MAINTAINED_IDS - 1)),
        sheetId
      ];
    }
    return;
  }

  // No cache object in scope — read-modify-write the file directly.
  try {
    const existing = await readLocalSheetCache();
    const ids = Array.isArray(existing.maintainedSheetProtectionIds)
      ? existing.maintainedSheetProtectionIds
      : [];

    if (!ids.includes(sheetId)) {
      existing.maintainedSheetProtectionIds = [
        ...ids.slice(-(MAX_MAINTAINED_IDS - 1)),
        sheetId
      ];
      await writeLocalSheetCache(existing);
    }
  } catch {
    // Non-fatal — we already have the in-memory set populated.
  }
}

async function ensureHeaderRowIfBlank(sheets, spreadsheetId, title, header) {
  const values = await readSheetValues(sheets, spreadsheetId, title, "A1:ZZ1");
  const existingHeaderRow = values[0] ?? [];
  const hasAnyHeaderValue = existingHeaderRow.some((value) => String(value ?? "").trim());

  if (!hasAnyHeaderValue) {
    await writeHeaderRow(sheets, spreadsheetId, title, header);
  }
}

async function readCanonicalOnboardingAppointments(sheets, config, options = {}) {
  const onboarding = await refreshOnboardingSlice(sheets, config, {
    cache: options.cache,
    force: options.force === true,
    persist: options.persist
  });
  return onboarding.appointments;
}

function buildManagedMonthlyRows({
  preferredAppointments,
  requestedAppointments,
  existingAppointments,
  existingRows,
  headerLength,
  mode
}) {
  const rowByAppointment = new Map(
    existingRows.map((row) => [normalizeAppointmentIdentity(row[0]), row])
  );
  const nextAppointments = preferredAppointments.length > 0
    ? preferredAppointments
    : (
      mode === "replace"
        ? requestedAppointments
        : [
            ...requestedAppointments,
            ...existingAppointments.filter((value) => !requestedAppointments.includes(value))
          ]
    );

  const nextRows = nextAppointments.map((appointment) => {
    const existingRow = rowByAppointment.get(normalizeAppointmentIdentity(appointment));

    if (existingRow) {
      const nextRow = [...existingRow];
      nextRow[0] = appointment;
      return nextRow;
    }

    const blankRow = Array.from({ length: headerLength }, () => "");
    blankRow[0] = appointment;
    return blankRow;
  });

  return {
    nextAppointments,
    nextRows
  };
}

async function ensureMonthlyAttendanceSheet(sheets, config, date, appointments, mode, options = {}) {
  if (!isManagedMonthlyDate(date, config.timezone)) {
    return {
      title: getMonthParts(date, config.timezone).title,
      appointments: [...appointments],
      skipped: true
    };
  }

  const { title } = getMonthParts(date, config.timezone);
  const ensuredSheet = await ensureSheet(sheets, config.spreadsheetId, title, {
    cache: options.cache
  });
  const sheet = ensuredSheet.sheet;
  const defaultHeader = getDefaultHeaderRow(date, config.timezone);
  let monthlySheetValues = null;

  if (ensuredSheet.created) {
    await applyMonthlySheetLayout(
      sheets,
      config.spreadsheetId,
      sheet.properties.sheetId,
      date,
      defaultHeader,
      config.attendanceOptions,
      config.timezone
    );
    monthlySheetValues = [defaultHeader];
  } else {
    monthlySheetValues = await readSheetValues(sheets, config.spreadsheetId, title, "A1:ZZ1000");
    const existingHeader = getHeaderRowFromValues(monthlySheetValues, []);

    if (existingHeader.length === 0) {
      await writeHeaderRow(sheets, config.spreadsheetId, title, defaultHeader);
      monthlySheetValues = [defaultHeader, ...monthlySheetValues.slice(1)];
    }
  }
  await ensureMonthlySheetProtections(
    sheets,
    config.spreadsheetId,
    sheet,
    config.googleServiceAccountEmail,
    { cache: options.cache }
  );
  const onboardingAppointments = await readCanonicalOnboardingAppointments(sheets, config, {
    cache: options.cache,
    force: options.forceOnboarding === true,
    persist: false
  });
  // ONBOARDING is the canonical row order for monthly sheets. Interactive writes may
  // only mention one appointment, but we still rebuild against the full roster order.
  const preferredAppointments = onboardingAppointments.length > 0
    ? onboardingAppointments
    : appointments;
  const {
    header,
    existingAppointments,
    existingRows,
    liveSlice
  } = buildMonthlySheetRefreshContext(
    monthlySheetValues ?? [defaultHeader],
    date,
    config,
    defaultHeader,
    preferredAppointments
  );

  if ((liveSlice.unexpectedAppointments?.length ?? 0) > 0 || (liveSlice.duplicateAppointments?.length ?? 0) > 0) {
    return {
      title,
      appointments: preferredAppointments,
      blockedByDrift: true,
      driftReasons: {
        unexpectedAppointments: liveSlice.unexpectedAppointments,
        duplicateAppointments: liveSlice.duplicateAppointments
      }
    };
  }

  const { nextAppointments, nextRows } = buildManagedMonthlyRows({
    preferredAppointments,
    requestedAppointments: appointments,
    existingAppointments: existingAppointments.appointments,
    existingRows,
    headerLength: header.length,
    mode
  });

  await writeMonthlySheetRows(
    sheets,
    config.spreadsheetId,
    sheet.properties.sheetId,
    title,
    header.length,
    header,
    config.timezone,
    existingRows,
    nextRows,
    config.rosterStopMarkers
  );

  logSheetsSuccess("Monthly attendance sheet synchronized.", {
    title,
    mode,
    appointmentCount: nextAppointments.length,
    created: ensuredSheet.created === true
  });

  return {
    title,
    appointments: nextAppointments
  };
}

async function readSheetColumnValues(sheets, spreadsheetId, title, columnLabel) {
  const response = await runGoogleSheetsRequest(
    `spreadsheets.values.get:${title}:${columnLabel}`,
    (signal) => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${title}'!${columnLabel}2:${columnLabel}1000`
    }, { signal })
  );

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
      "DUTY",
    ]),
    accountedAttendance,
    unaccounted: total - accountedAttendance,
    ph: countStatuses(activeValues, ["PH"]),
    osd: countStatuses(activeValues, ["OSD"]),
    oe: countStatuses(activeValues, ["OE"]),
    wfh: countStatuses(activeValues, ["WFH"]),
    fishing: countStatuses(activeValues, ["FISHING"]),
    off: countStatuses(activeValues, [
      "OFF",
      "OIL",
      "OFF (AM)",
      "OFF (PM)",
      "DISEMBARK OFF",
      "EMBARK OFF",
      "RR",
      "SR"
    ]),
    outstationed: countStatuses(activeValues, [
      "OS",
      "TNB",
      "YARD",
      "YARD (AM)",
      "YARD (PM)",
      "ORCA"
    ]),
    reportSick: countStatuses(activeValues, ["RSO", "MC", "OML", "MA", "HL", "RSI"]),
    localLeave: countStatuses(activeValues, [
      "LL",
      "AM LEAVE",
      "PM LEAVE",
      "CCL",
      "CCL (AM)",
      "CCL (PM)",
      "PCL",
      "PCL (AM)",
      "PCL (PM)",
      "CSL",
      "CSL (AM)",
      "CSL (PM)",
      "COMPASSIONATE",
      "PTL"
    ]),
    overseasLeave: countStatuses(activeValues, ["OL"]),
    attachedOut: countStatuses(activeValues, ["AO", "68", "69", "70", "71", "73"]),
    onCourse: countStatuses(activeValues, ["OC"]),
    postedOut: countStatuses(values, ["ORD", "POST OUT"]),
    inBase: countStatuses(activeValues, ["IPPT", "FMSS", "CNB", "CST", "DCTC"])
  };
}

function normalizeRowValues(row, rowLength) {
  return Array.from({ length: rowLength }, (_, index) => String(row?.[index] ?? "").trim());
}

function rowsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function groupContiguousIndices(indices) {
  if (indices.length === 0) {
    return [];
  }

  const sorted = [...new Set(indices)].sort((left, right) => left - right);
  const groups = [];
  let current = [sorted[0]];

  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === current[current.length - 1] + 1) {
      current.push(sorted[index]);
      continue;
    }

    groups.push(current);
    current = [sorted[index]];
  }

  groups.push(current);
  return groups;
}

function planManagedRowStructureChanges(existingAppointments, nextAppointments) {
  const nextSet = new Set(nextAppointments);
  const workingAppointments = [...existingAppointments];
  const operations = [];
  let index = 0;

  while (index < nextAppointments.length) {
    const desiredAppointment = nextAppointments[index];
    const currentAppointment = workingAppointments[index];

    if (currentAppointment === desiredAppointment) {
      index += 1;
      continue;
    }

    if (currentAppointment && !nextSet.has(currentAppointment)) {
      operations.push({
        type: "delete",
        index,
        appointment: currentAppointment
      });
      workingAppointments.splice(index, 1);
      continue;
    }

    if (!workingAppointments.includes(desiredAppointment)) {
      operations.push({
        type: "insert",
        index,
        appointment: desiredAppointment
      });
      workingAppointments.splice(index, 0, desiredAppointment);
      index += 1;
      continue;
    }

    index += 1;
  }

  while (workingAppointments.length > nextAppointments.length) {
    operations.push({
      type: "delete",
      index: workingAppointments.length - 1,
      appointment: workingAppointments[workingAppointments.length - 1]
    });
    workingAppointments.pop();
  }

  return {
    operations,
    finalAppointments: workingAppointments
  };
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
  const headerRow = (values[0] ?? []).map((value) => String(value ?? "").trim());
  const rows = values.slice(1);
  const appointments = [];
  const statusesByDay = new Map();
  const headerLength = Math.max(headerRow.length, 1);
  const dateColumnMap = buildDateColumnMap(headerRow, date, config.timezone);

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

      const columnIndex = dateColumnMap.get(day);
      statusesByDay.get(day).push(
        columnIndex === undefined ? "" : normalizedRow[columnIndex] ?? ""
      );
    }
  }

  return {
    title: getMonthParts(date, config.timezone).title,
    appointments,
    statusesByDay,
    synchronizedAt: null
  };
}

function createMonthSliceFromValues(date, values, config, appointments) {
  const headerRow = (values[0] ?? []).map((value) => String(value ?? "").trim());
  const headerLength = Math.max(headerRow.length, 1);
  const liveManagedRows = buildLiveManagedMonthlyRows(
    values,
    headerLength,
    config.rosterStopMarkers,
    appointments
  );
  const dateColumnMap = buildDateColumnMap(headerRow, date, config.timezone);
  const liveRowsByIdentity = new Map();

  for (const liveRow of liveManagedRows) {
    const identity = normalizeAppointmentIdentity(liveRow.appointment);

    if (!liveRowsByIdentity.has(identity)) {
      liveRowsByIdentity.set(identity, []);
    }

    liveRowsByIdentity.get(identity).push(liveRow);
  }

  const rowNumbersByAppointment = {};
  const duplicateAppointments = [];
  const missingAppointments = [];
  const aliasCorrections = [];
  const snapshot = createEmptyMonthlySnapshot(date, config.timezone, appointments);

  for (const appointment of appointments) {
    const matchingRows = liveRowsByIdentity.get(normalizeAppointmentIdentity(appointment)) ?? [];

    if (matchingRows.length === 1) {
      const liveRow = matchingRows[0];
      rowNumbersByAppointment[appointment] = liveRow.rowNumber;
      const appointmentIndex = snapshot.appointments.findIndex((value) => value === appointment);

      for (let day = 1; day <= daysInMonth(date, config.timezone); day += 1) {
        const columnIndex = dateColumnMap.get(day);
        const rawValue = columnIndex === undefined ? "" : String(liveRow.row[columnIndex] ?? "").trim();
        const normalizedValue = canonicalizeAttendanceStatus(rawValue);
        snapshot.statusesByDay.get(day)[appointmentIndex] = normalizedValue;

        if (columnIndex !== undefined && rawValue && normalizedValue !== rawValue) {
          aliasCorrections.push({
            appointment,
            rowNumber: liveRow.rowNumber,
            columnIndex,
            rawValue,
            normalizedValue
          });
        }
      }
    } else if (matchingRows.length > 1) {
      duplicateAppointments.push(appointment);
    } else {
      missingAppointments.push(appointment);
    }
  }

  const canonicalIdentitySet = new Set(
    appointments.map((appointment) => normalizeAppointmentIdentity(appointment))
  );
  const unexpectedAppointments = liveManagedRows
    .filter((liveRow) => !canonicalIdentitySet.has(normalizeAppointmentIdentity(liveRow.appointment)))
    .map((liveRow) => liveRow.appointment);

  return {
    title: getMonthParts(date, config.timezone).title,
    headerRow,
    recognizedDateColumns: Object.fromEntries(
      [...dateColumnMap.entries()].map(([day, columnIndex]) => [String(day), columnIndex])
    ),
    appointments,
    rowNumbersByAppointment,
    liveAppointmentOrder: liveManagedRows.map((row) => row.appointment),
    duplicateAppointments,
    missingAppointments,
    unexpectedAppointments,
    aliasCorrections,
    managedAreaHash: computeManagedAreaHash({
      appointments,
      recognizedDateColumns: Object.fromEntries(
        [...dateColumnMap.entries()].map(([day, columnIndex]) => [String(day), columnIndex])
      ),
      statusesByDay: serializeSnapshot(snapshot).statusesByDay
    }),
    fetchedAt: new Date().toISOString(),
    snapshot
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

  if (payload.statusesByDay instanceof Map) {
    return {
      title: String(payload.title ?? ""),
      appointments: payload.appointments.map((value) => String(value ?? "").trim()),
      statusesByDay: new Map(
        [...payload.statusesByDay.entries()].map(([day, values]) => [
          Number(day),
          Array.isArray(values) ? values.map((value) => String(value ?? "").trim()) : []
        ])
      ),
      synchronizedAt: payload.synchronizedAt ?? null
    };
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
  const cache = await readJsonFile(SHEET_CACHE_FILE(), buildDefaultSheetCache());
  const merged = {
    ...buildDefaultSheetCache(),
    ...cache,
    spreadsheetMetadata: {
      ...buildDefaultSheetCache().spreadsheetMetadata,
      ...(cache?.spreadsheetMetadata ?? {})
    },
    monthSlices: { ...(cache?.monthSlices ?? {}) },
    snapshots: { ...(cache?.snapshots ?? {}) },
    maintainedSheetProtectionIds: Array.isArray(cache?.maintainedSheetProtectionIds)
      ? cache.maintainedSheetProtectionIds
      : []
  };

  // Hydrate the in-memory protection set from the persisted list so cold restarts
  // don't re-fire batchUpdate protection requests on already-protected sheets.
  for (const sheetId of merged.maintainedSheetProtectionIds) {
    ensuredMonthlySheetProtectionIds.add(Number(sheetId));
  }

  return merged;
}

export async function loadAttendanceSnapshotsFromLocalCache() {
  const localCache = await readLocalSheetCache();
  const snapshots = new Map();

  const sourceSnapshots = Object.keys(localCache.monthSlices ?? {}).length > 0
    ? Object.fromEntries(
      Object.entries(localCache.monthSlices ?? {})
        .map(([title, slice]) => [title, slice.snapshot])
        .filter(([, snapshot]) => Boolean(snapshot))
    )
    : localCache.snapshots ?? {};

  for (const [title, payload] of Object.entries(sourceSnapshots)) {
    const snapshot = deserializeSnapshot(payload);

    if (!snapshot) {
      continue;
    }

    snapshots.set(title, snapshot);
  }

  return {
    synchronizedAt: localCache.updatedAt ?? null,
    snapshots
  };
}

function buildSnapshotBundleFromMonthSlices(monthSlices) {
  const snapshots = new Map();

  for (const [title, slice] of Object.entries(monthSlices ?? {})) {
    const snapshot = deserializeSnapshot(slice?.snapshot ?? slice);

    if (snapshot) {
      snapshots.set(title, snapshot);
    }
  }

  return {
    synchronizedAt: new Date().toISOString(),
    snapshots
  };
}

function serializeMonthSlice(slice) {
  return {
    ...slice,
    snapshot: slice.snapshot ? serializeSnapshot(slice.snapshot) : null
  };
}

function deserializeMonthSlice(payload) {
  if (!payload) {
    return null;
  }

  return {
    ...payload,
    snapshot: deserializeSnapshot(payload.snapshot)
  };
}

function getSnapshotCellValue(snapshot, appointment, day) {
  if (!snapshot) {
    return "";
  }

  const appointmentIndex = snapshot.appointments.findIndex((value) => value === appointment);

  if (appointmentIndex === -1) {
    return "";
  }

  return String(snapshot.statusesByDay.get(day)?.[appointmentIndex] ?? "").trim();
}

function setSnapshotCellValue(snapshot, appointment, day, value) {
  const appointmentIndex = snapshot.appointments.findIndex((entry) => entry === appointment);

  if (appointmentIndex === -1) {
    return snapshot;
  }

  const dayValues = snapshot.statusesByDay.get(day) ?? Array.from(
    { length: snapshot.appointments.length },
    () => ""
  );

  while (dayValues.length < snapshot.appointments.length) {
    dayValues.push("");
  }

  dayValues[appointmentIndex] = String(value ?? "").trim();
  snapshot.statusesByDay.set(day, dayValues);
  snapshot.synchronizedAt = new Date().toISOString();
  return snapshot;
}

async function updateSpreadsheetMetadataCache(sheets, config, cache, force = false) {
  if (!force && isSliceFresh(cache.spreadsheetMetadata?.fetchedAt, SPREADSHEET_METADATA_TTL_MS)) {
    return cache.spreadsheetMetadata;
  }

  const spreadsheet = await getSpreadsheet(sheets, config.spreadsheetId, {
    cache,
    force
  });
  const sheetIdsByTitle = Object.fromEntries(
    (spreadsheet.sheets ?? [])
      .map((entry) => [entry.properties?.title, entry.properties?.sheetId])
      .filter(([title, sheetId]) => Boolean(title) && Number.isInteger(sheetId))
  );

  cache.spreadsheetMetadata = {
    fetchedAt: new Date().toISOString(),
    sheetIdsByTitle
  };

  return cache.spreadsheetMetadata;
}

async function writeLocalSheetCache(cache) {
  await writeJsonFile(SHEET_CACHE_FILE(), cache);
}

async function refreshOnboardingSlice(sheets, config, options = {}) {
  const cache = options.cache ?? (await readLocalSheetCache());

  if (!options.force && cache.onboardingSlice && isSliceFresh(
    cache.onboardingSlice.fetchedAt,
    ONBOARDING_SLICE_TTL_MS
  )) {
    return cache.onboardingSlice;
  }

  const title = config.onboardingSheetTitle;
  const ensuredSheet = await ensureSheet(sheets, config.spreadsheetId, title, { cache });
  const values = await readSheetValues(sheets, config.spreadsheetId, title, "A1:B1000");
  const headerRow = (values[0] ?? []).map((value) => String(value ?? "").trim());
  const parsed = parseOnboardingManagedRows(values, config.rosterStopMarkers);
  const stopMarker = getPrimaryStopMarker(config.rosterStopMarkers);
  const codeByAppointment = new Map(
    parsed.managedRows.map((row) => [row.appointment, row.secretCode])
  );

  const slice = {
    title,
    sheetId: ensuredSheet.sheet.properties?.sheetId ?? null,
    headerRow: headerRow.length > 0 ? headerRow : ["Appointment", "Secret Code"],
    sourceAppointments: parsed.appointments,
    appointments: parsed.appointments,
    orderWasNormalized: false,
    duplicateAppointments: parsed.duplicateAppointments,
    hasBlankRowDrift: parsed.hasBlankRowDrift,
    blankRowNumbers: parsed.blankRowNumbers,
    codeEntries: parsed.appointments.map((appointment) => ({
      appointment,
      secretCode: codeByAppointment.get(appointment) ?? ""
    })),
    stopRowNumber: parsed.stopRowNumber,
    boundaryRowNumber: parsed.boundaryRowNumber,
    managedRangeEndRow: parsed.managedRangeEndRow,
    stopMarker,
    stopMarkerMissing: parsed.stopMarkerMissing,
    hadInlineStopMarkerDrift: parsed.hadInlineStopMarkerDrift,
    managedAreaHash: computeManagedAreaHash({
      appointments: parsed.appointments,
      codes: parsed.appointments.map((appointment) => codeByAppointment.get(appointment) ?? ""),
      boundaryRowNumber: parsed.boundaryRowNumber
    }),
    fetchedAt: new Date().toISOString()
  };

  cache.onboardingSlice = slice;
  cache.updatedAt = new Date().toISOString();

  if (options.persist !== false) {
    await writeLocalSheetCache(cache);
  }

  return slice;
}

function getMonthTitleFromInput(input, timezone) {
  if (typeof input === "string") {
    return input;
  }

  return getMonthParts(input ?? new Date(), timezone).title;
}

function getDateFromMonthTitle(title) {
  const parsed = parseMonthSheetTitle(title);

  if (!parsed) {
    return null;
  }

  return new Date(Date.UTC(parsed.year, parsed.monthIndex, 1));
}

function isManagedMonthlyDate(date, timezone, baseDate = new Date()) {
  const targetTitle = getMonthParts(date, timezone).title;
  const currentTitle = getMonthParts(baseDate, timezone).title;
  const nextTitle = getMonthParts(shiftMonth(baseDate, timezone, 1), timezone).title;
  return targetTitle === currentTitle || targetTitle === nextTitle;
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

function buildRowsFromSnapshot(snapshot, date, timezone, headerRow = getDefaultHeaderRow(date, timezone)) {
  const headerLength = headerRow.length;
  const dateColumnMap = buildDateColumnMap(headerRow, date, timezone);

  return snapshot.appointments.map((appointment, index) => {
    const row = Array.from({ length: headerLength }, () => "");
    row[0] = appointment;

    for (let day = 1; day <= daysInMonth(date, timezone); day += 1) {
      const values = snapshot.statusesByDay.get(day) ?? [];
      const columnIndex = dateColumnMap.get(day);

      if (columnIndex !== undefined) {
        row[columnIndex] = String(values[index] ?? "").trim();
      }
    }

    return row;
  });
}

export function applyAttendanceEntriesToSnapshotBundle(snapshotBundle, config, entries) {
  if (!snapshotBundle || !entries.length) {
    return snapshotBundle;
  }

  const snapshots = new Map(snapshotBundle.snapshots ?? []);

  for (const entry of entries) {
    const date = entry.date ?? new Date();
    const { title } = getMonthParts(date, config.timezone);
    const existingSnapshot = snapshots.get(title)
      ? alignSnapshotToAppointments(
        snapshots.get(title),
        snapshots.get(title).appointments,
        date,
        config.timezone
      )
      : createEmptyMonthlySnapshot(date, config.timezone, [entry.appointment]);

    if (!existingSnapshot.appointments.includes(entry.appointment)) {
      existingSnapshot.appointments.push(entry.appointment);

      for (let day = 1; day <= daysInMonth(date, config.timezone); day += 1) {
        const values = existingSnapshot.statusesByDay.get(day) ?? [];

        while (values.length < existingSnapshot.appointments.length) {
          values.push("");
        }

        existingSnapshot.statusesByDay.set(day, values);
      }
    }

    const appointmentIndex = existingSnapshot.appointments.findIndex(
      (value) => value === entry.appointment
    );
    const day = dayOfMonth(date, config.timezone);
    const dayValues = existingSnapshot.statusesByDay.get(day) ?? Array.from(
      { length: existingSnapshot.appointments.length },
      () => ""
    );

    while (dayValues.length < existingSnapshot.appointments.length) {
      dayValues.push("");
    }

    dayValues[appointmentIndex] = String(entry.status ?? "").trim();
    existingSnapshot.statusesByDay.set(day, dayValues);
    existingSnapshot.synchronizedAt = new Date().toISOString();
    snapshots.set(title, existingSnapshot);
  }

  return {
    synchronizedAt: new Date().toISOString(),
    snapshots
  };
}

export function buildQueuedAttendanceEventMetadata(snapshotBundle, config, entry) {
  const date = entry.date ?? new Date();
  const { title } = getMonthParts(date, config.timezone);
  const snapshot = snapshotBundle?.snapshots?.get(title);
  const day = dayOfMonth(date, config.timezone);
  const appointmentIndex = snapshot?.appointments?.findIndex((value) => value === entry.appointment) ?? -1;
  const expectedPreviousValue = appointmentIndex === -1
    ? ""
    : String(snapshot?.statusesByDay?.get(day)?.[appointmentIndex] ?? "").trim();

  return {
    targetSheetTitle: title,
    expectedPreviousValue,
    expectedAppointment: entry.appointment,
    expectedDateLabel: getExpectedDateHeaderLabel(date, config.timezone),
    baseCacheTimestamp: snapshotBundle?.synchronizedAt ?? null
  };
}

async function restoreMonthlySheetFromSnapshot(sheets, config, date, snapshot) {
  const cache = await readLocalSheetCache();
  const { title } = getMonthParts(date, config.timezone);
  const header = await readHeaderRow(
    sheets,
    config.spreadsheetId,
    title,
    getDefaultHeaderRow(date, config.timezone)
  );
  const canonicalAppointments = await readCanonicalOnboardingAppointments(sheets, config, {
    cache,
    persist: false
  });
  const alignedSnapshot = alignSnapshotToAppointments(
    snapshot,
    canonicalAppointments,
    date,
    config.timezone
  );

  await ensureMonthlyAttendanceSheet(sheets, config, date, canonicalAppointments, "replace", { cache });
  const restoredSheet = await getSheetByTitle(sheets, config.spreadsheetId, title, { cache });
  const existingRows = await readMonthlySheetRows(
    sheets,
    config.spreadsheetId,
    title,
    header.length,
    config.rosterStopMarkers
  );
  await writeMonthlySheetRows(
    sheets,
    config.spreadsheetId,
    restoredSheet.properties.sheetId,
    title,
    header.length,
    header,
    config.timezone,
    existingRows,
    buildRowsFromSnapshot(alignedSnapshot, date, config.timezone, header),
    config.rosterStopMarkers
  );
}

async function persistSnapshotBundleToLocalCache(snapshotBundle) {
  const existingCache = await readLocalSheetCache();
  const snapshots = { ...(existingCache.snapshots ?? {}) };
  const monthSlices = { ...(existingCache.monthSlices ?? {}) };

  for (const [title, snapshot] of snapshotBundle.snapshots.entries()) {
    snapshots[title] = serializeSnapshot(snapshot);
    if (monthSlices[title]) {
      monthSlices[title] = {
        ...monthSlices[title],
        snapshot: serializeSnapshot(snapshot),
        fetchedAt: snapshot.synchronizedAt ?? new Date().toISOString()
      };
    }
  }

  await writeLocalSheetCache({
    updatedAt: new Date().toISOString(),
    spreadsheetMetadata: existingCache.spreadsheetMetadata ?? buildDefaultSheetCache().spreadsheetMetadata,
    onboardingSlice: existingCache.onboardingSlice ?? null,
    monthSlices,
    snapshots
  });
}

async function persistAttendanceEntriesToLocalCache(sheets, config, entries) {
  if (!entries.length) {
    return;
  }

  const cache = await readLocalSheetCache();
  const snapshots = { ...(cache.snapshots ?? {}) };
  const monthSlices = { ...(cache.monthSlices ?? {}) };
  const canonicalAppointments = await readCanonicalOnboardingAppointments(sheets, config, {
    cache,
    persist: false
  });
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

    if (monthSlices[title]) {
      monthSlices[title] = {
        ...monthSlices[title],
        snapshot: serializeSnapshot(existingSnapshot),
        fetchedAt: new Date().toISOString()
      };
    }
  }

  await writeLocalSheetCache({
    updatedAt: new Date().toISOString(),
    spreadsheetMetadata: cache.spreadsheetMetadata ?? buildDefaultSheetCache().spreadsheetMetadata,
    onboardingSlice: cache.onboardingSlice ?? null,
    monthSlices,
    snapshots
  });
}

async function refreshMonthSlice(sheets, config, input, options = {}) {
  const cache = options.cache ?? (await readLocalSheetCache());
  const title = getMonthTitleFromInput(input, config.timezone);
  const cachedSlice = deserializeMonthSlice(cache.monthSlices?.[title]);

  if (!options.force && cachedSlice && isSliceFresh(cachedSlice.fetchedAt, MONTH_SLICE_TTL_MS)) {
    return cachedSlice;
  }

  const date = typeof input === "string" ? getDateFromMonthTitle(title) : input;

  if (!date) {
    throw new Error(`Unable to resolve month slice for ${title}`);
  }

  const onboardingSlice = await refreshOnboardingSlice(sheets, config, {
    cache,
    force: options.force === true,
    persist: false
  });
  // Structural ops (sheet creation, row sync, layout, protections) are expensive.
  // Only run when explicitly requested (e.g. runDailySheetMaintenance or admin actions).
  if (options.structural === true && isManagedMonthlyDate(date, config.timezone)) {
    await ensureMonthlyAttendanceSheet(
      sheets,
      config,
      date,
      onboardingSlice.appointments,
      "replace",
      { cache }
    );
  }
  const values = await readSheetValues(sheets, config.spreadsheetId, title);
  const slice = createMonthSliceFromValues(date, values, config, onboardingSlice.appointments);

  if (options.normalizeAliases === true && (slice.aliasCorrections?.length ?? 0) > 0) {
    await applyAttendanceAliasCorrections(
      sheets,
      config.spreadsheetId,
      title,
      slice.aliasCorrections
    );
  }

  cache.monthSlices = {
    ...(cache.monthSlices ?? {}),
    [title]: serializeMonthSlice(slice)
  };
  cache.snapshots = {
    ...(cache.snapshots ?? {}),
    [title]: serializeSnapshot(slice.snapshot)
  };
  cache.updatedAt = new Date().toISOString();

  if (options.persist !== false) {
    await writeLocalSheetCache(cache);
  }

  return slice;
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
  const response = await runGoogleSheetsRequest(
    `spreadsheets.values.get:${title}:${range}`,
    (signal) => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${title}'!${range}`
    }, { signal })
  );

  return response.data.values ?? [];
}

async function applyAttendanceAliasCorrections(sheets, spreadsheetId, title, corrections) {
  if (!Array.isArray(corrections) || corrections.length === 0) {
    return;
  }

  await runGoogleSheetsRequest(`spreadsheets.values.batchUpdate:${title}:normalizeAliases`, (signal) =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: corrections.map((correction) => ({
          range: `'${title}'!${columnNumberToLabel(correction.columnIndex + 1)}${correction.rowNumber}`,
          values: [[correction.normalizedValue]]
        }))
      }
    }, { signal })
  );
}

async function seedOnboardingSheet(sheets, config, options = {}) {
  const cache = options.cache ?? (await readLocalSheetCache());
  await updateSpreadsheetMetadataCache(sheets, config, cache, false);
  const spreadsheet = await getSpreadsheet(sheets, config.spreadsheetId, { cache });
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
    return [...DEFAULT_BOOTSTRAP_APPOINTMENTS];
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

async function readCurrentMonthAppointments(sheets, config, options = {}) {
  const currentMonthTitle = getMonthParts(new Date(), config.timezone).title;
  const cache = options.cache ?? (await readLocalSheetCache());
  await updateSpreadsheetMetadataCache(sheets, config, cache, false);
  const currentSheet = await getSheetByTitle(sheets, config.spreadsheetId, currentMonthTitle, {
    cache
  });

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

function getBootstrapAppointments(appointments) {
  return appointments.length > 0
    ? appointments
    : [...DEFAULT_BOOTSTRAP_APPOINTMENTS];
}

function getRecentMonthTitles(baseDate, timezone, count) {
  const titles = [];

  for (let offset = 0; offset < count; offset += 1) {
    titles.push(getMonthParts(shiftMonth(baseDate, timezone, -offset), timezone).title);
  }

  return titles;
}

export function createGoogleSheetsClient(config) {
  const auth = new google.auth.JWT({
    email: config.googleServiceAccountEmail,
    key: config.googlePrivateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({ version: "v4", auth });
}

export async function syncOnboardingRoster(sheets, config, options = {}) {
  const cache = options.cache ?? (await readLocalSheetCache());
  const title = config.onboardingSheetTitle;
  await ensureSheet(sheets, config.spreadsheetId, title, { cache });
  await ensureHeaderRowIfBlank(
    sheets,
    config.spreadsheetId,
    title,
    ["Appointment", "Secret Code"]
  );

  let onboardingSlice = await refreshOnboardingSlice(sheets, config, {
    cache,
    force: true,
    persist: false
  });
  if (onboardingSlice.appointments.length === 0) {
    await writeAppointmentColumn(
      sheets,
      config.spreadsheetId,
      title,
      getBootstrapAppointments(await seedOnboardingSheet(sheets, config, { cache })),
      { trimTrailingRows: true, stopMarkers: config.rosterStopMarkers, cache }
    );
    onboardingSlice = await refreshOnboardingSlice(sheets, config, {
      cache,
      force: true,
      persist: false
    });
  } else if (onboardingSlice.stopMarkerMissing) {
    await writeAppointmentColumn(
      sheets,
      config.spreadsheetId,
      title,
      onboardingSlice.appointments,
      { trimTrailingRows: true, stopMarkers: config.rosterStopMarkers, cache }
    );
    onboardingSlice = await refreshOnboardingSlice(sheets, config, {
      cache,
      force: true,
      persist: false
    });
  }
  const onboardingAppointments = onboardingSlice.appointments;
  const driftDetected =
    onboardingSlice.hasBlankRowDrift ||
    (onboardingSlice.duplicateAppointments?.length ?? 0) > 0 ||
    onboardingSlice.hadInlineStopMarkerDrift;

  if (driftDetected) {
    return {
      onboardingAppointments,
      currentMonthTitle: getMonthParts(new Date(), config.timezone).title,
      nextMonthTitle: getMonthParts(
        shiftMonth(new Date(), config.timezone, 1),
        config.timezone
      ).title,
      driftDetected: true
    };
  }

  const currentMonth = await ensureMonthlyAttendanceSheet(
    sheets,
    config,
    new Date(),
    onboardingAppointments,
    "replace",
    { cache }
  );
  const nextMonth = await ensureMonthlyAttendanceSheet(
    sheets,
    config,
    shiftMonth(new Date(), config.timezone, 1),
    onboardingAppointments,
    "replace",
    { cache }
  );

  if (options.persist !== false) {
    cache.updatedAt = new Date().toISOString();
    await writeLocalSheetCache(cache);
  }

  logSheetsSuccess("Onboarding roster synchronized to active monthly sheets.", {
    onboardingCount: onboardingAppointments.length,
    currentMonthTitle: currentMonth.title,
    nextMonthTitle: nextMonth.title
  });

  return {
    onboardingAppointments,
    currentMonthTitle: currentMonth.title,
    nextMonthTitle: nextMonth.title
  };
}

export async function syncOnboardingCodeColumn(sheets, config, codeEntries) {
  const cache = await readLocalSheetCache();
  const title = config.onboardingSheetTitle;
  await ensureSheet(sheets, config.spreadsheetId, title, { cache });
  await ensureHeaderRowIfBlank(
    sheets,
    config.spreadsheetId,
    title,
    ["Appointment", "Secret Code"]
  );

  const onboardingSlice = await refreshOnboardingSlice(sheets, config, {
    cache,
    force: true,
    persist: false
  });
  const codeMap = new Map(codeEntries.map((entry) => [entry.appointment, entry.secretCode]));
  const rows = onboardingSlice.appointments.map((appointment) => [
    appointment,
    codeMap.get(appointment) ?? ""
  ]);
  await writeOnboardingRows(
    sheets,
    config.spreadsheetId,
    title,
    rows,
    config.rosterStopMarkers,
    { cache }
  );
  await refreshOnboardingSlice(sheets, config, { cache, force: true });
  logSheetsSuccess("Onboarding secret code column synchronized.", {
    entryCount: rows.length
  });
}

export async function addAppointmentToSheets(sheets, config, appointment) {
  const cache = await readLocalSheetCache();
  await ensureSheet(sheets, config.spreadsheetId, config.onboardingSheetTitle, { cache });
  await ensureHeaderRowIfBlank(
    sheets,
    config.spreadsheetId,
    config.onboardingSheetTitle,
    ["Appointment", "Secret Code"]
  );
  const onboarding = await readAppointmentColumn(
    sheets,
    config.spreadsheetId,
    config.onboardingSheetTitle,
    config.rosterStopMarkers
  );
  const nextAppointments = [...onboarding.appointments];

  if (!nextAppointments.some((entry) => normalizeAppointmentIdentity(entry) === normalizeAppointmentIdentity(appointment))) {
    nextAppointments.push(appointment);
  }
  await writeAppointmentColumn(
    sheets,
    config.spreadsheetId,
    config.onboardingSheetTitle,
    nextAppointments,
    { trimTrailingRows: true, stopMarkers: config.rosterStopMarkers, cache }
  );
  await refreshOnboardingSlice(sheets, config, { cache, force: true, persist: false });

  await ensureMonthlyAttendanceSheet(sheets, config, new Date(), nextAppointments, "replace", { cache });
  await ensureMonthlyAttendanceSheet(
    sheets,
    config,
    shiftMonth(new Date(), config.timezone, 1),
    nextAppointments,
    "replace",
    { cache }
  );
  logSheetsSuccess("Appointment added to active monthly sheets.", {
    appointment,
    appointmentCount: nextAppointments.length
  });
}

export async function removeAppointmentFromSheets(sheets, config, appointment) {
  const cache = await readLocalSheetCache();
  await ensureSheet(sheets, config.spreadsheetId, config.onboardingSheetTitle, { cache });
  const onboarding = await refreshOnboardingSlice(sheets, config, {
    cache,
    force: true,
    persist: false
  });
  const nextAppointments = onboarding.appointments.filter(
    (entry) => entry.toUpperCase() !== appointment.toUpperCase()
  );
  await writeAppointmentColumn(
    sheets,
    config.spreadsheetId,
    config.onboardingSheetTitle,
    nextAppointments,
    { trimTrailingRows: true, stopMarkers: config.rosterStopMarkers, cache }
  );
  await refreshOnboardingSlice(sheets, config, { cache, force: true, persist: false });

  await ensureMonthlyAttendanceSheet(sheets, config, new Date(), nextAppointments, "replace", { cache });
  await ensureMonthlyAttendanceSheet(
    sheets,
    config,
    shiftMonth(new Date(), config.timezone, 1),
    nextAppointments,
    "replace",
    { cache }
  );
  logSheetsSuccess("Appointment removed from active monthly sheets.", {
    appointment,
    appointmentCount: nextAppointments.length
  });
}

export async function writeAttendanceStatus(sheets, config, entry) {
  const result = await writeAttendanceStatuses(sheets, config, [{ ...entry }]);
  return result.results?.[0] ?? null;
}

export async function writeAttendanceStatuses(sheets, config, entries) {
  if (!entries.length) {
    return { results: [], writtenEventIds: [], skippedEvents: [], conflictedEvents: [] };
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
  const writtenEventIds = [];
  const skippedEvents = [];
  const conflictedEvents = [];
  const cache = await readLocalSheetCache();

  await updateSpreadsheetMetadataCache(sheets, config, cache, false);
  await refreshOnboardingSlice(sheets, config, {
    cache,
    force: false,
    persist: false
  });

  for (const [sheetTitle, sheetEntries] of entriesBySheet.entries()) {
    const appointments = [...new Set(sheetEntries.map((entry) => entry.appointment))];
    await ensureMonthlyAttendanceSheet(sheets, config, sheetEntries[0].date, appointments, "merge", { cache });
    const liveSlice = await refreshMonthSlice(sheets, config, sheetEntries[0].date, {
      cache,
      force: true,
      persist: false
    });
    const appointmentRows = new Map(
      Object.entries(liveSlice.rowNumbersByAppointment ?? {})
    );
    const headerRow = liveSlice.headerRow;
    const data = [];

    if ((liveSlice.unexpectedAppointments?.length ?? 0) > 0) {
      conflictedEvents.push(
        ...sheetEntries.map((entry) => ({
          eventId: entry.id,
          reason: "sheet_layout_changed",
          error: `Unexpected managed rows found in ${sheetTitle}: ${liveSlice.unexpectedAppointments.join(", ")}`
        }))
      );
      continue;
    }

    for (const entry of sheetEntries) {
      const rowNumber = appointmentRows.get(entry.appointment);

      if (!rowNumber) {
        conflictedEvents.push({
          eventId: entry.id,
          reason: liveSlice.duplicateAppointments?.includes(entry.appointment)
            ? "duplicate_appointment_row"
            : "appointment_missing",
          error: `Appointment row not found for ${entry.appointment}`
        });
        continue;
      }

      const expectedDateLabel = entry.expectedDateLabel ?? getExpectedDateHeaderLabel(entry.date, config.timezone);
      const columnIndex = headerRow.findIndex((value) => value === expectedDateLabel);

      if (columnIndex === -1) {
        conflictedEvents.push({
          eventId: entry.id,
          reason: "date_column_changed",
          error: `Date column not found for ${expectedDateLabel}`
        });
        continue;
      }

      const appointmentIndex = liveSlice.snapshot.appointments.findIndex((value) => value === entry.appointment);
      const liveDay = dayOfMonth(entry.date, config.timezone);
      const liveValue = appointmentIndex === -1
        ? ""
        : String(liveSlice.snapshot.statusesByDay.get(liveDay)?.[appointmentIndex] ?? "").trim();

      if (liveValue === String(entry.status ?? "").trim()) {
        skippedEvents.push({ eventId: entry.id, reason: "noop" });
        continue;
      }

      if (liveValue !== String(entry.expectedPreviousValue ?? "").trim()) {
        conflictedEvents.push({
          eventId: entry.id,
          reason: "cell_value_changed_by_human",
          error: `Live cell changed from cached value for ${entry.appointment}`
        });
        continue;
      }

      const columnNumber = columnIndex + 1;
      const cell = `${columnNumberToLabel(columnNumber)}${rowNumber}`;
      results.push({
        appointment: entry.appointment,
        status: entry.status,
        date: entry.date,
        sheetTitle,
        cell
      });
      writtenEventIds.push(entry.id);
      data.push({
        range: `'${sheetTitle}'!${cell}`,
        values: [[entry.status]]
      });
    }

    if (data.length > 0) {
      await runGoogleSheetsRequest(`spreadsheets.values.batchUpdate:${sheetTitle}:attendanceWrite`, (signal) =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: config.spreadsheetId,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data
          }
        }, { signal })
      );
    }
  }

  const successfulEntries = entries.filter((entry) => writtenEventIds.includes(entry.id) || !entry.id);
  await persistAttendanceEntriesToLocalCache(sheets, config, successfulEntries);

  return { results, writtenEventIds, skippedEvents, conflictedEvents };
}

export async function reconcilePendingAttendanceWithSheets(sheets, config, entries, options = {}) {
  if (!entries.length) {
    return { results: [], writtenEventIds: [], skippedEvents: [], conflictedEvents: [] };
  }

  const localCache = await readLocalSheetCache();
  const previousSnapshotBundle = buildSnapshotBundleFromMonthSlices(localCache.monthSlices ?? {});
  const internalReferenceBundle = applyAttendanceEntriesToSnapshotBundle(
    previousSnapshotBundle,
    config,
    entries.map((entry) => ({
      appointment: entry.appointment,
      status: entry.status,
      date: entry.date ?? new Date(`${entry.date}T12:00:00.000Z`)
    }))
  );
  const monthTitles = [...new Set(
    entries.map((entry) => entry.targetSheetTitle ?? getMonthParts(entry.date, config.timezone).title)
  )];

  await updateSpreadsheetMetadataCache(sheets, config, localCache, options.force === true);
  // Use cached onboarding data; forced refreshes are handled by the sync cycle separately.
  await refreshOnboardingSlice(sheets, config, {
    cache: localCache,
    force: false,
    persist: false
  });

  const remoteSlices = new Map();

  for (const title of monthTitles) {
    remoteSlices.set(
      title,
      await refreshMonthSlice(sheets, config, title, {
        cache: localCache,
        force: true,
        persist: false
      })
    );
  }

  const data = [];
  const results = [];
  const writtenEventIds = [];
  const skippedEvents = [];
  const conflictedEvents = [];
  const mergedSlices = new Map();

  for (const title of monthTitles) {
    const remoteSlice = remoteSlices.get(title);
    const previousSnapshot = previousSnapshotBundle.snapshots.get(title) ?? remoteSlice.snapshot;
    const referenceSnapshot = internalReferenceBundle.snapshots.get(title) ?? previousSnapshot;
    const resolvedSnapshot = alignSnapshotToAppointments(
      remoteSlice.snapshot,
      remoteSlice.appointments,
      getDateFromMonthTitle(title) ?? new Date(),
      config.timezone
    );
    const monthEntries = entries.filter(
      (entry) => (entry.targetSheetTitle ?? getMonthParts(entry.date, config.timezone).title) === title
    );

    if ((remoteSlice.unexpectedAppointments?.length ?? 0) > 0) {
      conflictedEvents.push(
        ...monthEntries.map((entry) => ({
          eventId: entry.id,
          reason: "sheet_layout_changed",
          error: `Unexpected managed rows found in ${title}: ${remoteSlice.unexpectedAppointments.join(", ")}`
        }))
      );
      mergedSlices.set(title, {
        ...remoteSlice,
        snapshot: resolvedSnapshot
      });
      continue;
    }

    for (const entry of monthEntries) {
      const day = dayOfMonth(entry.date, config.timezone);
      const columnIndex = Number(remoteSlice.recognizedDateColumns?.[String(day)] ?? -1);
      const rowNumber = Number(remoteSlice.rowNumbersByAppointment?.[entry.appointment] ?? 0);

      if (!rowNumber) {
        conflictedEvents.push({
          eventId: entry.id,
          reason: remoteSlice.duplicateAppointments?.includes(entry.appointment)
            ? "duplicate_appointment_row"
            : "appointment_missing",
          error: `Appointment row not found for ${entry.appointment}`
        });
        continue;
      }

      if (columnIndex < 0) {
        conflictedEvents.push({
          eventId: entry.id,
          reason: "date_column_changed",
          error: `Date column not found for ${entry.expectedDateLabel ?? getExpectedDateHeaderLabel(entry.date, config.timezone)}`
        });
        continue;
      }

      const previousValue = getSnapshotCellValue(previousSnapshot, entry.appointment, day);
      const remoteValue = getSnapshotCellValue(remoteSlice.snapshot, entry.appointment, day);
      const referenceValue = getSnapshotCellValue(referenceSnapshot, entry.appointment, day);

      if (remoteValue !== previousValue) {
        if (referenceValue === remoteValue) {
          skippedEvents.push({ eventId: entry.id, reason: "noop" });
        } else {
          conflictedEvents.push({
            eventId: entry.id,
            reason: "cell_value_changed_by_human",
            error: `Live sheet changed for ${entry.appointment} on ${entry.date.toISOString()}`
          });
        }
        continue;
      }

      if (referenceValue === remoteValue) {
        skippedEvents.push({ eventId: entry.id, reason: "noop" });
        continue;
      }

      const cell = `${columnNumberToLabel(columnIndex + 1)}${rowNumber}`;
      data.push({
        range: `'${title}'!${cell}`,
        values: [[referenceValue]]
      });
      results.push({
        appointment: entry.appointment,
        status: referenceValue,
        date: entry.date,
        sheetTitle: title,
        cell
      });
      writtenEventIds.push(entry.id);
      setSnapshotCellValue(resolvedSnapshot, entry.appointment, day, referenceValue);
    }

    mergedSlices.set(title, {
      ...remoteSlice,
      snapshot: resolvedSnapshot,
      managedAreaHash: computeManagedAreaHash({
        appointments: remoteSlice.appointments,
        recognizedDateColumns: remoteSlice.recognizedDateColumns,
        statusesByDay: serializeSnapshot(resolvedSnapshot).statusesByDay
      }),
      fetchedAt: new Date().toISOString()
    });
  }

  if (data.length > 0) {
    await runGoogleSheetsRequest("spreadsheets.values.batchUpdate:reconcilePending", (signal) =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: config.spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data
        }
      }, { signal })
    );
  }

  for (const [title, slice] of mergedSlices.entries()) {
    localCache.monthSlices[title] = serializeMonthSlice(slice);
    localCache.snapshots[title] = serializeSnapshot(slice.snapshot);
  }

  localCache.updatedAt = new Date().toISOString();
  await writeLocalSheetCache(localCache);

  return { results, writtenEventIds, skippedEvents, conflictedEvents };
}

export async function ensureNextMonthSheetExists(sheets, config) {
  const cache = await readLocalSheetCache();
  const roster = await syncOnboardingRoster(sheets, config, { cache });
  logSheetsSuccess("Verified next month sheet exists.", {
    nextMonthTitle: roster.nextMonthTitle
  });
  return roster.nextMonthTitle;
}

export async function preloadAttendanceSnapshots(sheets, config, options = {}) {
  const baseDate = options.date ?? new Date();
  const targetDates = options.targetDates ?? [
    baseDate,
    shiftMonth(baseDate, config.timezone, 1)
  ];
  // Allow callers to pass in a shared cache object (e.g. from runDailySheetMaintenance)
  // to avoid a redundant readLocalSheetCache() + writeLocalSheetCache() round-trip.
  const localCache = options.cache ?? (await readLocalSheetCache());
  const structural = options.structural === true;

  await updateSpreadsheetMetadataCache(sheets, config, localCache, options.force === true);
  await refreshOnboardingSlice(sheets, config, {
    cache: localCache,
    force: options.force === true,
    persist: false
  });

  for (const date of targetDates) {
    await refreshMonthSlice(sheets, config, date, {
      cache: localCache,
      force: options.force === true,
      normalizeAliases: options.normalizeAliases === true,
      structural,
      persist: false
    });
  }

  localCache.updatedAt = new Date().toISOString();
  await writeLocalSheetCache(localCache);
  logSheetsSuccess("Preloaded active month attendance snapshots.", {
    titles: targetDates.map((date) => getMonthParts(date, config.timezone).title)
  });
  return buildSnapshotBundleFromMonthSlices(
    Object.fromEntries(
      Object.entries(localCache.monthSlices ?? {}).map(([title, slice]) => [title, deserializeMonthSlice(slice)])
    )
  );
}

/**
 * Runs all structural sheet maintenance: roster sync, monthly sheet creation, row layout,
 * formatting, protections, and full snapshot preload with alias normalisation.
 *
 * This is intentionally expensive and should only be called once a day (midnight cron).
 * Hot-path read cycles should use preloadAttendanceSnapshots({ structural: false }).
 */
export async function runDailySheetMaintenance(sheets, config) {
  const cache = await readLocalSheetCache();

  // Full onboarding + monthly sheet structural sync (row inserts, formatting, protections).
  await syncOnboardingRoster(sheets, config, { cache });

  // Force-refresh snapshots with structural writes + alias normalisation enabled.
  // Pass the same cache object to skip the redundant readLocalSheetCache() inside.
  await preloadAttendanceSnapshots(sheets, config, {
    cache,
    force: true,
    structural: true,
    normalizeAliases: true
  });

  cache.lastStructuralMaintenanceAt = new Date().toISOString();
  await writeLocalSheetCache(cache);

  logSheetsSuccess("Daily sheet maintenance completed.", {
    lastStructuralMaintenanceAt: cache.lastStructuralMaintenanceAt
  });

  return { maintenanceAt: cache.lastStructuralMaintenanceAt };
}

export async function getLastStructuralMaintenanceAt() {
  const cache = await readLocalSheetCache();
  return cache.lastStructuralMaintenanceAt ?? null;
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
  const slice = await refreshMonthSlice(sheets, config, date, { force: options.force === true });
  const summary = summarizeStatusesFromSnapshot(
    {
      synchronizedAt: slice.fetchedAt,
      snapshots: new Map([[slice.title, slice.snapshot]])
    },
    config,
    { date }
  );

  return {
    ...summary,
    synchronizedAt: slice.fetchedAt
  };
}

export async function summarizeAttendanceOptionUsage(sheets, config) {
  const cache = await readLocalSheetCache();
  await updateSpreadsheetMetadataCache(sheets, config, cache, false);
  const spreadsheet = await getSpreadsheet(sheets, config.spreadsheetId, { cache });
  const recentMonthTitleSet = new Set(
    getRecentMonthTitles(new Date(), config.timezone, ATTENDANCE_OPTION_USAGE_MONTH_WINDOW)
  );
  const monthTitles = (spreadsheet.sheets ?? [])
    .map((entry) => entry.properties?.title)
    .filter(Boolean)
    .map(parseMonthSheetTitle)
    .filter(Boolean)
    .map((entry) => entry.title)
    .filter((title) => recentMonthTitleSet.has(title));
  const counts = new Map(config.attendanceOptions.map((option) => [option, 0]));

  for (const title of monthTitles) {
    const values = await readSheetValues(sheets, config.spreadsheetId, title);
    const rows = values.slice(1);

    for (const row of rows) {
      const appointment = normalizeAppointmentLabel(row?.[0]);

      if (!appointment || isStopMarker(appointment, config.rosterStopMarkers)) {
        if (isStopMarker(appointment, config.rosterStopMarkers)) {
          break;
        }

        continue;
      }

      for (const cellValue of row.slice(1)) {
        const normalizedValue = canonicalizeAttendanceStatus(cellValue);

        if (!counts.has(normalizedValue)) {
          continue;
        }

        counts.set(normalizedValue, (counts.get(normalizedValue) ?? 0) + 1);
      }
    }
  }

  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
  );
}

export const __testing = {
  DEFAULT_BOOTSTRAP_APPOINTMENTS,
  ATTENDANCE_OPTION_USAGE_MONTH_WINDOW,
  buildQueuedAttendanceEventMetadata,
  buildManagedMonthlyRows,
  buildMonthlySheetRefreshContext,
  buildLiveManagedMonthlyRows,
  buildDateColumnMap,
  buildHeaderUpdateRequest,
  classifyAppointmentDepartment,
  createMonthSliceFromValues,
  DEPARTMENT_BUCKETS,
  getRecentMonthTitles,
  getBootstrapAppointments,
  isRetryableGoogleSheetsError,
  orderAppointmentsCanonically,
  parseAppointmentOrderingMetadata,
  parseOnboardingManagedRows,
  runGoogleSheetsRequest,
  ensureHeaderRowIfBlank,
  ensureMonthlySheetProtections,
  getExpectedDateHeaderLabel,
  getMonthParts,
  shiftMonth,
  writeMonthlySheetRows,
  writeAppointmentColumn,
  clearEnsuredMonthlySheetProtectionIds() {
    ensuredMonthlySheetProtectionIds.clear();
  }
};
