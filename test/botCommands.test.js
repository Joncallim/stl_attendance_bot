import test from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_PRIVATE_KEY ??= "test-key";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.GOOGLE_SHEETS_SPREADSHEET_ID ??= "test-sheet";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ??= "bot@example.com";

const { __testing } = await import("../src/bot.js");

function createCtx(text = "/command") {
  const replies = [];

  return {
    chat: { id: "chat-1" },
    from: { id: "user-1", username: "tester", first_name: "Test" },
    message: { text },
    replies,
    async reply(message, extra) {
      replies.push({ message, extra });
    }
  };
}

test("onboard command resets state and prompts for a secret code", async () => {
  const ctx = createCtx("/onboard");
  const calls = [];

  await __testing.handleOnboardCommand(
    ctx,
    { timezone: "Asia/Singapore" },
    {
      registerUser: async () => calls.push("registerUser"),
      ensureSheetReadiness: async (_sheets, _config, _cache) => calls.push("ensureSheetReadiness"),
      resetConversationState: async () => calls.push("resetConversationState"),
      askForSecretCode: async () => calls.push("askForSecretCode"),
      sheets: {},
      adminCache: {}
    }
  );

  assert.deepEqual(calls, [
    "registerUser",
    "ensureSheetReadiness",
    "resetConversationState",
    "askForSecretCode"
  ]);
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0].message, /shared monthly Google Sheet/);
  assert.match(ctx.replies[0].message, /secret code assigned to your appointment/);
});

test("invite command opens submenu when no appointment is provided", async () => {
  const ctx = createCtx("/invite");
  const calls = [];

  await __testing.handleInviteCommand(
    ctx,
    {},
    { timezone: "Asia/Singapore" },
    {
      requireAdmin: async () => true,
      ensureSheetReadiness: async () => calls.push("ensureSheetReadiness"),
      renderInviteSubmenu: async (_ctx, _cache, page) => calls.push(`renderInviteSubmenu:${page}`),
      getOnboardingInvite: async () => {
        throw new Error("should not fetch invite");
      },
      buildInviteMessage: () => "unused",
      buildInviteReplyMarkup: () => ({ inline_keyboard: [] }),
      sheets: {},
      adminCache: {}
    }
  );

  assert.deepEqual(calls, ["ensureSheetReadiness", "renderInviteSubmenu:0"]);
  assert.equal(ctx.replies.length, 0);
});

test("invite command replies with invite message when appointment exists", async () => {
  const ctx = createCtx("/invite ALPHA");
  const replies = ctx.replies;

  await __testing.handleInviteCommand(
    ctx,
    { telegram: {} },
    { timezone: "Asia/Singapore" },
    {
      requireAdmin: async () => true,
      ensureSheetReadiness: async () => {},
      renderInviteSubmenu: async () => {
        throw new Error("should not render submenu");
      },
      getOnboardingInvite: async (appointment) => ({
        ok: true,
        appointment,
        secretCode: "ABCD1234"
      }),
      buildInviteMessage: (invite, _bot, options) =>
        `Invite for ${invite.appointment}: ${invite.secretCode} (${options?.html ? "html" : "plain"})`,
      buildInviteReplyMarkup: () => ({ inline_keyboard: [[{ text: "Open" }]] }),
      sheets: {},
      adminCache: {}
    }
  );

  assert.equal(replies.length, 1);
  assert.equal(replies[0].message, "Invite for ALPHA: ABCD1234 (html)");
  assert.deepEqual(replies[0].extra, {
    inline_keyboard: [[{ text: "Open" }]],
    parse_mode: "HTML"
  });
});

test("invite command reports missing appointments", async () => {
  const ctx = createCtx("/invite UNKNOWN");

  await __testing.handleInviteCommand(
    ctx,
    {},
    { timezone: "Asia/Singapore" },
    {
      requireAdmin: async () => true,
      ensureSheetReadiness: async () => {},
      renderInviteSubmenu: async () => {},
      getOnboardingInvite: async () => ({ ok: false }),
      buildInviteMessage: () => "unused",
      buildInviteReplyMarkup: () => ({}),
      sheets: {},
      adminCache: {}
    }
  );

  assert.equal(ctx.replies.length, 1);
  assert.equal(ctx.replies[0].message, "Appointment not found in the active onboarding roster.");
});

test("admin menu description includes the current pre-v1 version", () => {
  const description = __testing.buildAdminMenuDescription();

  assert.match(description, /^Admin Menu \(v0\.9\.1\)/);
});

test("triggerBackgroundSheetRefresh starts a non-blocking refresh when idle", () => {
  const runCycleCalls = [];
  const result = __testing.triggerBackgroundSheetRefresh({
    syncManager: {
      getStatus: () => ({ cycleInProgress: false }),
      runCycle: async (options) => {
        runCycleCalls.push(options);
      }
    }
  }, "home:summary");

  assert.equal(result, true);
  assert.deepEqual(runCycleCalls, [{ force: false, reason: "home:summary" }]);
});

test("triggerBackgroundSheetRefresh skips duplicate refreshes while a cycle is running", () => {
  const runCycleCalls = [];
  const result = __testing.triggerBackgroundSheetRefresh({
    syncManager: {
      getStatus: () => ({ cycleInProgress: true }),
      runCycle: async (options) => {
        runCycleCalls.push(options);
      }
    }
  }, "home:summary");

  assert.equal(result, false);
  assert.deepEqual(runCycleCalls, []);
});

test("syncroster admin action refreshes sheets and reports current and next month", async () => {
  const messages = [];
  const calls = [];

  await __testing.handleSyncRosterAdminAction(
    {},
    { onboardingSheetTitle: "ONBOARDING", timezone: "Asia/Singapore" },
    {
      syncRosterState: async () => {
        calls.push("syncRosterState");
        return { currentMonthTitle: "Mar 26", nextMonthTitle: "Apr 26" };
      },
      ensureNextMonthSheetExists: async () => calls.push("ensureNextMonthSheetExists"),
      refreshAdminCache: async () => calls.push("refreshAdminCache"),
      preloadSheetSnapshots: async (_sheets, _config, _cache, options) => {
        calls.push(`preloadSheetSnapshots:${options.force}`);
      },
      sendOrUpdateAdminMessage: async (_ctx, message) => {
        messages.push(message);
      },
      sheets: {},
      cache: {}
    }
  );

  assert.deepEqual(calls, [
    "syncRosterState",
    "ensureNextMonthSheetExists",
    "refreshAdminCache",
    "preloadSheetSnapshots:true"
  ]);
  assert.equal(
    messages[0],
    "Syncing roster with Google Sheets. If Google is slow, this will stop early instead of hanging."
  );
  assert.equal(
    messages[1],
    "Roster synced from ONBOARDING. Current month: Mar 26. Next month: Apr 26."
  );
});

test("options reset restores onboarding defaults and refreshes caches", async () => {
  const config = {
    attendanceOptions: ["TEMP", "OTHER"],
    onboardingAttendanceOptions: ["PRESENT", "WFH", "OS"],
    attendanceGroups: [],
    timezone: "Asia/Singapore"
  };
  const calls = [];
  const messages = [];

  await __testing.handleOptionsResetAction(
    {},
    config,
    {
      resetAttendanceOptions: async () => calls.push("resetAttendanceOptions"),
      syncRosterState: async () => calls.push("syncRosterState"),
      ensureNextMonthSheetExists: async () => calls.push("ensureNextMonthSheetExists"),
      refreshAdminCache: async () => calls.push("refreshAdminCache"),
      preloadSheetSnapshots: async (_sheets, _config, _cache, options) => {
        calls.push(`preloadSheetSnapshots:${options.force}`);
      },
      sendOrUpdateAdminMessage: async (_ctx, message, extra) => {
        messages.push({ message, extra });
      },
      sheets: {},
      adminCache: {}
    }
  );

  assert.deepEqual(config.attendanceOptions, ["PRESENT", "WFH", "OS"]);
  assert.deepEqual(calls, [
    "resetAttendanceOptions",
    "syncRosterState",
    "ensureNextMonthSheetExists",
    "refreshAdminCache",
    "preloadSheetSnapshots:true"
  ]);
  assert.equal(
    messages[0].message,
    "Resetting attendance options and refreshing active sheets. This will stop early if Google Sheets is slow."
  );
  assert.equal(messages[1].message, "Attendance options have been reset to the settings.yaml default list.");
  assert.ok(messages[1].extra);
});

test("syncroster admin action fails fast when Google Sheets is too slow", async () => {
  const messages = [];

  await __testing.handleSyncRosterAdminAction(
    {},
    { onboardingSheetTitle: "ONBOARDING", timezone: "Asia/Singapore" },
    {
      timeoutMs: 5,
      syncRosterState: async () => new Promise(() => {}),
      ensureNextMonthSheetExists: async () => {},
      refreshAdminCache: async () => {},
      preloadSheetSnapshots: async () => {},
      sendOrUpdateAdminMessage: async (_ctx, message) => {
        messages.push(message);
      },
      sheets: {},
      cache: {}
    }
  );

  assert.equal(
    messages[0],
    "Syncing roster with Google Sheets. If Google is slow, this will stop early instead of hanging."
  );
  assert.equal(
    messages[1],
    "Roster sync is taking too long because Google Sheets is slow. Please try again later."
  );
});

test("manage admins description keeps default admins ordered and marks not onboarded", () => {
  const description = __testing.buildManageAdminsDescription(
    [
      { appointment: "ALPHA", source: "custom" }
    ],
    [
      { appointment: "CO", boundChatId: "chat-1" },
      { appointment: "XO", boundChatId: null },
      { appointment: "COXN", boundChatId: null },
      { appointment: "SCSE", boundChatId: "chat-2" },
      { appointment: "OPS 1", boundChatId: null }
    ],
    ["SCSE", "Coxn", "CO", "XO", "OPS 1"]
  );

  assert.match(description, /• CO \(default, onboarded\)/);
  assert.match(description, /• XO \(default, not onboarded\)/);
  assert.match(description, /• COXN \(default, not onboarded\)/);
  assert.match(description, /• SCSE \(default, onboarded\)/);
  assert.match(description, /• OPS 1 \(default, not onboarded\)/);
  assert.match(description, /• ALPHA \(custom, onboarded\)/);
  assert.ok(description.indexOf("• CO (default, onboarded)") < description.indexOf("• XO (default, not onboarded)"));
  assert.ok(description.indexOf("• XO (default, not onboarded)") < description.indexOf("• COXN (default, not onboarded)"));
  assert.ok(description.indexOf("• COXN (default, not onboarded)") < description.indexOf("• SCSE (default, onboarded)"));
  assert.ok(description.indexOf("• SCSE (default, onboarded)") < description.indexOf("• OPS 1 (default, not onboarded)"));
});

test("attendance options description uses canonical order and aligned labels", () => {
  const description = __testing.buildAttendanceOptionsDescription(
    ["WFH", "PRESENT", "PH", "SR", "FISHING", "MC", "DUTY", "OSD"],
    ["PRESENT", "DUTY", "PH", "OSD", "WFH", "FISHING", "SR", "MC"]
  );

  assert.ok(description.indexOf("<code>PRESENT") < description.indexOf("<code>DUTY"));
  assert.ok(description.indexOf("<code>DUTY") < description.indexOf("Public Holiday"));
  assert.ok(description.indexOf("Public Holiday") < description.indexOf("Overseas Duty"));
  assert.ok(description.indexOf("Overseas Duty") < description.indexOf("Work from Home"));
  assert.ok(description.indexOf("Work from Home") < description.indexOf("<code>FISHING"));
  assert.ok(description.indexOf("<code>FISHING") < description.indexOf("Sunday Routine"));
  assert.ok(description.includes("Medical Certificate"));
  assert.match(description, /<code>SR(?:&nbsp;|\u00A0)<\/code> \| Sunday Routine/);
  assert.match(description, /<code>MC(?:&nbsp;|\u00A0)<\/code> \| Medical Certificate/);
  assert.match(description, /<code>FISHING<\/code>/);
  assert.doesNotMatch(description, /sort the list back/i);
});

test("attendance options description groups codes using configured attendance groups", () => {
  const description = __testing.buildAttendanceOptionsDescription(
    ["PRESENT", "DUTY", "LL", "OL"],
    ["PRESENT", "DUTY", "LL", "OL"],
    [
      { label: "Present", options: ["PRESENT", "DUTY"] },
      { label: "Leave", options: ["LL", "OL"] }
    ]
  );

  assert.match(description, /Present:/);
  assert.match(description, /Leave:/);
  assert.ok(description.indexOf("Present:") < description.indexOf("Leave:"));
  assert.ok(description.indexOf("PRESENT") < description.indexOf("LL"));
});

test("department workweek view uses the viewer's own department for non-admins", () => {
  const cache = {
    activeCodes: [
      { appointment: "CO" },
      { appointment: "SCSE (IN)" },
      { appointment: "CComms" },
      { appointment: "Comms 1" }
    ],
    sheetSnapshots: {
      synchronizedAt: "2026-03-24T00:00:00.000Z",
      snapshots: new Map([["Mar 26", {
        appointments: ["CO", "SCSE (IN)", "CComms", "Comms 1"],
        statusesByDay: new Map([
          [24, ["PRESENT", "WFH", "DUTY", ""]],
          [25, ["", "", "", "MC"]],
          [26, ["", "", "", ""]],
          [27, ["", "", "", ""]],
          [28, ["", "", "", ""]]
        ])
      }]])
    }
  };
  const config = {
    timezone: "Asia/Singapore",
    hierarchy: [
      { key: "OFFICERS", label: "Officers" },
      { key: "COMMS", label: "Comms" }
    ],
    appointmentMetadataByName: new Map([
      ["CO", { hierarchyNodeKey: "OFFICERS" }],
      ["SCSE (IN)", { hierarchyNodeKey: "OFFICERS" }],
      ["CCOMMS", { hierarchyNodeKey: "COMMS" }],
      ["COMMS 1", { hierarchyNodeKey: "COMMS" }]
    ])
  };

  const viewModel = __testing.buildDepartmentWorkweekViewModel(
    cache,
    config,
    { appointment: "Comms 1" },
    { departmentKey: "OFFICERS", isAdminUser: false, weekOffset: 0 }
  );

  assert.equal(viewModel.ok, true);
  assert.equal(viewModel.departmentKey, "COMMS");
  assert.equal(viewModel.departmentLabel, "Comms");
  assert.equal(viewModel.canSwitchDepartments, false);
  assert.deepEqual(viewModel.members.map((member) => member.appointment), ["CComms", "Comms 1"]);
});

test("department workweek view lets admins switch and keeps department order fixed", () => {
  const cache = {
    activeCodes: [
      { appointment: "CO" },
      { appointment: "SCSE" },
      { appointment: "Chief Comms Specialist" },
      { appointment: "Comms Specialist 1" }
    ],
    sheetSnapshots: {
      synchronizedAt: "2026-03-24T00:00:00.000Z",
      snapshots: new Map([["Mar 26", {
        appointments: ["CO", "SCSE", "Chief Comms Specialist", "Comms Specialist 1"],
        statusesByDay: new Map([[24, ["PRESENT", "", "", ""]]])
      }]])
    }
  };
  const config = {
    timezone: "Asia/Singapore",
    hierarchy: [
      { key: "OFFICERS", label: "Officers" },
      { key: "COMMS_SPECIALIST", label: "Comms Specialist" }
    ],
    appointmentMetadataByName: new Map([
      ["CO", { hierarchyNodeKey: "OFFICERS" }],
      ["SCSE", { hierarchyNodeKey: "OFFICERS" }],
      ["CHIEF COMMS SPECIALIST", { hierarchyNodeKey: "COMMS_SPECIALIST" }],
      ["COMMS SPECIALIST 1", { hierarchyNodeKey: "COMMS_SPECIALIST" }]
    ])
  };

  const viewModel = __testing.buildDepartmentWorkweekViewModel(
    cache,
    config,
    { appointment: "CO" },
    { departmentKey: "COMMS_SPECIALIST", isAdminUser: true, weekOffset: 0 }
  );

  assert.equal(viewModel.ok, true);
  assert.equal(viewModel.departmentLabel, "Comms Specialist");
  assert.equal(viewModel.canSwitchDepartments, true);
  assert.deepEqual(
    viewModel.allDepartmentOptions.map((entry) => entry.label),
    ["Officers", "Comms Specialist"]
  );
  assert.deepEqual(
    viewModel.members.map((member) => member.appointment),
    ["Chief Comms Specialist", "Comms Specialist 1"]
  );
});

test("invite message formats the secret code as HTML code with copy instructions", () => {
  const message = __testing.buildInviteMessage(
    { appointment: "ALPHA", secretCode: "ABCD1234" },
    { botInfo: { username: "attendance_bot" } },
    { html: true }
  );

  assert.match(message, /<code>ABCD1234<\/code>/);
  assert.match(message, /Tap and hold the code block to copy it/);
  assert.match(message, /https:\/\/t\.me\/attendance_bot/);
});

test("attendance options menu is sent with HTML parse mode", async () => {
  const ctx = createCtx("/admin");

  await __testing.renderAttendanceOptionsMenu(ctx, {
    attendanceOptions: ["PRESENT", "PH", "SR"],
    onboardingAttendanceOptions: ["PRESENT", "PH", "SR"]
  });

  assert.equal(ctx.replies.length, 1);
  assert.equal(ctx.replies[0].extra?.parse_mode, "HTML");
  assert.match(ctx.replies[0].message, /<code>PRESENT/);
});

test("invitation admin description includes non-onboarded count", () => {
  assert.equal(
    __testing.buildInvitationAdminDescription(1),
    [
      "Send Invitation",
      "",
      "1 person is currently not onboarded.",
      "Select a person to generate and send a forwardable invitation message."
    ].join("\n")
  );

  assert.equal(
    __testing.buildInvitationAdminDescription(3),
    [
      "Send Invitation",
      "",
      "3 people are currently not onboarded.",
      "Select a person to generate and send a forwardable invitation message."
    ].join("\n")
  );
});

test("invite submenu shows the current non-onboarded count in the admin message", async () => {
  const ctx = createCtx("/admin");

  await __testing.renderInviteSubmenu(ctx, {
    inviteCandidates: [
      { label: "ALPHA", appointment: "ALPHA" },
      { label: "BRAVO", appointment: "BRAVO" },
      { label: "CHARLIE", appointment: "CHARLIE" }
    ]
  }, 0);

  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0].message, /3 people are currently not onboarded\./);
  assert.match(ctx.replies[0].message, /Select a person to generate and send a forwardable invitation message\./);
});

test("summary message uses grouped headers and can hide unaccounted", () => {
  const message = __testing.formatSummaryMessage({
    date: new Date("2026-03-24T12:00:00.000Z"),
    synchronizedAt: new Date("2026-03-24T12:30:00.000Z").toISOString(),
    summary: {
      total: 10,
      accountedAttendance: 9,
      unaccounted: 1,
      present: 2,
      ph: 1,
      osd: 1,
      oe: 1,
      wfh: 1,
      fishing: 1,
      off: 1,
      outstationed: 1,
      reportSick: 1,
      localLeave: 1,
      overseasLeave: 1,
      attachedOut: 1,
      onCourse: 1,
      postedOut: 2,
      inBase: 1
    },
    counts: [
      ["PRESENT", 1],
      ["DUTY", 1],
      ["PH", 1],
      ["OSD", 1],
      ["OE", 1],
      ["WFH", 1],
      ["FISHING", 1],
      ["OFF", 1],
      ["OS", 1],
      ["RSO", 1],
      ["LL", 1],
      ["OL", 1],
      ["AO", 1],
      ["OC", 1],
      ["ORD", 1],
      ["POST OUT", 1],
      ["IPPT", 1]
    ]
  }, { timezone: "Asia/Singapore" }, { hideUnaccounted: true });

  assert.match(message, /<b><u>Total PRESENT:<\/u><\/b> 2/);
  assert.match(message, /PRESENT: 1/);
  assert.match(message, /DUTY: 1/);
  assert.match(message, /<b><u>Outstationed:<\/u><\/b> 1/);
  assert.match(message, /OS: 1/);
  assert.match(message, /<b><u>Report Sick:<\/u><\/b> 1/);
  assert.match(message, /RSO: 1/);
  assert.match(message, /<b><u>In Base:<\/u><\/b> 1/);
  assert.match(message, /IPPT: 1/);
  assert.doesNotMatch(message, /<b>Unaccounted:/);
});

test("summary message uses configured attendance groups when provided", () => {
  const message = __testing.formatSummaryMessage({
    date: new Date("2026-03-24T12:00:00.000Z"),
    synchronizedAt: new Date("2026-03-24T12:30:00.000Z").toISOString(),
    summary: {
      total: 4,
      accountedAttendance: 4,
      unaccounted: 0
    },
    counts: [
      ["PRESENT", 1],
      ["DUTY", 1],
      ["LL", 1],
      ["OL", 1]
    ]
  }, {
    timezone: "Asia/Singapore",
    attendanceGroups: [
      { summaryLabel: "Total PRESENT", label: "Present", options: ["PRESENT", "DUTY"] },
      { summaryLabel: "Leave", label: "Leave", options: ["LL", "OL"] }
    ]
  });

  assert.match(message, /<b><u>Total PRESENT:<\/u><\/b> 2/);
  assert.match(message, /PRESENT: 1/);
  assert.match(message, /DUTY: 1/);
  assert.match(message, /<b><u>Leave:<\/u><\/b> 2/);
  assert.match(message, /LL: 1/);
  assert.match(message, /OL: 1/);
});

test("summary menu can omit unaccounted button", () => {
  const menu = __testing.buildSummaryMenu(
    new Date("2026-03-28T12:00:00.000Z"),
    "Asia/Singapore",
    "home:main",
    { includeUnaccounted: false }
  );

  const labels = menu.reply_markup.inline_keyboard.flat().map((button) => button.text);
  assert.ok(!labels.includes("🕳️ Unaccounted"));
});

test("background schedules keep both 1-minute and 5-minute reconciliation intervals", async () => {
  const intervals = [];
  const schedules = [];
  const runCycleCalls = [];

  __testing.registerBackgroundSchedules({
    bot: {},
    sheets: {},
    config: {
      timezone: "Asia/Singapore",
      firstReminderTime: "07:00",
      secondReminderTime: "08:00"
    },
    adminCache: {
      syncManager: {
        runCycle: async (options) => {
          runCycleCalls.push(options);
        }
      }
    },
    deps: {
      setIntervalFn: (fn, delay) => {
        intervals.push({ fn, delay });
        return delay;
      },
      setTimeoutFn: () => 0,
      scheduleFn: (expression, fn, options) => {
        schedules.push({ expression, fn, options });
        return { stop() {} };
      },
      refreshAttendanceOptionUsageFn: async () => {},
      runDailySheetMaintenanceFn: async () => {}
    }
  });

  assert.deepEqual(
    intervals.map((entry) => entry.delay),
    [60 * 1000, 5 * 60 * 1000]
  );
  // First cron is midnight structural maintenance; second is 00:05 queue compaction.
  assert.equal(schedules[0].expression, "0 0 * * *");
  assert.equal(schedules[1].expression, "5 0 * * *");
  assert.ok(schedules.some((entry) => entry.expression === "0 7 * * *"));
  assert.ok(schedules.some((entry) => entry.expression === "0 8 * * *"));
  // Startup cycle is now lightweight (force: false).
  assert.deepEqual(runCycleCalls, [{ force: false, reason: "startup" }]);
});

test("scheduled reminder forces a sync before sending prompts", async () => {
  const schedules = [];
  const runCycleCalls = [];
  const prompts = [];

  __testing.registerBackgroundSchedules({
    bot: {},
    sheets: {},
    config: {
      timezone: "Asia/Singapore",
      firstReminderTime: "07:00",
      secondReminderTime: "08:00"
    },
    adminCache: {
      syncManager: {
        runCycle: async (options) => {
          runCycleCalls.push(options);
        }
      }
    },
    deps: {
      setIntervalFn: () => 0,
      setTimeoutFn: () => 0,
      scheduleFn: (expression, fn) => {
        schedules.push({ expression, fn });
        return { stop() {} };
      },
      refreshAttendanceOptionUsageFn: async () => {},
      runDailySheetMaintenanceFn: async () => {},
      isReminderWorkingDayFn: async () => true,
      listUsersFn: async () => [{ chatId: "chat-1", appointment: "ALPHA" }],
      sendPromptToChatFn: async (_bot, _config, chatId) => {
        prompts.push(chatId);
      }
    }
  });

  const reminderSchedule = schedules.find((entry) => entry.expression === "0 7 * * *");
  await reminderSchedule.fn();

  assert.deepEqual(runCycleCalls, [
    { force: false, reason: "startup" },
    { force: true, reason: "reminder" }
  ]);
  assert.deepEqual(prompts, ["chat-1"]);
});

test("scheduled reminder still sends prompts when pre-send sync fails", async () => {
  const schedules = [];
  const prompts = [];

  __testing.registerBackgroundSchedules({
    bot: {},
    sheets: {},
    config: {
      timezone: "Asia/Singapore",
      firstReminderTime: "07:00",
      secondReminderTime: "08:00"
    },
    adminCache: {
      syncManager: {
        runCycle: async (options) => {
          if (options.reason === "startup") {
            return;
          }

          throw new Error("rate limit");
        }
      }
    },
    deps: {
      setIntervalFn: () => 0,
      setTimeoutFn: () => 0,
      scheduleFn: (expression, fn) => {
        schedules.push({ expression, fn });
        return { stop() {} };
      },
      refreshAttendanceOptionUsageFn: async () => {},
      runDailySheetMaintenanceFn: async () => {},
      isReminderWorkingDayFn: async () => true,
      listUsersFn: async () => [{ chatId: "chat-1", appointment: "ALPHA" }],
      sendPromptToChatFn: async (_bot, _config, chatId) => {
        prompts.push(chatId);
      }
    }
  });

  const reminderSchedule = schedules.find((entry) => entry.expression === "0 7 * * *");
  await reminderSchedule.fn();

  assert.deepEqual(prompts, ["chat-1"]);
});

test("0800 reminder only sends to users with unfilled attendance", async () => {
  const schedules = [];
  const prompts = [];
  const fixedNow = new Date("2026-03-24T00:05:00.000Z");
  const RealDate = Date;

  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedNow);
        return;
      }

      super(...args);
    }

    static now() {
      return fixedNow.valueOf();
    }
  }

  __testing.registerBackgroundSchedules({
    bot: {},
    sheets: {},
    config: {
      timezone: "Asia/Singapore",
      firstReminderTime: "07:00",
      secondReminderTime: "08:00"
    },
    adminCache: {
      syncManager: {
        runCycle: async () => {}
      },
      sheetSnapshots: {
        snapshots: new Map([["Mar 26", {
          date: new Date("2026-03-24T00:00:00.000Z").toISOString(),
          appointments: ["ALPHA", "BRAVO"],
          statusesByDay: new Map([[24, ["PRESENT", ""]]])
        }]])
      }
    },
    deps: {
      setIntervalFn: () => 0,
      setTimeoutFn: () => 0,
      scheduleFn: (expression, fn) => {
        schedules.push({ expression, fn });
        return { stop() {} };
      },
      refreshAttendanceOptionUsageFn: async () => {},
      runDailySheetMaintenanceFn: async () => {},
      isReminderWorkingDayFn: async () => true,
      listUsersFn: async () => [
        { chatId: "chat-1", appointment: "ALPHA" },
        { chatId: "chat-2", appointment: "BRAVO" }
      ],
      sendPromptToChatFn: async (_bot, _config, chatId) => {
        prompts.push(chatId);
      }
    }
  });

  global.Date = FixedDate;

  try {
    const reminderSchedule = schedules.find((entry) => entry.expression === "0 8 * * *");
    await reminderSchedule.fn();
  } finally {
    global.Date = RealDate;
  }

  assert.deepEqual(prompts, ["chat-2"]);
});
