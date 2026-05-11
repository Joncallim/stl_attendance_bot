import { google } from "googleapis";
import { getDataFile } from "./dataDir.js";
import {
  readJsonFile as readJsonFileFromStore,
  writeJsonFile as writeJsonFileToStore
} from "./fileStore.js";
import { getSingaporePublicHolidaySet } from "./holidays.js";
import { ipv4HttpsAgent } from "./network.js";

const SHEET_CACHE_FILE = () => getDataFile("sheet-cache.json");
// Cached copy of conditional format rule definitions fetched from ONBOARDING's C1 area.
// Stored locally so the bot never needs to re-fetch from Google Sheets on every layout
// refresh; only re-fetched when the file is absent or via an explicit admin action.
const CONDITIONAL_FORMAT_RULES_FILE = () => getDataFile("conditional-format-rules.json");
// Module-level in-memory cache so we only hit disk once per process lifetime.
let cachedConditionalRules = undefined; // undefined = not yet loaded; null = loaded but empty
// spreadsheets.get (metadata) takes 10–109 s from this VPS under load.  Refreshing
// every 15 min means the 1-minute background cycle will hammer the API the moment the
// TTL expires, spiralling into consecutive timeouts.  45 min keeps the data fresh
// enough for structural decisions while cutting the call frequency by 3×.
const SPREADSHEET_METADATA_TTL_MS = 45 * 60 * 1000;
const ONBOARDING_SLICE_TTL_MS = 2 * 60 * 1000;
const MONTH_SLICE_TTL_MS = 60 * 1000;
const DEFAULT_MAX_MANAGED_ROWS = 200;
// Extra rows beyond the known appointment count: stop-marker row + blank-row drift tolerance.
const MANAGED_ROW_BUFFER = 5;
// Monthly sheets have at most 1 appointment col + 31 day cols = 32 cols; cap at 33 for safety.
// Column 33 in A1 notation = "AH".
const MAX_MONTH_SHEET_COLUMN_LABEL = "AH";
const GOOGLE_SHEETS_VERIFY_WRITES = process.env.GOOGLE_SHEETS_VERIFY_WRITES === "true";
const DEFAULT_BOOTSTRAP_APPOINTMENTS = ["USER1", "USER2", "USER3"];
const ATTENDANCE_OPTION_USAGE_MONTH_WINDOW = 2;
const GOOGLE_SHEETS_MAX_RETRY_ATTEMPTS = 5;
const GOOGLE_SHEETS_INITIAL_RETRY_DELAY_MS = 2000;
const GOOGLE_SHEETS_MIN_RETRY_DELAY_MS = 1500;
const GOOGLE_SHEETS_MAX_RETRY_DELAY_MS = 32000;
const GOOGLE_SHEETS_REQUEST_TIMEOUT_MS = 15000;
// Row insertions/deletions (batchUpdate:rows) are processed server-side by Google and can
// take >15 s under load regardless of payload size. Targeted increase for this operation only.
const GOOGLE_SHEETS_ROW_STRUCTURE_TIMEOUT_MS = 30000;
const GOOGLE_SHEETS_SLOW_REQUEST_THRESHOLD_MS = 5000;
// Minimum gap between consecutive Sheets API calls.
// Google Sheets enforces a quota of 60 read/write requests per minute per user
// (service account). At 1000 ms spacing the semaphore queue fires at most
// ~60 req/min, staying safely within that limit. Values below ~1000 ms risk
// silently exceeding the quota and triggering throttling that manifests as
// 15-second hangs rather than explicit 429 errors.
const GOOGLE_SHEETS_INTER_REQUEST_DELAY_MS = 1000;
// When ≥3 consecutive timeouts are detected, slow the inter-request gap further
// to give the API time to recover before the next request is queued.
const GOOGLE_SHEETS_INTER_REQUEST_DELAY_CONGESTED_MS = 3000;
// Number of consecutive timeouts that triggers congestion mode.
const GOOGLE_SHEETS_CONGESTION_THRESHOLD = 3;
// Dark background applied to pre-join-date cells for appointments inserted mid-month.
const JOIN_DATE_BLACKOUT_COLOUR = { red: 0.15, green: 0.15, blue: 0.15 };
const runtimeSheetContext = new WeakMap();
// Process-level spreadsheet cache: shared across all cache objects that use the same
// sheets client, so different code paths that each create a fresh cache object from
// disk can still reuse the already-fetched spreadsheet within the metadata TTL window.
// Keyed by the sheets client object itself (WeakMap) so tests with fresh client
// instances are always isolated.
const processSpreadsheetCache = new WeakMap();
let activeGoogleSheetsRequests = 0;
// Tracks consecutive timeout failures across all queued requests. Drives
// congestion detection: when this hits GOOGLE_SHEETS_CONGESTION_THRESHOLD,
// the inter-request delay is increased to GOOGLE_SHEETS_INTER_REQUEST_DELAY_CONGESTED_MS.
let consecutiveTimeouts = 0;

// Semaphore: serialise all outgoing Sheets API calls so only one is in-flight
// at a time. Google Sheets throttles concurrent requests from the same service
// account token, causing cascading timeouts when two requests run together.
let sheetsSemaphorePromise = Promise.resolve();

function acquireSheetsSemaphore(fn) {
  const next = sheetsSemaphorePromise.then(() => fn());
  // Allow the queue to drain even if fn() rejects, then wait the inter-request
  // delay so rapid bursts during startup don't trigger Google's token throttle.
  // Use a longer delay when consecutive timeouts indicate API congestion.
  sheetsSemaphorePromise = next
    .catch(() => {})
    .then(() => {
      const delay = consecutiveTimeouts >= GOOGLE_SHEETS_CONGESTION_THRESHOLD
        ? GOOGLE_SHEETS_INTER_REQUEST_DELAY_CONGESTED_MS
        : GOOGLE_SHEETS_INTER_REQUEST_DELAY_MS;
      return new Promise((resolve) => setTimeout(resolve, delay));
    });
  return next;
}

function logSheetsSuccess(message, details = null) {
  const ts = new Date().toISOString();
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[${ts}] [Sheets] ${message}${suffix}`);
}

function logSheetsWarn(message, details = null) {
  const ts = new Date().toISOString();
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.warn(`[${ts}] [Sheets] ${message}${suffix}`);
}

const VERBOSE_LOGGING = process.env.VERBOSE === "true";
function logSheetsVerbose(message, details = null) {
  if (!VERBOSE_LOGGING) return;
  const ts = new Date().toISOString();
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[${ts}] [Sheets/Verbose] ${message}${suffix}`);
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

/**
 * Reconciles the appointments currently in the ONBOARDING sheet against the
 * canonical list from settings.yaml.
 *
 * - Appointments whose normalised identity (trim + toUpperCase) matches a
 *   configured appointment are renamed to the canonical settings.yaml name and
 *   placed first, in settings.yaml order.
 * - Appointments that do not match any configured appointment are pushed to the
 *   bottom of the list unchanged.
 * - If configuredAppointments is empty the original list is returned as-is.
 *
 * Returns { reconciled: string[], changed: boolean }.
 */
function reconcileOnboardingWithConfig(onboardingAppointments, configuredAppointments) {
  if (configuredAppointments.length === 0) {
    return { reconciled: onboardingAppointments, changed: false };
  }

  // Map: normalised identity → canonical name from settings.yaml
  const canonicalByIdentity = new Map(
    configuredAppointments.map((name) => [normalizeAppointmentIdentity(name), name])
  );

  // Partition ONBOARDING appointments into matched and unmatched.
  // De-duplicate matched entries by identity (first wins).
  const matchedIdentities = new Set();
  const unmatched = [];

  for (const appt of onboardingAppointments) {
    const identity = normalizeAppointmentIdentity(appt);
    if (canonicalByIdentity.has(identity)) {
      matchedIdentities.add(identity);
    } else {
      unmatched.push(appt);
    }
  }

  // Reconciled = configured (in yaml order, only those that matched) + unmatched at bottom.
  const reconciled = [
    ...configuredAppointments.filter((name) =>
      matchedIdentities.has(normalizeAppointmentIdentity(name))
    ),
    ...unmatched
  ];

  const changed =
    reconciled.length !== onboardingAppointments.length ||
    reconciled.some((name, i) => name !== onboardingAppointments[i]);

  return { reconciled, changed };
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

/**
 * Extract a human-readable detail string from a Google API error.
 * The googleapis library wraps the HTTP response body inside error.response.data;
 * that contains the canonical Google error object with a message, status, and
 * an optional errors array with per-field detail.
 *
 * Falls back gracefully so it never throws.
 */
function describeGoogleApiError(error) {
  try {
    const gError = error?.response?.data?.error;
    if (!gError) {
      return error?.message ?? String(error);
    }

    const status  = gError.status  ?? error?.response?.status ?? error?.status ?? "?";
    const message = gError.message ?? error.message ?? "unknown error";
    const details = (gError.errors ?? [])
      .map((e) => `${e.reason ?? ""}${e.message ? `: ${e.message}` : ""}`)
      .filter(Boolean)
      .join("; ");

    return details
      ? `[${status}] ${message} (${details})`
      : `[${status}] ${message}`;
  } catch {
    return error?.message ?? String(error);
  }
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

async function runGoogleSheetsRequestQueued(operation, request, options = {}) {
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

        // Successful request: clear the congestion counter.
        consecutiveTimeouts = 0;

        const doneTag = durationMs >= GOOGLE_SHEETS_SLOW_REQUEST_THRESHOLD_MS ? "SLOW" : "DONE";
        console.log(
          `[${new Date().toISOString()}] [Sheets] ${doneTag} ${operation} in ${durationMs}ms`
        );

        return result;
      } catch (error) {
        // Track consecutive timeouts for congestion detection.
        if (error?.isTimeout === true) {
          consecutiveTimeouts += 1;
          if (consecutiveTimeouts >= GOOGLE_SHEETS_CONGESTION_THRESHOLD) {
            logFn(
              `[${new Date().toISOString()}] [Sheets] CONGESTION detected` +
              ` (${consecutiveTimeouts} consecutive timeouts) — inter-request delay raised to` +
              ` ${GOOGLE_SHEETS_INTER_REQUEST_DELAY_CONGESTED_MS}ms`
            );
          }
        } else {
          consecutiveTimeouts = 0;
        }

        if (!isRetryableGoogleSheetsError(error) || attempt >= maxAttempts) {
          const durationMs = Date.now() - startTime;
          logFn(
            `[${new Date().toISOString()}] [Sheets] FAIL ${operation} after ${durationMs}ms` +
            ` (attempt ${attempt}/${maxAttempts}): ${describeGoogleApiError(error)}`
          );
          throw error;
        }

        const delayMs = getGoogleSheetsRetryDelay(attempt, options);
        logFn(
          `[${new Date().toISOString()}] [Sheets] retry ${attempt}/${maxAttempts}` +
          ` for ${operation} after ${delayMs}ms: ${describeGoogleApiError(error)}`
        );
        await sleepFn(delayMs);
      }
    }

    throw new Error(`Google Sheets request exhausted retries for ${operation}`);
  } finally {
    activeGoogleSheetsRequests -= 1;
  }
}

function runGoogleSheetsRequest(operation, request, options = {}) {
  // Route through the semaphore so at most one Sheets API request is in-flight
  // at any time. This prevents Google from throttling concurrent calls from the
  // same service account token, which manifests as cascading 15s timeouts.
  return acquireSheetsSemaphore(() => runGoogleSheetsRequestQueued(operation, request, options));
}

/**
 * Returns the maximum row number to use when reading a managed sheet range.
 * When the appointment count is known, cap at (count + header row + buffer).
 * Falls back to DEFAULT_MAX_MANAGED_ROWS when count is unknown.
 */
function managedRowLimit(knownAppointmentCount) {
  if (Number.isInteger(knownAppointmentCount) && knownAppointmentCount > 0) {
    return 1 + knownAppointmentCount + MANAGED_ROW_BUFFER; // 1 header + appointments + buffer
  }

  return DEFAULT_MAX_MANAGED_ROWS;
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
  // Check process-level cache first. This is keyed on the sheets client object so
  // different code paths that create separate cache objects from disk (and therefore
  // have separate WeakMap entries in runtimeSheetContext) can still share a single
  // spreadsheets.get result within the metadata TTL window.
  if (options.force !== true) {
    const processEntry = processSpreadsheetCache.get(sheets);
    if (processEntry?.data && isSliceFresh(processEntry.fetchedAt, SPREADSHEET_METADATA_TTL_MS)) {
      // Populate the per-object runtime context so subsequent calls within the same
      // code path skip the WeakMap lookup too.
      const runtimeContext = getRuntimeSheetContext(options.cache);
      if (runtimeContext && !runtimeContext.spreadsheet) {
        runtimeContext.spreadsheet = processEntry.data;
      }
      return processEntry.data;
    }
  }

  const runtimeContext = getRuntimeSheetContext(options.cache);

  if (runtimeContext?.spreadsheet && options.force !== true) {
    return runtimeContext.spreadsheet;
  }

  // spreadsheets.get consistently takes 10–15 s from this VPS. Use a longer per-call
  // timeout than the default 15 s so borderline calls don't fail on every cycle.
  const response = await runGoogleSheetsRequest("spreadsheets.get", (signal) =>
    sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
      fields: "spreadsheetId,sheets(properties,protectedRanges,conditionalFormats)"
    }, { signal })
  , { timeoutMs: 20000 });
  const spreadsheet = response.data;

  if (runtimeContext) {
    runtimeContext.spreadsheet = spreadsheet;
  }
  // Populate the process-level cache so sibling code paths share this result.
  processSpreadsheetCache.set(sheets, { data: spreadsheet, fetchedAt: new Date().toISOString() });

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
      const updatedSpreadsheet = {
        ...runtimeContext.spreadsheet,
        sheets: [
          ...(runtimeContext.spreadsheet.sheets ?? []),
          addedSheet
        ]
      };
      runtimeContext.spreadsheet = updatedSpreadsheet;
      // Keep the process-level cache in sync so other code paths see the new sheet.
      const processEntry = processSpreadsheetCache.get(sheets);
      if (processEntry?.data) {
        processSpreadsheetCache.set(sheets, { ...processEntry, data: updatedSpreadsheet });
      }
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
  const values = await readSheetValues(sheets, spreadsheetId, title, `A1:${MAX_MONTH_SHEET_COLUMN_LABEL}1`);
  const headerRow = (values[0] ?? []).map((value) => String(value ?? "").trim());
  const hasHeader = headerRow.some(Boolean);
  return hasHeader ? headerRow : fallbackHeader;
}

async function writeAppointmentColumn(
  sheets,
  spreadsheetId,
  title,
  appointments,
  options = {}
) {
  const values = await readSheetValues(sheets, spreadsheetId, title, `A1:B${managedRowLimit(appointments.length)}`);
  const parsed = parseOnboardingManagedRows(values, options.stopMarkers ?? []);
  const existingCodesByIdentity = new Map(
    parsed.managedRows.map((row) => [normalizeAppointmentIdentity(row.appointment), row.secretCode])
  );
  const rows = appointments.map((appointment) => [
    appointment,
    existingCodesByIdentity.get(normalizeAppointmentIdentity(appointment)) ?? ""
  ]);
  // Pass the values we already read so writeOnboardingRows skips its own read of the same range.
  await writeOnboardingRows(sheets, spreadsheetId, title, rows, options.stopMarkers ?? [], { ...options, preloadedValues: values });
}

async function readMonthlySheetRows(
  sheets,
  spreadsheetId,
  title,
  headerLength,
  stopMarkers,
  canonicalAppointments = []
) {
  const rowLimit = managedRowLimit(canonicalAppointments.length);
  const values = await readSheetValues(
    sheets,
    spreadsheetId,
    title,
    `A2:${columnNumberToLabel(headerLength)}${rowLimit}`
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

  if (VERBOSE_LOGGING) {
    const insertOps = operations.filter((op) => op.type === "insert");
    const deleteOps = operations.filter((op) => op.type === "delete");
    logSheetsVerbose(`[${title}] Row plan: ${insertOps.length} insertion${insertOps.length !== 1 ? "s" : ""}, ${deleteOps.length} deletion${deleteOps.length !== 1 ? "s" : ""}`);
    if (operations.length > 0) {
      const opDescriptions = operations.map((op) => {
        const name = op.type === "insert"
          ? (rows[op.index]?.[0] ?? "?")
          : (existingRows[op.index]?.[0] ?? "?");
        return `${op.type.toUpperCase()} row ${op.index + 1 + 1} (${name})`;
      });
      logSheetsVerbose(`[${title}] ${opDescriptions.join(", ")}`);
    }
  }

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
      }, { signal }),
      // maxAttempts:2 — if the API is completely unresponsive, fail in ~62s rather than
      // burning 5×30s=150s. The midnight cron or next Sync Roster will retry.
      { timeoutMs: GOOGLE_SHEETS_ROW_STRUCTURE_TIMEOUT_MS, maxAttempts: 2 }
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

const SHEET_FONT_FAMILY = "Roboto";

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
          values: header.map((value, colIndex) => ({
            userEnteredValue: {
              stringValue: String(value ?? "")
            },
            userEnteredFormat: {
              textFormat: {
                fontFamily: SHEET_FONT_FAMILY,
                // Column A ("Appointment") is not a date header — only columns 1+ are bolded.
                bold: colIndex > 0
              }
            }
          }))
        }
      ],
      fields: "userEnteredValue,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.bold"
    }
  };
}

async function writeOnboardingRows(sheets, spreadsheetId, title, rows, stopMarkers = [], options = {}) {
  const sheet = await getSheetByTitle(sheets, spreadsheetId, title, options);
  // Accept pre-read values from the caller (e.g. writeAppointmentColumn) to avoid a duplicate read.
  const values = options.preloadedValues ??
    await readSheetValues(sheets, spreadsheetId, title, `A1:B${managedRowLimit(rows.length)}`);
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
      }, { signal }),
      { timeoutMs: GOOGLE_SHEETS_ROW_STRUCTURE_TIMEOUT_MS }
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
  await verifyBatchWrite(sheets, spreadsheetId, data);
}

function buildAttendanceValidationRequest(sheetId, headerLength, options, rowLimit = DEFAULT_MAX_MANAGED_ROWS) {
  return {
    setDataValidation: {
      range: {
        sheetId,
        startRowIndex: 1,
        startColumnIndex: 1,
        endRowIndex: rowLimit,
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

async function buildDisabledDayFormattingRequests(sheetId, date, timezone, rowLimit = DEFAULT_MAX_MANAGED_ROWS) {
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
          endRowIndex: rowLimit,
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

/**
 * Returns the cached conditional format rule definitions, loading from disk on
 * first call.  Returns null when no rules have been saved yet.
 *
 * Each element in the returned array is a rule object with either a
 * `booleanRule` or `gradientRule` key — identical to the Google Sheets API
 * ConditionalFormatRule shape, but WITHOUT the `ranges` field (those are
 * injected per-sheet at apply time).
 */
async function loadConditionalFormattingRules() {
  if (cachedConditionalRules !== undefined) {
    return cachedConditionalRules;
  }

  const saved = await readJsonFile(CONDITIONAL_FORMAT_RULES_FILE(), null);

  if (!saved?.rules || saved.rules.length === 0) {
    cachedConditionalRules = null;
    return null;
  }

  cachedConditionalRules = saved.rules;
  return cachedConditionalRules;
}

async function applyMonthlySheetLayout(sheets, spreadsheetId, sheetId, date, header, options, timezone, rowCount = 0, existingProtections = [], existingConditionalFormats = []) {
  const rowLimit = managedRowLimit(rowCount);

  // Remove any bot-managed protections that were added by earlier versions.
  // Protections are identified by the "attendance-bot:" description prefix.
  const removeProtectionRequests = existingProtections
    .filter((p) => String(p.description ?? "").startsWith("attendance-bot:") && Number.isInteger(p.protectedRangeId))
    .map((p) => ({ deleteProtectedRange: { protectedRangeId: p.protectedRangeId } }));

  // Load saved conditional format rule definitions (fetched once from ONBOARDING
  // and cached in conditional-format-rules.json).  Null means no rules saved yet.
  const conditionalRules = await loadConditionalFormattingRules();

  // Delete all existing conditional format rules on this sheet before re-adding.
  // Rules are indexed from 0; delete in reverse order so earlier indices stay valid.
  const deleteConditionalFormatRequests = existingConditionalFormats
    .map((_, index) => existingConditionalFormats.length - 1 - index)
    .map((index) => ({ deleteConditionalFormatRule: { sheetId, index } }));

  // Apply each saved rule to the full attendance data range (column B onwards,
  // rows 2+).  Each rule is added at position 0 so they end up in the same order
  // as the original — the last rule added becomes index 0, which inverts the list,
  // so we reverse before adding.
  const attendanceRange = {
    sheetId,
    startRowIndex: 1,       // row 2 (skip header)
    startColumnIndex: 1,    // column B (first day/data column on monthly sheets)
    endRowIndex: rowLimit,
    endColumnIndex: header.length
  };

  const addConditionalFormatRequests = conditionalRules
    ? [...conditionalRules].reverse().map((rule) => ({
        addConditionalFormatRule: {
          rule: { ...rule, ranges: [attendanceRange] },
          index: 0
        }
      }))
    : [];

  const requests = [
    ...removeProtectionRequests,
    ...deleteConditionalFormatRequests,
    // Apply consistent font family to the entire managed range first, so the header
    // update below can layer bold on top without needing to repeat the font name.
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: rowLimit,
          startColumnIndex: 0,
          endColumnIndex: header.length
        },
        cell: {
          userEnteredFormat: {
            textFormat: { fontFamily: SHEET_FONT_FAMILY }
          }
        },
        fields: "userEnteredFormat.textFormat.fontFamily"
      }
    },
    buildHeaderUpdateRequest(sheetId, header),
    buildAttendanceValidationRequest(sheetId, header.length, options, rowLimit),
    ...(await buildDisabledDayFormattingRequests(sheetId, date, timezone, rowLimit)),
    ...addConditionalFormatRequests,
    // Auto-fit column A width to the longest appointment name on each layout refresh.
    {
      autoResizeDimensions: {
        dimensions: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: 0,
          endIndex: 1
        }
      }
    }
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

async function ensureHeaderRowIfBlank(sheets, spreadsheetId, title, header) {
  const values = await readSheetValues(sheets, spreadsheetId, title, `A1:${MAX_MONTH_SHEET_COLUMN_LABEL}1`);
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

  // Existing protections and conditional formats on the sheet — passed to
  // applyMonthlySheetLayout so it can issue deleteProtectedRange and
  // deleteConditionalFormatRule requests in the same batchUpdate.
  const existingProtections = sheet.protectedRanges ?? [];
  const existingConditionalFormats = sheet.conditionalFormats ?? [];

  if (ensuredSheet.created) {
    await applyMonthlySheetLayout(
      sheets,
      config.spreadsheetId,
      sheet.properties.sheetId,
      date,
      defaultHeader,
      config.attendanceOptions,
      config.timezone,
      appointments.length,
      [], // new sheet has no protections to remove
      []  // new sheet has no conditional formats to remove
    );
    monthlySheetValues = [defaultHeader];
  } else {
    monthlySheetValues = await readSheetValues(sheets, config.spreadsheetId, title, `A1:${MAX_MONTH_SHEET_COLUMN_LABEL}${managedRowLimit(appointments.length)}`);
    const existingHeader = getHeaderRowFromValues(monthlySheetValues, []);

    if (existingHeader.length === 0) {
      await writeHeaderRow(sheets, config.spreadsheetId, title, defaultHeader);
      monthlySheetValues = [defaultHeader, ...monthlySheetValues.slice(1)];
    }

    // Structural sync ("replace" mode), explicit applyLayout, or layoutOnly flag: re-apply
    // layout so that data validation dropdowns and weekend/holiday greying are always
    // up-to-date on existing sheets, not just new ones.
    // layoutOnly is used for the previous month where we want formatting refreshed but must
    // never touch row structure (avoids row-insert timeouts that block current/next months).
    if (mode === "replace" || options.applyLayout === true || options.layoutOnly === true) {
      const layoutHeader = getHeaderRowFromValues(monthlySheetValues, defaultHeader);
      await applyMonthlySheetLayout(
        sheets,
        config.spreadsheetId,
        sheet.properties.sheetId,
        date,
        layoutHeader,
        config.attendanceOptions,
        config.timezone,
        appointments.length,
        existingProtections,       // remove any lingering bot-managed protections
        existingConditionalFormats // replace any stale conditional format rules
      );
    }
  }

  // layoutOnly: layout applied above; skip all row reads/writes.
  // Used for the previous month to avoid row-structure API calls that can timeout
  // and abort processing of the current and next month.
  if (options.layoutOnly === true) {
    logSheetsSuccess(`[${title}] Layout refreshed (layout-only — row structure preserved).`);
    return { title, appointments: [...appointments], layoutOnly: true };
  }

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

  if (VERBOSE_LOGGING) {
    const sheetAppointmentSet = new Set(existingAppointments.appointments);
    const preferredSet = new Set(preferredAppointments);
    const missingFromSheet = preferredAppointments.filter((a) => !sheetAppointmentSet.has(a));
    const notInOnboarding = existingAppointments.appointments.filter((a) => !preferredSet.has(a));
    logSheetsVerbose(`[${title}] ONBOARDING: ${preferredAppointments.length} rows. Sheet: ${existingAppointments.appointments.length} rows.`);
    logSheetsVerbose(`[${title}] Missing from sheet: ${missingFromSheet.length > 0 ? missingFromSheet.join(", ") : "(none)"}`);
    logSheetsVerbose(`[${title}] In sheet but not ONBOARDING: ${notInOnboarding.length > 0 ? notInOnboarding.join(", ") : "(none)"}`);
  }

  // Duplicate appointments are a hard block in any mode: the Map lookup in
  // buildManagedMonthlyRows would silently drop one duplicate's attendance data.
  if ((liveSlice.duplicateAppointments?.length ?? 0) > 0) {
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

  // In "replace" mode (structural sync), unexpected appointments are not a blocker —
  // the rebuild will drop them and write only the canonical ONBOARDING list.
  // In "merge" mode, block as before: merging unexpected rows has undefined semantics.
  if ((liveSlice.unexpectedAppointments?.length ?? 0) > 0 && mode !== "replace") {
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

  if ((liveSlice.unexpectedAppointments?.length ?? 0) > 0) {
    logSheetsWarn(`[${title}] Structural sync: removing ${liveSlice.unexpectedAppointments.length} unexpected row(s) not in ONBOARDING.`, {
      removed: liveSlice.unexpectedAppointments
    });
  }

  const { nextAppointments, nextRows } = buildManagedMonthlyRows({
    preferredAppointments,
    requestedAppointments: appointments,
    existingAppointments: existingAppointments.appointments,
    existingRows,
    headerLength: header.length,
    mode
  });

  // Detect and log when the row order in the month sheet differs from ONBOARDING
  // (pure reorder — no inserts or deletes). The rows ARE rewritten correctly via
  // value-swap in writeMonthlySheetRows; this log just makes it visible.
  const orderMismatch = existingAppointments.appointments.length === nextAppointments.length &&
    existingAppointments.appointments.some((apt, i) => apt !== nextAppointments[i]);
  if (orderMismatch) {
    logSheetsSuccess(`[${title}] Row order differs from ONBOARDING — resorting rows to canonical order.`);
  }

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

  // Join-date blackout: when new appointments are inserted into the current month
  // mid-month, shade the date columns before their join day with a dark background
  // so it's visually clear those days predate their enrolment.
  // Only applies to the current month (future months have no past days; previous
  // month uses layoutOnly and never reaches this point).
  const thisMonthTitle = getMonthParts(new Date(), config.timezone).title;

  if (title === thisMonthTitle) {
    const today = dayOfMonth(new Date(), config.timezone);

    if (today > 1) {
      const existingApptSet = new Set(existingAppointments.appointments);
      const newAppts = nextAppointments.filter((apt) => !existingApptSet.has(apt));

      if (newAppts.length > 0) {
        const dateColMap = buildDateColumnMap(header, date, config.timezone);
        const startCol = dateColMap.get(1);
        const endCol = dateColMap.get(today - 1); // last day to shade (inclusive)

        if (startCol !== undefined && endCol !== undefined) {
          const blackoutRequests = newAppts.map((apt) => {
            const rowIndex = nextAppointments.indexOf(apt) + 1; // 0-indexed; +1 skips header row
            return {
              repeatCell: {
                range: {
                  sheetId: sheet.properties.sheetId,
                  startRowIndex: rowIndex,
                  endRowIndex: rowIndex + 1,
                  startColumnIndex: startCol,
                  endColumnIndex: endCol + 1 // exclusive
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: JOIN_DATE_BLACKOUT_COLOUR
                  }
                },
                fields: "userEnteredFormat.backgroundColor"
              }
            };
          });

          await runGoogleSheetsRequest(
            `spreadsheets.batchUpdate:${sheet.properties.sheetId}:joinBlackout`,
            (signal) => sheets.spreadsheets.batchUpdate({
              spreadsheetId: config.spreadsheetId,
              requestBody: { requests: blackoutRequests }
            }, { signal })
          );

          logSheetsSuccess(`[${title}] Join-date blackout applied.`, {
            appointments: newAppts,
            daysBlanked: today - 1
          });
        }
      }
    }
  }

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
    snapshots: { ...(cache?.snapshots ?? {}) }
  };

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
  // Use a cached appointment count as the row hint when available (stale cache is fine as an upper bound).
  const cachedCount = cache.onboardingSlice?.appointments?.length ?? 0;
  const values = await readSheetValues(sheets, config.spreadsheetId, title, `A1:B${managedRowLimit(cachedCount)}`);
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
  const prevTitle = getMonthParts(shiftMonth(baseDate, timezone, -1), timezone).title;
  const currentTitle = getMonthParts(baseDate, timezone).title;
  const nextTitle = getMonthParts(shiftMonth(baseDate, timezone, 1), timezone).title;
  return targetTitle === prevTitle || targetTitle === currentTitle || targetTitle === nextTitle;
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

  // Single read covers both header and existing row data — avoids a separate readHeaderRow call.
  const defaultHeader = getDefaultHeaderRow(date, config.timezone);
  const rowLimit = managedRowLimit(canonicalAppointments.length);
  const fullValues = await readSheetValues(
    sheets, config.spreadsheetId, title,
    `A1:${MAX_MONTH_SHEET_COLUMN_LABEL}${rowLimit}`
  );
  const header = getHeaderRowFromValues(fullValues, defaultHeader);
  const existingRows = buildLiveManagedMonthlyRows(
    fullValues, header.length, config.rosterStopMarkers, canonicalAppointments
  ).map((entry) => entry.row);

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

  // The caller (preloadAttendanceSnapshots) always refreshes onboarding into the cache
  // before calling refreshMonthSlice for each month. Passing force:true here would
  // re-read ONBOARDING from the API on every month iteration — wasteful.
  const onboardingSlice = await refreshOnboardingSlice(sheets, config, {
    cache,
    force: false,
    persist: false
  });
  // Structural ops (sheet creation, row sync, layout, protections) are expensive.
  // Only run when explicitly requested (e.g. runDailySheetMaintenance or admin actions).
  // Previous month uses layoutOnly to avoid row-structure changes on historical data.
  if (options.structural === true && isManagedMonthlyDate(date, config.timezone)) {
    const prevTitle = getMonthParts(shiftMonth(new Date(), config.timezone, -1), config.timezone).title;
    const isPrevMonth = getMonthParts(date, config.timezone).title === prevTitle;
    await ensureMonthlyAttendanceSheet(
      sheets,
      config,
      date,
      onboardingSlice.appointments,
      "replace",
      { cache, ...(isPrevMonth ? { layoutOnly: true } : {}) }
    );
  }
  const rowLimit = managedRowLimit(onboardingSlice.appointments.length);
  const values = await readSheetValues(sheets, config.spreadsheetId, title, `A1:${MAX_MONTH_SHEET_COLUMN_LABEL}${rowLimit}`);
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

/**
 * After a batchUpdate, reads back each written range and compares cell-by-cell.
 * Only active when GOOGLE_SHEETS_VERIFY_WRITES=true. Logs warnings on mismatch.
 * Returns { ok, discrepancies } where discrepancies is an array of { range, cell, expected, actual }.
 */
async function verifyBatchWrite(sheets, spreadsheetId, writes, options = {}) {
  if (!GOOGLE_SHEETS_VERIFY_WRITES) {
    return { ok: true, discrepancies: [] };
  }

  const logFn = options.logFn ?? console.warn;
  const discrepancies = [];

  // Fetch all written ranges in a single batchGet instead of N individual reads.
  const ranges = writes.map((w) => w.range);
  const batchResponse = await runGoogleSheetsRequest(
    `spreadsheets.values.batchGet:verify:${ranges.length}range(s)`,
    (signal) => sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges }, { signal })
  );
  const valueRanges = batchResponse.data.valueRanges ?? [];

  for (let i = 0; i < writes.length; i++) {
    const actual = valueRanges[i]?.values ?? [];
    const expected = writes[i].values ?? [];

    for (let r = 0; r < expected.length; r++) {
      for (let c = 0; c < (expected[r] ?? []).length; c++) {
        const exp = String(expected[r][c] ?? "").trim();
        const act = String((actual[r] ?? [])[c] ?? "").trim();

        if (exp !== act) {
          discrepancies.push({ range: writes[i].range, cell: `[${r}][${c}]`, expected: exp, actual: act });
        }
      }
    }
  }

  if (discrepancies.length > 0) {
    const detail = discrepancies
      .map((d) => `${d.range}${d.cell}: wrote "${d.expected}" but read "${d.actual}"`)
      .join("; ");
    logFn(`[${new Date().toISOString()}] [Sheets] VERIFY MISMATCH (${discrepancies.length} cell(s)): ${detail}`);
  } else {
    console.log(`[${new Date().toISOString()}] [Sheets] VERIFY OK — ${writes.length} write(s) confirmed`);
  }

  return { ok: discrepancies.length === 0, discrepancies };
}

async function readSheetValues(sheets, spreadsheetId, title, range = `A1:${MAX_MONTH_SHEET_COLUMN_LABEL}${DEFAULT_MAX_MANAGED_ROWS}`) {
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
  // Use the already-populated metadata cache (sheetIdsByTitle) to avoid a
  // second spreadsheets.get call — updateSpreadsheetMetadataCache already
  // fetched the spreadsheet and stored all sheet IDs in the metadata.
  const metadata = await updateSpreadsheetMetadataCache(sheets, config, cache, false);
  const currentMonthTitle = getMonthParts(new Date(), config.timezone).title;

  if (Number.isInteger(metadata.sheetIdsByTitle?.[currentMonthTitle])) {
    return (
      await readAppointmentColumn(
        sheets,
        config.spreadsheetId,
        currentMonthTitle,
        config.rosterStopMarkers
      )
    ).appointments;
  }

  // Current month sheet does not exist yet — find the most recent month sheet
  // from the metadata keys to use as a bootstrap source.
  const latestMonthSheet = Object.keys(metadata.sheetIdsByTitle ?? {})
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
  // Use sheetIdsByTitle from the metadata cache instead of calling getSpreadsheet
  // again through getSheetByTitle — updateSpreadsheetMetadataCache already fetched it.
  const metadata = await updateSpreadsheetMetadataCache(sheets, config, cache, false);

  if (!Number.isInteger(metadata.sheetIdsByTitle?.[currentMonthTitle])) {
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
    // Sort before writing the stop-marker fix so only ONE write is needed.
    // Writing unsorted then sorting separately causes two batchUpdate calls,
    // doubling the quota usage and timeout risk.
    const sortedForStopMarker = orderAppointmentsCanonically(onboardingSlice.appointments);
    await writeAppointmentColumn(
      sheets,
      config.spreadsheetId,
      title,
      sortedForStopMarker,
      { trimTrailingRows: true, stopMarkers: config.rosterStopMarkers, cache }
    );
    onboardingSlice = await refreshOnboardingSlice(sheets, config, {
      cache,
      force: true,
      persist: false
    });
  }
  // Step 1: Reconcile with settings.yaml configured appointments when available;
  // otherwise fall back to the canonical pattern-based sort.
  console.log(`[Sync] Step 1/4: Sorting ONBOARDING column A to canonical order…`);
  const rawOnboardingAppointments = onboardingSlice.appointments;

  if ((config.configuredAppointments ?? []).length > 0) {
    // settings.yaml defines the canonical order.  Rename matching appointments
    // to their settings.yaml name; push non-matching ones to the bottom.
    const { reconciled, changed } = reconcileOnboardingWithConfig(
      rawOnboardingAppointments,
      config.configuredAppointments
    );

    if (changed) {
      logSheetsSuccess(
        `[ONBOARDING] Reconciling with settings.yaml: ${reconciled.length} appointments ` +
        `(${reconciled.length - rawOnboardingAppointments.filter((a) =>
          config.configuredAppointments.some(
            (c) => normalizeAppointmentIdentity(c) === normalizeAppointmentIdentity(a)
          )
        ).length} unmatched moved to bottom).`
      );
      await writeAppointmentColumn(
        sheets,
        config.spreadsheetId,
        title,
        reconciled,
        { trimTrailingRows: true, stopMarkers: config.rosterStopMarkers, cache }
      );
      onboardingSlice = await refreshOnboardingSlice(sheets, config, {
        cache,
        force: true,
        persist: false
      });
    } else {
      console.log(`[Sync] Step 1/4: ONBOARDING already consistent with settings.yaml (${rawOnboardingAppointments.length} appointments).`);
    }
  } else {
    // No configured appointments — fall back to pattern-based canonical sort.
    const sortedOnboardingAppointments = orderAppointmentsCanonically(rawOnboardingAppointments);
    const orderChanged = rawOnboardingAppointments.some(
      (apt, i) => apt !== sortedOnboardingAppointments[i]
    );

    if (orderChanged) {
      logSheetsSuccess(`[ONBOARDING] Normalising row order (${rawOnboardingAppointments.length} appointments).`);
      await writeAppointmentColumn(
        sheets,
        config.spreadsheetId,
        title,
        sortedOnboardingAppointments,
        { trimTrailingRows: true, stopMarkers: config.rosterStopMarkers, cache }
      );
      onboardingSlice = await refreshOnboardingSlice(sheets, config, {
        cache,
        force: true,
        persist: false
      });
    } else {
      console.log(`[Sync] Step 1/4: ONBOARDING already in canonical order (${rawOnboardingAppointments.length} appointments).`);
    }
  }

  const onboardingAppointments = onboardingSlice.appointments;
  logSheetsVerbose(`syncOnboardingRoster: ONBOARDING has ${onboardingAppointments.length} appointments`);
  const driftDetected =
    onboardingSlice.hasBlankRowDrift ||
    (onboardingSlice.duplicateAppointments?.length ?? 0) > 0 ||
    onboardingSlice.hadInlineStopMarkerDrift;

  if (driftDetected) {
    return {
      onboardingAppointments,
      prevMonthTitle: getMonthParts(shiftMonth(new Date(), config.timezone, -1), config.timezone).title,
      currentMonthTitle: getMonthParts(new Date(), config.timezone).title,
      nextMonthTitle: getMonthParts(
        shiftMonth(new Date(), config.timezone, 1),
        config.timezone
      ).title,
      driftDetected: true
    };
  }

  // Step 2 & 3: Sort month sheets by ONBOARDING order and include any new users.
  // Previous month: layoutOnly — refresh formatting without any row writes (past sheets
  // can timeout under load and would abort processing of current/next month sheets).
  const prevMonthDate  = shiftMonth(new Date(), config.timezone, -1);
  const nextMonthDate  = shiftMonth(new Date(), config.timezone, 1);
  const prevMonthTitle = getMonthParts(prevMonthDate, config.timezone).title;
  const currentMonthTitle = getMonthParts(new Date(), config.timezone).title;
  const nextMonthTitle = getMonthParts(nextMonthDate, config.timezone).title;

  console.log(`[Sync] Step 2/4: Checking formatting for previous month (${prevMonthTitle})…`);
  const prevMonth = await ensureMonthlyAttendanceSheet(
    sheets,
    config,
    prevMonthDate,
    onboardingAppointments,
    "replace",
    { cache, layoutOnly: true }
  );

  console.log(`[Sync] Step 3/4: Syncing current month (${currentMonthTitle}) — rows + formatting…`);
  const currentMonth = await ensureMonthlyAttendanceSheet(
    sheets,
    config,
    new Date(),
    onboardingAppointments,
    "replace",
    { cache }
  );

  console.log(`[Sync] Step 4/4: Syncing next month (${nextMonthTitle}) — rows + formatting…`);
  const nextMonth = await ensureMonthlyAttendanceSheet(
    sheets,
    config,
    nextMonthDate,
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
    prevMonthTitle: prevMonth.title,
    currentMonthTitle: currentMonth.title,
    nextMonthTitle: nextMonth.title
  });

  return {
    onboardingAppointments,
    prevMonthTitle: prevMonth.title,
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
  const codeMap = new Map(codeEntries.map((entry) => [
    entry.appointment,
    entry.boundChatId ? "IN-USE" : entry.secretCode
  ]));
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

  for (const [sheetTitle, sheetEntries] of entriesBySheet.entries()) {
    // Read the month sheet directly — no ONBOARDING alignment on the write path.
    // Row positions come from column A of the live sheet; date columns come from
    // row 1. This avoids the row-insertion/deletion pass that "merge" mode
    // previously triggered before every write.
    const values = await readSheetValues(
      sheets,
      config.spreadsheetId,
      sheetTitle,
      `A1:${MAX_MONTH_SHEET_COLUMN_LABEL}${DEFAULT_MAX_MANAGED_ROWS}`
    );
    const headerRow = (values[0] ?? []).map((v) => String(v ?? "").trim());

    // Build appointment → 1-indexed row number from column A, stopping at the
    // roster stop marker. Track duplicates so we can report the right reason.
    const rowNumbersByAppointment = {};
    const appointmentRowCounts = {};
    for (let i = 1; i < values.length; i++) {
      const appointment = normalizeAppointmentLabel(String(values[i]?.[0] ?? "").trim());
      if (!appointment) {
        continue;
      }
      if (isStopMarker(appointment, config.rosterStopMarkers)) {
        break;
      }
      appointmentRowCounts[appointment] = (appointmentRowCounts[appointment] ?? 0) + 1;
      if (!rowNumbersByAppointment[appointment]) {
        rowNumbersByAppointment[appointment] = i + 1; // values is 0-indexed; rows are 1-indexed
      }
    }

    const data = [];

    for (const entry of sheetEntries) {
      const rowNumber = rowNumbersByAppointment[entry.appointment];

      if (!rowNumber) {
        conflictedEvents.push({
          eventId: entry.id,
          reason: (appointmentRowCounts[entry.appointment] ?? 0) > 1
            ? "duplicate_appointment_row"
            : "appointment_missing",
          error: `Appointment row not found for ${entry.appointment} in ${sheetTitle}`
        });
        continue;
      }

      const expectedDateLabel = entry.expectedDateLabel ?? getExpectedDateHeaderLabel(entry.date, config.timezone);
      const columnIndex = headerRow.findIndex((value) => value === expectedDateLabel);

      if (columnIndex === -1) {
        conflictedEvents.push({
          eventId: entry.id,
          reason: "date_column_changed",
          error: `Date column not found for ${expectedDateLabel} in ${sheetTitle}`
        });
        continue;
      }

      // Optimistic lock: read the live cell value directly from the sheet data
      // we already fetched and compare to what the bot last knew about.
      const liveRow = values[rowNumber - 1] ?? [];
      const liveValue = String(liveRow[columnIndex] ?? "").trim();

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
      await verifyBatchWrite(sheets, config.spreadsheetId, data);
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

  // Metadata (sheet IDs) doesn't change between reconcile cycles; always use cache to avoid
  // a slow spreadsheets.get on every 5-minute flush.
  await updateSpreadsheetMetadataCache(sheets, config, localCache, false);
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
    await verifyBatchWrite(sheets, config.spreadsheetId, data);
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
    shiftMonth(baseDate, config.timezone, -1),
    baseDate,
    shiftMonth(baseDate, config.timezone, 1)
  ];
  // Allow callers to pass in a shared cache object (e.g. from runDailySheetMaintenance)
  // to avoid a redundant readLocalSheetCache() + writeLocalSheetCache() round-trip.
  const localCache = options.cache ?? (await readLocalSheetCache());
  const structural = options.structural === true;

  // Never force-refresh metadata or the onboarding slice here — let their TTLs govern.
  // The force flag is propagated to refreshMonthSlice (cheap per-sheet reads) only.
  // Forcing metadata causes an extra spreadsheets.get (10–15 s) on every maintenance run
  // even when syncOnboardingRoster has just populated the cache; forcing onboarding causes
  // a duplicate ONBOARDING values.get immediately after the one in syncOnboardingRoster.
  await updateSpreadsheetMetadataCache(sheets, config, localCache, false);
  await refreshOnboardingSlice(sheets, config, {
    cache: localCache,
    force: false,
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

  // Stamp the attempt time immediately so that if this run fails and the process
  // restarts, deferred startup maintenance won't re-fire during the same window.
  cache.lastStructuralMaintenanceAttemptAt = new Date().toISOString();
  await writeLocalSheetCache(cache);

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

export async function getLastStructuralMaintenanceAttemptAt() {
  const cache = await readLocalSheetCache();
  return cache.lastStructuralMaintenanceAttemptAt ?? null;
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
  // Use sheetIdsByTitle from metadata instead of a raw getSpreadsheet call —
  // updateSpreadsheetMetadataCache already fetches the spreadsheet and stores
  // all sheet titles, so we only need one API call here.
  const metadata = await updateSpreadsheetMetadataCache(sheets, config, cache, false);
  const recentMonthTitleSet = new Set(
    getRecentMonthTitles(new Date(), config.timezone, ATTENDANCE_OPTION_USAGE_MONTH_WINDOW)
  );
  const monthTitles = Object.keys(metadata.sheetIdsByTitle ?? {})
    .map(parseMonthSheetTitle)
    .filter(Boolean)
    .map((entry) => entry.title)
    .filter((title) => recentMonthTitleSet.has(title));
  const counts = new Map(config.attendanceOptions.map((option) => [option, 0]));
  const cachedOnboardingCount = cache.onboardingSlice?.appointments?.length ?? 0;
  const usageRowLimit = managedRowLimit(cachedOnboardingCount);

  for (const title of monthTitles) {
    const values = await readSheetValues(sheets, config.spreadsheetId, title, `A1:${MAX_MONTH_SHEET_COLUMN_LABEL}${usageRowLimit}`);
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

/**
 * Removes every protected range from the spreadsheet in a single batchUpdate.
 * Useful as a one-shot admin action to clear any lingering bot-managed or
 * manually-added protections after the protection-tracking code was removed.
 *
 * Uses the process-level metadata cache (populated by the background sync cycle)
 * rather than making a fresh spreadsheets.get call — that call can take 30–120 s
 * under API congestion and would reliably time out.  If the cache is empty (very
 * first bot run before the first successful sync), it falls back to a live call.
 */
export async function clearAllSheetProtections(sheets, spreadsheetId) {
  // Prefer cached spreadsheet metadata so we don't need a live spreadsheets.get.
  // The metadata TTL is 45 min; protections change far less often than that.
  let sheetsMeta;
  const processEntry = processSpreadsheetCache.get(sheets);

  if (processEntry?.data?.sheets) {
    logSheetsSuccess("clearAllSheetProtections: reading protections from cached metadata.");
    sheetsMeta = processEntry.data.sheets;
  } else {
    logSheetsSuccess("clearAllSheetProtections: cache empty — fetching live metadata.");
    const result = await runGoogleSheetsRequestQueued(
      "spreadsheets.get:clearProtections",
      (signal) => sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets(properties(sheetId,title),protectedRanges(protectedRangeId,description))"
      }, { signal })
    );
    sheetsMeta = result.data.sheets ?? [];
    // Update the process cache so subsequent calls (e.g. ensureSheet) benefit too.
    processSpreadsheetCache.set(sheets, { data: result.data, fetchedAt: new Date().toISOString() });
  }

  const allProtections = (sheetsMeta ?? [])
    .flatMap((sheet) => (sheet.protectedRanges ?? []).map((p) => ({
      ...p,
      sheetTitle: sheet.properties?.title ?? "(unknown)"
    })))
    .filter((p) => Number.isInteger(p.protectedRangeId));

  if (allProtections.length === 0) {
    logSheetsSuccess("clearAllSheetProtections: no protections found.");
    return { removedCount: 0 };
  }

  logSheetsSuccess(`clearAllSheetProtections: removing ${allProtections.length} protection(s)…`);

  const requests = allProtections.map((p) => ({
    deleteProtectedRange: { protectedRangeId: p.protectedRangeId }
  }));

  await runGoogleSheetsRequestQueued(
    `spreadsheets.batchUpdate:clearAllProtections(${requests.length})`,
    (signal) => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests }
    }, { signal })
  );

  logSheetsSuccess(`clearAllSheetProtections: removed ${allProtections.length} protection(s).`, {
    sheets: [...new Set(allProtections.map((p) => p.sheetTitle))]
  });

  return { removedCount: allProtections.length };
}

/**
 * runStartupSheetCleanup — called once on bot startup BEFORE the first sync cycle.
 *
 * 1. Removes all sheet protections (using cached metadata when available).
 * 2. Trims trailing blank rows from every sheet by reading all column-A values in
 *    a single batchGet call and issuing a single batchUpdate with all deleteDimension
 *    requests.  This keeps the spreadsheet compact so subsequent spreadsheets.get
 *    calls return less data and run faster.
 */
export async function runStartupSheetCleanup(sheets, spreadsheetId) {
  console.log("[Startup] [Cleanup] Starting sheet cleanup…");

  // Step 1: Remove all protections (prefers cached metadata if available).
  await clearAllSheetProtections(sheets, spreadsheetId);

  // Step 2: Trim trailing blank rows from all sheets.
  console.log("[Startup] [Cleanup] Trimming trailing blank rows from all sheets…");

  // Re-use cached metadata when it exists; otherwise fetch it now.
  let sheetsMeta;
  const processEntry = processSpreadsheetCache.get(sheets);
  if (processEntry?.data?.sheets) {
    sheetsMeta = processEntry.data.sheets;
    console.log("[Startup] [Cleanup] Using cached sheet metadata.");
  } else {
    console.log("[Startup] [Cleanup] Cache empty — fetching sheet metadata.");
    const response = await runGoogleSheetsRequestQueued(
      "spreadsheets.get:startupCleanup",
      (signal) => sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets(properties(sheetId,title,gridProperties),protectedRanges(protectedRangeId,description))"
      }, { signal })
    );
    sheetsMeta = response.data.sheets ?? [];
    processSpreadsheetCache.set(sheets, { data: response.data, fetchedAt: new Date().toISOString() });
  }

  if (sheetsMeta.length === 0) {
    console.log("[Startup] [Cleanup] No sheets found — nothing to trim.");
    console.log("[Startup] [Cleanup] Sheet cleanup complete.");
    return;
  }

  // Batch-read column A from every sheet in one API call.
  const ranges = sheetsMeta.map((s) => {
    const rowCount = s.properties?.gridProperties?.rowCount ?? 1000;
    const title = s.properties?.title ?? "";
    // Escape single quotes in sheet titles.
    const escapedTitle = title.replace(/'/g, "''");
    return `'${escapedTitle}'!A1:A${rowCount}`;
  });

  const batchResult = await runGoogleSheetsRequestQueued(
    "spreadsheets.values.batchGet:startupCleanup",
    (signal) => sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges }, { signal })
  );
  const valueRanges = batchResult.data.valueRanges ?? [];

  // Build deleteDimension requests for every sheet that has trailing blank rows.
  const trimRequests = [];
  for (const [index, sheet] of sheetsMeta.entries()) {
    const sheetId = sheet.properties?.sheetId;
    const rowCount = sheet.properties?.gridProperties?.rowCount ?? 0;
    const title = sheet.properties?.title ?? `(sheet ${index})`;

    if (!Number.isInteger(sheetId) || rowCount === 0) continue;

    // The Sheets API omits trailing empty rows from valueRanges, so `.values.length`
    // is exactly the index of the last non-empty row + 1 (i.e. 1-based last row).
    const values = valueRanges[index]?.values ?? [];
    const lastNonEmptyRow = values.length; // 0 means completely empty

    if (lastNonEmptyRow === 0) {
      // Completely empty sheet — leave it alone; deleting all rows would error.
      continue;
    }

    const blankRowsToDelete = rowCount - lastNonEmptyRow;
    if (blankRowsToDelete > 0) {
      trimRequests.push({
        deleteDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: lastNonEmptyRow, endIndex: rowCount }
        }
      });
      console.log(`[Startup] [Cleanup] "${title}": trimming ${blankRowsToDelete} trailing blank row(s) (rows ${lastNonEmptyRow + 1}–${rowCount}).`);
    }
  }

  if (trimRequests.length === 0) {
    console.log("[Startup] [Cleanup] All sheets already compact — no rows to trim.");
  } else {
    await runGoogleSheetsRequestQueued(
      `spreadsheets.batchUpdate:startupCleanup:trimRows(${trimRequests.length})`,
      (signal) => sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: trimRequests }
      }, { signal })
    );
    console.log(`[Startup] [Cleanup] Trimmed trailing rows from ${trimRequests.length} sheet(s).`);
  }

  // Invalidate the process cache so the next sync cycle sees the updated row counts.
  processSpreadsheetCache.delete(sheets);

  console.log("[Startup] [Cleanup] Sheet cleanup complete.");
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
  getExpectedDateHeaderLabel,
  getMonthParts,
  shiftMonth,
  writeMonthlySheetRows,
  writeAppointmentColumn,
  reconcileOnboardingWithConfig
};
