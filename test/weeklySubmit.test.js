import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

process.env.GOOGLE_PRIVATE_KEY ??= "test-key";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.GOOGLE_SHEETS_SPREADSHEET_ID ??= "test-sheet";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ??= "bot@example.com";
const tempDir = await mkdtemp(path.join(os.tmpdir(), "attendance-weekly-submit-"));
process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;

const { __testing } = await import("../src/bot.js");
const { upsertUser, getUserByChatId } = await import("../src/storage.js");
const { listPendingAttendanceEvents } = await import("../src/attendanceQueue.js");

test.after(async () => {
  delete process.env.ATTENDANCE_BOT_DATA_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

const TZ = "Asia/Singapore";
const config = {
  timezone: TZ,
  attendanceOptions: ["PRESENT", "OS", "PH"],
  attendanceGroups: [
    { key: "present", label: "PRESENT", options: ["PRESENT"] },
    { key: "out", label: "Out", options: ["OS"] }
  ]
};
const week = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]
  .map((iso) => new Date(`${iso}T04:00:00.000Z`).toISOString());

function cacheWith(statusByIso) {
  const statusesByDay = new Map();
  for (const [iso, status] of Object.entries(statusByIso)) {
    statusesByDay.set(Number(iso.slice(8, 10)), [status]);
  }
  return {
    sheetSnapshots: { snapshots: new Map([["Nov 26", { appointments: ["ALPHA"], statusesByDay }]]) },
    summaryMemo: new Map()
  };
}

function fakeCtx(entries) {
  const sent = [];
  return {
    sent,
    chat: { id: "700" },
    telegram: { deleteMessage: async () => true, editMessageReplyMarkup: async () => true },
    session: {
      awaitingWeeklyAttendance: true,
      weeklyAttendanceDates: week,
      weeklyAttendanceIndex: 0,
      weeklyAttendanceEntries: entries,
      weeklyAttendanceFlowId: "flowA"
    },
    reply: async (text, options) => {
      sent.push({ text, options });
      return { message_id: sent.length };
    }
  };
}

test("overview marks unsaved picks and counts them on Submit", () => {
  const { message, keyboard } = __testing.buildWeeklyAttendanceOverview(
    week,
    [{ date: "2026-11-23", status: "OS" }, { date: "2026-11-24", status: "PRESENT" }],
    cacheWith({ "2026-11-24": "PRESENT", "2026-11-25": "PRESENT" }),
    config,
    { appointment: "ALPHA" },
    "flowA"
  );
  assert.match(message, /23 Nov.*: OS ✏️/);
  assert.doesNotMatch(message, /24 Nov.*✏️/, "a pick equal to the sheet value is not unsaved");
  const labels = keyboard.reply_markup.inline_keyboard.flat().map((button) => button.text);
  assert.ok(labels.includes("✅ Submit (1 unsaved, 2 blank)"), labels.join(" | "));
});

test("submit label variants", () => {
  assert.equal(__testing.formatWeeklySubmitLabel(0, 0), "✅ Submit");
  assert.equal(__testing.formatWeeklySubmitLabel(3, 0), "✅ Submit (3 unsaved)");
  assert.equal(__testing.formatWeeklySubmitLabel(0, 2), "✅ Submit (2 blank)");
});

test("weekly drafts restore only into the same week", () => {
  const draft = __testing.buildWeeklyDraft(week, [{ date: "2026-11-25", status: "OS" }, { date: "2026-12-01", status: "OS" }], TZ);
  assert.equal(draft.weekStart, "2026-11-23");
  assert.deepEqual(__testing.restoreWeeklyDraftEntries(draft, week, TZ), [{ date: "2026-11-25", status: "OS" }]);
  const nextWeek = week.map((iso) => new Date(new Date(iso).getTime() + 7 * 86400000).toISOString());
  assert.deepEqual(__testing.restoreWeeklyDraftEntries(draft, nextWeek, TZ), []);
  assert.deepEqual(__testing.restoreWeeklyDraftEntries(null, week, TZ), []);
});

test("a week with blank days submits only the filled days and clears the draft", async () => {
  await upsertUser({
    chatId: "700",
    userId: "700",
    appointment: "ALPHA",
    weeklyDraft: { weekStart: "2026-11-23", entries: [{ date: "2026-11-23", status: "OS" }] }
  });
  const ctx = fakeCtx([{ date: "2026-11-23", status: "OS" }]);
  const ok = await __testing.finalizeWeeklyAttendanceFlow(
    ctx,
    config,
    { appointment: "ALPHA" },
    cacheWith({ "2026-11-24": "PRESENT" })
  );

  assert.equal(ok, true);
  const pending = await listPendingAttendanceEvents();
  assert.deepEqual(
    pending.map((event) => [event.status, event.date.slice?.(0, 10) ?? new Date(event.date).toISOString().slice(0, 10)]).sort(),
    [["OS", "2026-11-23"], ["PRESENT", "2026-11-24"]]
  );
  const confirmation = ctx.sent.at(-1).text;
  assert.match(confirmation, /^Saved ✅ 2 of 5 weekdays recorded/);
  assert.match(confirmation, /— \(left blank\)/);
  assert.equal((await getUserByChatId("700")).weeklyDraft, null);
});

test("a week with nothing picked is not submitted", async () => {
  const ctx = fakeCtx([]);
  const ok = await __testing.finalizeWeeklyAttendanceFlow(ctx, config, { appointment: "ALPHA" }, cacheWith({}));
  assert.equal(ok, false);
  assert.match(ctx.sent.at(-1).text, /^Nothing to submit yet/);
});
