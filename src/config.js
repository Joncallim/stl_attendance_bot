import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import dotenv from "dotenv";
import YAML from "yaml";
import { getSettings, setAttendanceOptions } from "./storage.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SETTINGS_SCHEMA_VERSION = 1;
const SETTINGS_FILE_PATH = process.env.SETTINGS_FILE_PATH?.trim()
  || path.resolve(process.cwd(), "settings.yaml");

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseList(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeKey(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function normalizeAppointmentName(value) {
  return String(value ?? "").trim().toUpperCase();
}

function ensureObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function ensureNonEmptyString(value, label) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return normalized;
}

function sortNodes(left, right) {
  const leftOrder = Number.isFinite(left.order) ? left.order : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(right.order) ? right.order : Number.MAX_SAFE_INTEGER;

  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return left.name.localeCompare(right.name);
}

function buildHierarchyTraversal(nodesById, parentId = null, results = []) {
  const children = [...nodesById.values()]
    .filter((node) => (node.parentId ?? null) === parentId)
    .sort(sortNodes);

  for (const child of children) {
    results.push(child);
    buildHierarchyTraversal(nodesById, child.id, results);
  }

  return results;
}

function validateHierarchyCycle(nodesById, nodeId, active = new Set(), seen = new Set()) {
  if (active.has(nodeId)) {
    throw new Error(`Hierarchy contains a cycle at node '${nodeId}'.`);
  }

  if (seen.has(nodeId)) {
    return;
  }

  active.add(nodeId);
  seen.add(nodeId);

  const node = nodesById.get(nodeId);
  const children = [...nodesById.values()].filter((entry) => entry.parentId === node.id);

  for (const child of children) {
    validateHierarchyCycle(nodesById, child.id, active, seen);
  }

  active.delete(nodeId);
}

async function loadSettingsDocument() {
  let rawText = "";

  try {
    rawText = await readFile(SETTINGS_FILE_PATH, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Missing required settings file at ${SETTINGS_FILE_PATH}. Set SETTINGS_FILE_PATH or add settings.yaml.`
      );
    }

    throw error;
  }

  let parsed;

  try {
    parsed = YAML.parse(rawText);
  } catch (error) {
    throw new Error(`Unable to parse ${SETTINGS_FILE_PATH}: ${error.message}`);
  }

  const document = ensureObject(parsed, "settings.yaml");
  const schemaVersion = Number(document.schemaVersion ?? document.version ?? 0);

  if (schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new Error(
      `settings.yaml schemaVersion must be ${SETTINGS_SCHEMA_VERSION}. Received ${document.schemaVersion ?? document.version ?? "undefined"}.`
    );
  }

  const unit = ensureObject(document.unit, "unit");
  const unitName = ensureNonEmptyString(unit.name, "unit.name");
  const unitId = String(unit.id ?? unitName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default-unit";

  const hierarchyEntries = Array.isArray(document.hierarchy) ? document.hierarchy : [];

  if (hierarchyEntries.length === 0) {
    throw new Error("hierarchy must contain at least one department or section node.");
  }

  const nodesById = new Map();

  for (const [index, entry] of hierarchyEntries.entries()) {
    const node = ensureObject(entry, `hierarchy[${index}]`);
    const id = ensureNonEmptyString(node.id, `hierarchy[${index}].id`);

    if (nodesById.has(id)) {
      throw new Error(`Duplicate hierarchy node id '${id}'.`);
    }

    const type = ensureNonEmptyString(node.type, `hierarchy[${index}].type`).toLowerCase();

    if (!["department", "section"].includes(type)) {
      throw new Error(`hierarchy[${index}].type must be 'department' or 'section'.`);
    }

    nodesById.set(id, {
      id,
      key: normalizeKey(id),
      name: ensureNonEmptyString(node.name, `hierarchy[${index}].name`),
      type,
      parentId: node.parentId ? ensureNonEmptyString(node.parentId, `hierarchy[${index}].parentId`) : null,
      order: Number.isFinite(Number(node.order)) ? Number(node.order) : index
    });
  }

  for (const node of nodesById.values()) {
    if (node.parentId && !nodesById.has(node.parentId)) {
      throw new Error(`Hierarchy node '${node.id}' references missing parent '${node.parentId}'.`);
    }
  }

  for (const nodeId of nodesById.keys()) {
    validateHierarchyCycle(nodesById, nodeId);
  }

  const orderedHierarchy = buildHierarchyTraversal(nodesById);
  const hierarchyOptions = orderedHierarchy.map((node, index) => ({
    key: node.key,
    id: node.id,
    label: node.name,
    order: typeof node.order === "number" ? node.order : index,
    type: node.type,
    parentId: node.parentId
  }));
  const hierarchyNodeByKey = new Map(hierarchyOptions.map((node) => [node.key, node]));

  const appointmentEntries = Array.isArray(document.appointments) ? document.appointments : [];

  if (appointmentEntries.length === 0) {
    throw new Error("appointments must contain at least one configured appointment.");
  }

  const appointmentMetadataByName = new Map();
  const defaultAdminAppointments = [];
  const configuredAppointments = [];

  for (const [index, entry] of appointmentEntries.entries()) {
    const appointment = ensureObject(entry, `appointments[${index}]`);
    const name = ensureNonEmptyString(appointment.name, `appointments[${index}].name`);
    const normalizedName = normalizeAppointmentName(name);

    if (appointmentMetadataByName.has(normalizedName)) {
      throw new Error(`Duplicate appointment '${name}' in settings.yaml.`);
    }

    const hierarchyNodeId = appointment.hierarchyNodeId
      ? ensureNonEmptyString(appointment.hierarchyNodeId, `appointments[${index}].hierarchyNodeId`)
      : null;

    if (hierarchyNodeId && !nodesById.has(hierarchyNodeId)) {
      throw new Error(
        `Appointment '${name}' references missing hierarchy node '${hierarchyNodeId}'.`
      );
    }

    const meta = {
      name,
      normalizedName,
      hierarchyNodeId,
      hierarchyNodeKey: hierarchyNodeId ? normalizeKey(hierarchyNodeId) : null,
      defaultAdmin: appointment.defaultAdmin === true,
      order: Number.isFinite(Number(appointment.order)) ? Number(appointment.order) : index
    };

    appointmentMetadataByName.set(normalizedName, meta);
    configuredAppointments.push(name);

    if (meta.defaultAdmin) {
      defaultAdminAppointments.push(name);
    }
  }

  // ── Officer appointment types ─────────────────────────────────────────────────
  // Each entry is a role prefix (string) that matches appointments of the form
  // PREFIX  or  PREFIX <number>  (case-insensitive).  Appointments in ONBOARDING
  // that match a pattern here are kept during reconciliation even if they are not
  // explicitly listed in the `appointments` section.
  const officerTypeEntries = Array.isArray(document.officerAppointmentTypes)
    ? document.officerAppointmentTypes
    : [];

  const officerAppointmentTypePatterns = [];

  for (const [index, entry] of officerTypeEntries.entries()) {
    const rawPrefix = typeof entry === "string"
      ? entry
      : ensureNonEmptyString(entry?.prefix, `officerAppointmentTypes[${index}].prefix`);

    const prefix = rawPrefix.trim().toUpperCase();

    if (!prefix) {
      throw new Error(`officerAppointmentTypes[${index}] must be a non-empty string.`);
    }

    // Escape any regex metacharacters in the prefix (e.g. a literal dot or plus).
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Matches: PREFIX  or  PREFIX <one-or-more-digits>
    officerAppointmentTypePatterns.push({
      prefix,
      pattern: new RegExp(`^${escaped}(\\s+\\d+)?$`)
    });
  }

  const attendance = ensureObject(document.attendance, "attendance");
  const groups = Array.isArray(attendance.groups) ? attendance.groups : [];

  if (groups.length === 0) {
    throw new Error("attendance.groups must contain at least one group.");
  }

  const attendanceGroups = [];
  const seenGroupIds = new Set();
  const seenOptions = new Set();

  for (const [index, entry] of groups.entries()) {
    const group = ensureObject(entry, `attendance.groups[${index}]`);
    const id = ensureNonEmptyString(group.id, `attendance.groups[${index}].id`);

    if (seenGroupIds.has(id)) {
      throw new Error(`Duplicate attendance group id '${id}'.`);
    }

    seenGroupIds.add(id);

    const options = Array.isArray(group.options) ? group.options : [];

    if (options.length === 0) {
      throw new Error(`attendance.groups[${index}].options must contain at least one option.`);
    }

    const normalizedOptions = options.map((option, optionIndex) =>
      ensureNonEmptyString(option, `attendance.groups[${index}].options[${optionIndex}]`).toUpperCase()
    );

    const groupOptions = new Set();
    for (const option of normalizedOptions) {
      if (groupOptions.has(option)) {
        throw new Error(`Attendance option '${option}' appears more than once in group '${id}'.`);
      }
      groupOptions.add(option);
      seenOptions.add(option);
    }

    attendanceGroups.push({
      id,
      key: normalizeKey(id),
      label: ensureNonEmptyString(group.label, `attendance.groups[${index}].label`),
      summaryLabel: String(group.summaryLabel ?? group.label).trim() || ensureNonEmptyString(group.label, `attendance.groups[${index}].label`),
      options: normalizedOptions,
      order: Number.isFinite(Number(group.order)) ? Number(group.order) : index
    });
  }

  attendanceGroups.sort((left, right) => {
    if (left.order !== right.order) {
      return left.order - right.order;
    }

    return left.label.localeCompare(right.label);
  });

  // A status may intentionally appear in multiple Telegram menu categories
  // (for example OC and OL), but it must remain one value in Sheets.
  const attendanceOptions = [...new Set(attendanceGroups.flatMap((group) => group.options))];
  const attendanceGroupByOption = new Map();

  for (const group of attendanceGroups) {
    for (const option of group.options) {
      if (!attendanceGroupByOption.has(option)) {
        attendanceGroupByOption.set(option, group);
      }
    }
  }

  const appointmentOrderIndex = new Map(
    [...appointmentMetadataByName.values()]
      .sort((left, right) => {
        if (left.order !== right.order) {
          return left.order - right.order;
        }

        return left.name.localeCompare(right.name);
      })
      .map((entry, index) => [entry.normalizedName, index])
  );

  return {
    schemaVersion,
    unit: {
      id: unitId,
      name: unitName
    },
    hierarchy: hierarchyOptions,
    hierarchyNodeByKey,
    appointmentMetadataByName,
    configuredAppointments,
    officerAppointmentTypePatterns,
    defaultAdminAppointments,
    attendanceGroups,
    attendanceOptions,
    attendanceGroupByOption,
    appointmentOrderIndex
  };
}

export const defaultAttendanceOptions = [];
const ATTENDANCE_OPTION_SCHEMA_VERSION = 3;
const RETIRED_ATTENDANCE_OPTIONS = new Set(["PCL"]);
const MIGRATED_ATTENDANCE_OPTIONS = ["FCL"];

const privateKey = requireEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");
const runtimeConfig = {
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  spreadsheetId: requireEnv("GOOGLE_SHEETS_SPREADSHEET_ID"),
  googleServiceAccountEmail: requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
  googlePrivateKey: privateKey,
  timezone: process.env.BOT_TIMEZONE || "Asia/Singapore",
  firstReminderTime: process.env.FIRST_REMINDER_TIME || "07:00",
  secondReminderTime: process.env.SECOND_REMINDER_TIME || "08:00",
  onboardingSheetTitle: process.env.ONBOARDING_SHEET_TITLE || "ONBOARDING",
  rosterStopMarkers: parseList(process.env.ROSTER_STOP_MARKERS || ""),
  settingsFilePath: SETTINGS_FILE_PATH,
  unit: null,
  hierarchy: [],
  hierarchyNodeByKey: new Map(),
  appointmentMetadataByName: new Map(),
  configuredAppointments: [],
  officerAppointmentTypePatterns: [],
  appointmentOrderIndex: new Map(),
  defaultAdminAppointments: [],
  attendanceGroups: [],
  attendanceOptions: [],
  onboardingAttendanceOptions: []
};

function validateReminderTime(value, name) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${name} must use 24-hour HH:MM format.`);
  }
}

validateReminderTime(runtimeConfig.firstReminderTime, "FIRST_REMINDER_TIME");
validateReminderTime(runtimeConfig.secondReminderTime, "SECOND_REMINDER_TIME");
if (runtimeConfig.firstReminderTime === runtimeConfig.secondReminderTime) {
  throw new Error("FIRST_REMINDER_TIME and SECOND_REMINDER_TIME must be different.");
}

export function applyUnitSettings(config, unitSettings) {
  config.unit = unitSettings.unit;
  config.hierarchy = unitSettings.hierarchy;
  config.hierarchyNodeByKey = unitSettings.hierarchyNodeByKey;
  config.appointmentMetadataByName = unitSettings.appointmentMetadataByName;
  config.configuredAppointments = unitSettings.configuredAppointments;
  config.officerAppointmentTypePatterns = unitSettings.officerAppointmentTypePatterns;
  config.appointmentOrderIndex = unitSettings.appointmentOrderIndex;
  config.defaultAdminAppointments = unitSettings.defaultAdminAppointments;
  config.attendanceGroups = unitSettings.attendanceGroups;
  config.onboardingAttendanceOptions = [...unitSettings.attendanceOptions];
  config.attendanceOptions = [...unitSettings.attendanceOptions];
  config.defaultAttendanceOptions = [...unitSettings.attendanceOptions];
}

export const config = runtimeConfig;

export async function loadUnitSettings() {
  return loadSettingsDocument();
}

export async function applyStoredConfigOverrides() {
  const unitSettings = await loadSettingsDocument();
  applyUnitSettings(config, unitSettings);

  const settings = await getSettings();

  const storedOptions = Array.isArray(settings.attendanceOptions)
    ? [...new Set(settings.attendanceOptions.map((option) => String(option).trim().toUpperCase()).filter(Boolean))]
      .filter((option) => !RETIRED_ATTENDANCE_OPTIONS.has(option))
    : [];
  const isLegacyVersion = settings.attendanceOptionsVersion === 2;
  const isFutureVersion = Number(settings.attendanceOptionsVersion) > ATTENDANCE_OPTION_SCHEMA_VERSION;
  const needsMigration = isLegacyVersion && Array.isArray(settings.attendanceOptions);

  if (storedOptions.length > 0) {
    config.attendanceOptions = needsMigration
      ? [...new Set([...storedOptions, ...MIGRATED_ATTENDANCE_OPTIONS])]
      : storedOptions;
  } else {
    config.attendanceOptions = [...config.onboardingAttendanceOptions];
  }

  if (!isFutureVersion && (needsMigration || storedOptions.length !== (settings.attendanceOptions?.length ?? 0))) {
    await setAttendanceOptions(config.attendanceOptions);
  }

  return config;
}
