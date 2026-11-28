import test from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_PRIVATE_KEY ??= "test-key";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.GOOGLE_SHEETS_SPREADSHEET_ID ??= "test-sheet";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ??= "bot@example.com";
globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: { records: [] } }) });

const {
  copyWeeklyEntriesFromPreviousWeek,
  fillBlankWeeklyEntries,
  findNextBlankWeeklyIndex,
  listBlankWeeklyDates
} = await import("../src/weeklyFlow.js");
const { __testing } = await import("../src/bot.js");

const toIso = (value) => (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
const week = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]
  .map((iso) => new Date(`${iso}T04:00:00.000Z`).toISOString());

test("fill blanks stages the status only on days with no staged or existing value", () => {
  const existing = { "2026-11-24": "OS" };
  const staged = [{ date: "2026-11-25", status: "PH" }];
  const { entries, filledDates } = fillBlankWeeklyEntries(
    week, staged, (_d, iso) => existing[iso] ?? "", "PRESENT", toIso
  );

  assert.deepEqual(filledDates, ["2026-11-23", "2026-11-26", "2026-11-27"]);
  assert.deepEqual(Object.fromEntries(entries.map((e) => [e.date, e.status])), {
    "2026-11-25": "PH",
    "2026-11-23": "PRESENT",
    "2026-11-26": "PRESENT",
    "2026-11-27": "PRESENT"
  });
  assert.deepEqual(listBlankWeeklyDates(week, entries, (_d, iso) => existing[iso] ?? "", toIso), []);
});

test("copy last week fills blanks from seven days earlier and never copies PH or blanks", () => {
  const lastWeek = { "2026-11-16": "OS", "2026-11-17": "PH", "2026-11-19": "WFH", "2026-11-20": "PRESENT" };
  const existing = { "2026-11-26": "DUTY" };
  const { entries, copiedDates } = copyWeeklyEntriesFromPreviousWeek(
    week,
    [],
    (_d, iso) => existing[iso] ?? "",
    (date) => lastWeek[toIso(new Date(date.getTime() - 7 * 86400000))] ?? "",
    toIso
  );

  assert.deepEqual(copiedDates, ["2026-11-23", "2026-11-27"]);
  assert.deepEqual(entries, [
    { date: "2026-11-23", status: "OS" },
    { date: "2026-11-27", status: "PRESENT" }
  ]);
});

test("findNextBlankWeeklyIndex moves forward, wraps, and reports -1 when done", () => {
  const values = { "2026-11-23": "OS", "2026-11-25": "OS" };
  const get = (_d, iso) => values[iso] ?? "";
  assert.equal(findNextBlankWeeklyIndex(week, [], get, 0, toIso), 1);
  assert.equal(findNextBlankWeeklyIndex(week, [], get, 4, toIso), 1);
  const full = week.map((d) => ({ date: toIso(d), status: "PRESENT" }));
  assert.equal(findNextBlankWeeklyIndex(week, full, get, 2, toIso), -1);
});

// --- bot-level shortcut rendering ---------------------------------------

const config = {
  timezone: "Asia/Singapore",
  attendanceOptions: ["PRESENT", "OS", "PH"],
  attendanceGroups: [
    { key: "present", label: "PRESENT", options: ["PRESENT"] },
    { key: "out", label: "Out", options: ["OS"] },
    { key: "off", label: "OFF", options: ["PH"] }
  ]
};

function cacheWith(statusByIso) {
  const statusesByDay = new Map();
  for (const [iso, status] of Object.entries(statusByIso)) {
    statusesByDay.set(Number(iso.slice(8, 10)), [status]);
  }
  return { sheetSnapshots: { snapshots: new Map([["Nov 26", { appointments: ["ALPHA"], statusesByDay }]]) } };
}

const user = { appointment: "ALPHA" };

function buttons(rows) {
  return rows.flat().map((button) => ({ text: button.text, data: button.callback_data }));
}

test("default fill status follows the first attendance group", () => {
  assert.equal(__testing.getDefaultFillStatus(config), "PRESENT");
});

test("weekly shortcut row offers All: PRESENT and Copy last week when useful", () => {
  const cache = cacheWith({ "2026-11-16": "OS" });
  const row = buttons(__testing.buildWeeklyShortcutRow(week, [], cache, config, user, "flow1"));
  assert.deepEqual(row.map((b) => b.text), ["⚡ All: PRESENT", "🔁 Copy last week"]);
  assert.match(row[0].data, /^home:week:fill:flow1:2026-11-23:0:/);
  assert.equal(row[1].data, "home:week:copy:flow1:2026-11-23");
  for (const b of row) assert.ok(Buffer.byteLength(b.data) <= 64, `callback too long: ${b.data}`);
});

test("weekly shortcut row counts blanks and disappears once every day has a value", () => {
  const partial = buttons(__testing.buildWeeklyShortcutRow(
    week, [{ date: "2026-11-23", status: "OS" }], cacheWith({}), config, user, "f"
  ));
  assert.deepEqual(partial.map((b) => b.text), ["⚡ 4 blank: PRESENT"]);

  const full = week.map((d) => ({ date: toIso(d), status: "PRESENT" }));
  assert.deepEqual(__testing.buildWeeklyShortcutRow(week, full, cacheWith({}), config, user, "f"), []);
});

test("home quick button appears only on a blank working weekday", async () => {
  const wednesday = new Date("2026-11-25T02:00:00.000Z");
  const quick = await __testing.buildQuickAttendanceButton(config, user, cacheWith({}), wednesday);
  assert.equal(quick.label, "✅ Today: PRESENT");
  assert.match(quick.callback, /^home:pick:attendance:[\w-]+:2026-11-25:0:[\w-]{8}$/);
  assert.ok(Buffer.byteLength(quick.callback) <= 64);

  assert.equal(await __testing.buildQuickAttendanceButton(config, user, cacheWith({ "2026-11-25": "OS" }), wednesday), null);
  assert.equal(await __testing.buildQuickAttendanceButton(config, user, cacheWith({}), new Date("2026-11-28T02:00:00.000Z")), null);
  assert.equal(await __testing.buildQuickAttendanceButton(config, user, {}, wednesday), null);
  assert.equal(await __testing.buildQuickAttendanceButton(config, {}, cacheWith({}), wednesday), null);

  const menu = __testing.buildHomeMenu(false, "Asia/Singapore", { quickAttendance: quick });
  assert.equal(menu.reply_markup.inline_keyboard[0][0].text, "✅ Today: PRESENT");
});
