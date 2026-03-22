import dotenv from "dotenv";

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

const defaultAttendanceOptions = [
  "PRESENT",
  "OFF",
  "OS",
  "D1",
  "D2",
  "D3",
  "DUTY",
  "U/S",
  "RSO",
  "MC",
  "LL",
  "OL",
  "CCL",
  "PCL",
  "OML",
  "AO",
  "68",
  "69",
  "70",
  "71",
  "73",
  "OC",
  "TNB",
  "MA",
  "WFH",
  "FISHING",
  "SR",
  "RR",
  "DISEMBARK OFF",
  "AM LEAVE",
  "PM LEAVE",
  "OFF (AM)",
  "OFF (PM)",
  "CSL",
  "COMPASSIONATE",
  "ORD",
  "POST OUT",
  "IPPT",
  "OIL",
  "HL",
  "PH",
  "SHRO",
  "ORCA",
  "EMBARK OFF",
  "YARD",
  "CCL (AM)",
  "CCL (PM)",
  "RSI",
  "YARD (AM)",
  "YARD (PM)",
  "CNB (AM)",
  "CNB (PM)",
  "PCL (AM)",
  "PCL (PM)",
  "CSL (AM)",
  "CSL (PM)",
  "FMSS",
  "OE",
  "PTL",
  "CNB",
  "OSD",
  "POOD (DAY)",
  "OOD"
];

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
  attendanceQuestion:
    process.env.ATTENDANCE_QUESTION || "Will you be attending today?",
  attendanceOptions,
  onboardingCodePrompt:
    process.env.ONBOARDING_CODE_PROMPT ||
    "Send the secret code assigned to your appointment.",
  rosterStopMarkers: parseList(process.env.ROSTER_STOP_MARKERS || "Remarks"),
  defaultAdminAppointments: parseList(
    process.env.DEFAULT_ADMIN_APPOINTMENTS || "SCSE,Coxn,CO,XO,OPS 1"
  )
};
