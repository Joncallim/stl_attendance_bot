import dotenv from "dotenv";
import { getSettings } from "./storage.js";

dotenv.config();

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

export const defaultAttendanceOptions = [
  "PRESENT",
  "DUTY",
  "PH",
  "OSD",
  "OE",
  "WFH",
  "FISHING",
  "OIL",
  "EMBARK OFF",
  "OFF",
  "DISEMBARK OFF",
  "RR",
  "SR",
  "OS",
  "TNB",
  "YARD",
  "ORCA",
  "RSO",
  "MC",
  "OML",
  "MA",
  "HL",
  "RSI",
  "LL",
  "CCL",
  "PCL",
  "CSL",
  "COMPASSIONATE",
  "PTL",
  "OL",
  "AO",
  "68",
  "69",
  "70",
  "71",
  "73",
  "OC",
  "ORD",
  "POST OUT",
  "IPPT",
  "FMSS",
  "CNB",
  "CST",
  "DCTC"
];
const ATTENDANCE_OPTION_SCHEMA_VERSION = 2;

const privateKey = requireEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");
const attendanceOptions =
  parseList(process.env.ATTENDANCE_OPTIONS).length > 0
    ? parseList(process.env.ATTENDANCE_OPTIONS)
    : defaultAttendanceOptions;

export const config = {
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  spreadsheetId: requireEnv("GOOGLE_SHEETS_SPREADSHEET_ID"),
  googleServiceAccountEmail: requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
  googlePrivateKey: privateKey,
  timezone: process.env.BOT_TIMEZONE || "Asia/Singapore",
  firstReminderTime: process.env.FIRST_REMINDER_TIME || "07:00",
  secondReminderTime: process.env.SECOND_REMINDER_TIME || "08:00",
  onboardingSheetTitle: process.env.ONBOARDING_SHEET_TITLE || "ONBOARDING",
  onboardingSyncIntervalMinutes: Number(
    process.env.ONBOARDING_SYNC_INTERVAL_MINUTES || 5
  ),
  sheetSyncMinIntervalMs: Number(process.env.SHEET_SYNC_MIN_INTERVAL_MS || 60000),
  attendanceOptions,
  rosterStopMarkers: parseList(process.env.ROSTER_STOP_MARKERS || "Remarks"),
  defaultAdminAppointments: parseList(
    process.env.DEFAULT_ADMIN_APPOINTMENTS || "SCSE,Coxn,CO,XO,OPS 1"
  )
};

export async function applyStoredConfigOverrides() {
  const settings = await getSettings();

  if (
    settings.attendanceOptionsVersion === ATTENDANCE_OPTION_SCHEMA_VERSION &&
    Array.isArray(settings.attendanceOptions) &&
    settings.attendanceOptions.length > 0
  ) {
    config.attendanceOptions = settings.attendanceOptions;
  } else {
    config.attendanceOptions = [...defaultAttendanceOptions];
  }

  return config;
}
