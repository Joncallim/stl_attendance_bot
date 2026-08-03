import test from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_PRIVATE_KEY ??= "test-key";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.GOOGLE_SHEETS_SPREADSHEET_ID ??= "test-sheet";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ??= "bot@example.com";

const { __testing } = await import("../src/bot.js");
const {
  __testing: priorityTesting,
  getWorkPriorityStatus,
  runWithBackgroundPriority,
  runWithInteractivePriority
} = await import("../src/workPriority.js");
const { shouldDeferSnapshotRefresh } = await import("../src/broadcastActivity.js");

test("interactive Sheet transactions take the next safe transaction boundary", async () => {
  priorityTesting.reset();
  priorityTesting.setQuietPeriodMs(0);
  try {
    const order = [];
    let releaseBackground;
    let backgroundStarted;
    const backgroundStartedPromise = new Promise((resolve) => {
      backgroundStarted = resolve;
    });

    const firstBackground = runWithBackgroundPriority(() =>
      __testing.withSheetOperation(async () => {
        order.push("background:start");
        backgroundStarted();
        await new Promise((resolve) => {
          releaseBackground = resolve;
        });
        order.push("background:end");
      })
    );
    await backgroundStartedPromise;

    const queuedBackground = runWithBackgroundPriority(() =>
      __testing.withSheetOperation(async () => {
        order.push("background:queued");
      })
    );
    const interactive = runWithInteractivePriority(() =>
      __testing.withSheetOperation(async () => {
        order.push("interactive");
      })
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getWorkPriorityStatus().backgroundSheetProgressRequired, true);
    releaseBackground();
    await Promise.all([firstBackground, queuedBackground, interactive]);

    assert.deepEqual(order, [
      "background:start",
      "background:end",
      "interactive",
      "background:queued"
    ]);
    assert.equal(getWorkPriorityStatus().backgroundSheetProgressRequired, false);
  } finally {
    priorityTesting.reset();
  }
});

test("daily attendance idempotency is scoped to one Telegram prompt", () => {
  const first = __testing.buildDailyAttendanceIdempotencyKey(
    "chat-1",
    "prompt-1",
    "2026-03-24",
    "PRESENT"
  );
  const replay = __testing.buildDailyAttendanceIdempotencyKey(
    "chat-1",
    "prompt-1",
    "2026-03-24",
    "PRESENT"
  );
  const laterPrompt = __testing.buildDailyAttendanceIdempotencyKey(
    "chat-1",
    "prompt-2",
    "2026-03-24",
    "PRESENT"
  );

  assert.equal(first, replay);
  assert.notEqual(first, laterPrompt);
});

test("missing attendance contact buttons cascade at three per row", () => {
  const rows = ["A", "B", "C", "D", "E"].map((name) => [{ text: name, callback_data: name }]);
  const keyboard = __testing.buildUnaccountedMenu(
    new Date("2026-03-24T00:00:00.000Z"),
    "UTC",
    rows,
    "home:main",
    "home"
  ).reply_markup.inline_keyboard;

  assert.deepEqual(keyboard.slice(0, 2).map((row) => row.length), [3, 2]);
  assert.ok(keyboard.every((row) => row.length <= 3));
});

test("broadcast recipients are unique registered Telegram users", () => {
  const recipients = __testing.getBroadcastRecipients([
    { appointment: "A", chatId: "10" },
    { appointment: "B", chatId: 10 },
    { appointment: "C", chatId: "11" },
    { appointment: null, chatId: "12" }
  ]);

  assert.deepEqual(recipients.map((user) => user.appointment), ["A", "C"]);
  assert.equal(__testing.formatAnnouncementMessage("Latest update"), "📢 Stalwart Announcement Bot\n\nLatest update");
});

test("attendance transfer conflict message explains the actionable sheet cells", () => {
  const message = __testing.formatAttendanceTransferBlockedMessage(
    [
      {
        title: "Jul 26",
        reason: "destination_has_attendance",
        conflictingDates: ["14 Jul", "15 Jul"]
      },
      { title: "Aug 26", reason: "transfer_aborted_due_to_conflict" }
    ],
    "Nav OJT4"
  );

  assert.match(message, /No binding or attendance was changed/);
  assert.match(message, /Jul 26: Nav OJT4 already has different attendance on 14 Jul, 15 Jul/);
  assert.match(message, /other months were left unchanged/);
  assert.doesNotMatch(message, /destination_has_attendance|transfer_aborted_due_to_conflict/);
});

test("duplicate appointment rows block an attendance transfer before the binding moves", () => {
  const results = [{
    title: "Aug 26",
    skipped: true,
    reason: "duplicate_appointment_row",
    fromRowNumbers: [2, 8],
    toRowNumbers: [3]
  }];

  assert.equal(__testing.isAttendanceTransferBlocked(results), true);
  assert.match(
    __testing.formatAttendanceTransferBlockedMessage(results, "BRAVO"),
    /appointment appears more than once/
  );
});

test("live transfer cleanup retains its journal when any source clear is blocked", async () => {
  const calls = [];
  const result = await __testing.completeAttendanceTransferCleanup({
    journal: { id: "journal-1", fromAppointment: "ALPHA", toAppointment: "BRAVO" },
    sheets: {},
    config: {},
    transferAttendanceRowsFn: async (_sheets, _config, _from, _to, options) => {
      calls.push(options);
      return [{ title: "Aug 26", skipped: true, reason: "duplicate_appointment_row" }];
    },
    updateJournalFn: async () => calls.push("update"),
    clearJournalFn: async () => calls.push("clear")
  });

  assert.equal(result.cleaned, false);
  assert.deepEqual(calls, [{ phase: "clear" }]);
});

test("restart recovery retains blocked and legacy partial transfer journals", async () => {
  const calls = [];
  const committed = await __testing.recoverAttendanceTransferJournal({
    journal: {
      id: "journal-committed",
      phase: "binding_committed",
      fromAppointment: "ALPHA",
      toAppointment: "BRAVO"
    },
    registry: { appointments: [{ appointment: "ALPHA", boundChatId: null }, { appointment: "BRAVO", boundChatId: "chat-1" }] },
    sheets: {},
    config: {},
    transferAttendanceRowsFn: async () => [{ title: "Aug 26", conflict: true, reason: "destination_has_attendance" }],
    updateJournalFn: async () => calls.push("update"),
    clearJournalFn: async () => calls.push("clear")
  });
  const partial = await __testing.recoverAttendanceTransferJournal({
    journal: {
      id: "journal-partial",
      phase: "copied",
      fromAppointment: "ALPHA",
      toAppointment: "BRAVO"
    },
    registry: { appointments: [] },
    sheets: {},
    config: {},
    transferAttendanceRowsFn: async () => {
      throw new Error("partial journals must not replay automatically");
    }
  });

  assert.equal(committed.reason, "cleanup_blocked");
  assert.equal(partial.reason, "missing_binding_identity");
  assert.deepEqual(calls, []);
});

test("restart recovery resumes a prepared transfer only with its persisted binding identity", async () => {
  const source = {
    appointment: "ALPHA",
    boundChatId: "chat-1",
    boundAt: "2026-03-24T00:00:00.000Z"
  };
  const expectedBindingIdentity = "ALPHA\u0000chat-1\u00002026-03-24T00:00:00.000Z";
  const calls = [];
  const result = await __testing.recoverAttendanceTransferJournal({
    journal: {
      id: "prepared-journal",
      phase: "prepared",
      fromAppointment: "ALPHA",
      toAppointment: "BRAVO",
      expectedFromBindingIdentity: expectedBindingIdentity
    },
    registry: { appointments: [source, { appointment: "BRAVO", boundChatId: null }] },
    sheets: {},
    config: {},
    transferAttendanceRowsFn: async (_sheets, _config, _from, _to, options) => {
      calls.push(`sheet:${options.phase}`);
      return [{ title: "Mar 26", transferred: true }];
    },
    transferAppointmentBindingFn: async (_from, _to, options) => {
      calls.push(`binding:${options.expectedFromBindingIdentity}`);
      assert.deepEqual(await options.prepare(), { ok: true });
      return { ok: true };
    },
    updateJournalFn: async (_id, phase) => calls.push(`journal:${phase}`),
    clearJournalFn: async () => calls.push("journal:clear")
  });

  assert.equal(result.recovered, true);
  assert.deepEqual(calls, [
    "sheet:copy",
    "journal:copied",
    `binding:${expectedBindingIdentity}`,
    "journal:binding_committed",
    "sheet:clear",
    "journal:completed",
    "journal:clear"
  ]);
});

test("restart recovery resumes a copied transfer without replaying its remote copy", async () => {
  const expectedBindingIdentity = "ALPHA\u0000chat-1\u00002026-03-24T00:00:00.000Z";
  const calls = [];
  const result = await __testing.recoverAttendanceTransferJournal({
    journal: {
      id: "copied-journal",
      phase: "copied",
      fromAppointment: "ALPHA",
      toAppointment: "BRAVO",
      expectedFromBindingIdentity: expectedBindingIdentity
    },
    registry: {
      appointments: [
        { appointment: "ALPHA", boundChatId: "chat-1", boundAt: "2026-03-24T00:00:00.000Z" },
        { appointment: "BRAVO", boundChatId: null }
      ]
    },
    sheets: {},
    config: {},
    transferAttendanceRowsFn: async (_sheets, _config, _from, _to, options) => {
      calls.push(`sheet:${options.phase}`);
      assert.equal(options.phase, "clear");
      return [{ title: "Mar 26", transferred: true }];
    },
    transferAppointmentBindingFn: async (_from, _to, options) => {
      calls.push("binding");
      assert.deepEqual(await options.prepare(), { ok: true });
      return { ok: true };
    },
    updateJournalFn: async (_id, phase) => calls.push(`journal:${phase}`),
    clearJournalFn: async () => calls.push("journal:clear")
  });

  assert.equal(result.recovered, true);
  assert.deepEqual(calls, [
    "binding",
    "journal:binding_committed",
    "sheet:clear",
    "journal:completed",
    "journal:clear"
  ]);
});

test("restart recovery clears source attendance when binding committed before copied journal advanced", async () => {
  const expectedBindingIdentity = "ALPHA\u0000chat-1\u00002026-03-24T00:00:00.000Z";
  const calls = [];
  const result = await __testing.recoverAttendanceTransferJournal({
    journal: {
      id: "copied-after-binding-journal",
      phase: "copied",
      fromAppointment: "ALPHA",
      toAppointment: "BRAVO",
      expectedFromBindingIdentity: expectedBindingIdentity
    },
    registry: {
      appointments: [
        { appointment: "ALPHA", boundChatId: null },
        { appointment: "BRAVO", boundChatId: "chat-1", boundAt: "2026-03-24T00:00:00.000Z" }
      ]
    },
    sheets: {},
    config: {},
    transferAttendanceRowsFn: async (_sheets, _config, _from, _to, options) => {
      calls.push(`sheet:${options.phase}`);
      assert.equal(options.phase, "clear");
      return [{ title: "Mar 26", transferred: true }];
    },
    transferAppointmentBindingFn: async () => {
      throw new Error("already committed bindings must not be replayed");
    },
    updateJournalFn: async (_id, phase) => calls.push(`journal:${phase}`),
    clearJournalFn: async () => calls.push("journal:clear")
  });

  assert.equal(result.recovered, true);
  assert.deepEqual(calls, [
    "journal:binding_committed",
    "sheet:clear",
    "journal:completed",
    "journal:clear"
  ]);
});

test("weekly retry keys supersede a prior status after crash recovery", () => {
  const absent = __testing.buildWeeklyAttendanceIdempotencyKey(
    "flow-1", "ALPHA", "2026-03-24", "ABSENT"
  );
  const present = __testing.buildWeeklyAttendanceIdempotencyKey(
    "flow-1", "ALPHA", "2026-03-24", "PRESENT"
  );

  assert.notEqual(absent, present);
});

test("stale transfer destination message does not expose internal reason codes", () => {
  const message = __testing.formatAppointmentTransferFailure(
    { ok: false, reason: "to_already_bound" },
    "Nav OJT4"
  );

  assert.match(message, /Transfer menu expired/);
  assert.match(message, /Nav OJT4 is already bound/);
  assert.doesNotMatch(message, /to_already_bound/);
});

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

  assert.match(description, /^Admin Menu \(v0\.9\.24\)/);
});

test("attendance prompt tracking is deduplicated and bounded", () => {
  const user = {
    attendancePromptMessageIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 9, "bad"]
  };

  assert.deepEqual(
    __testing.appendAttendancePromptMessageId(user, 10),
    [3, 4, 5, 6, 7, 8, 9, 10]
  );
});

test("Telegram identity validation only accepts the matching private user", () => {
  assert.equal(__testing.isPrivateTelegramIdentity({
    chat: { id: 42, type: "private" },
    from: { id: 42 }
  }), true);
  assert.equal(__testing.isPrivateTelegramIdentity({
    chat: { id: -100, type: "group" },
    from: { id: 42 }
  }), false);
  assert.equal(__testing.isPrivateTelegramIdentity({
    chat: { id: 41, type: "private" },
    from: { id: 42 }
  }), false);
});

test("daily attendance callbacks are bound to date and status content", () => {
  const config = {
    attendanceOptions: ["PRESENT", "MC"],
    timezone: "Asia/Singapore"
  };
  const menu = __testing.buildDatedAttendanceMenu(
    config,
    new Date("2026-07-30T04:00:00.000Z"),
    0,
    "home:pick:attendance",
    "home:attendance:page",
    "home:main"
  );
  const callbacks = menu.reply_markup.inline_keyboard
    .flat()
    .map((button) => button.callback_data)
    .filter((value) => value?.startsWith("home:pick:attendance"));

  assert.equal(callbacks.length, 2);
  assert.match(callbacks[0], /^home:pick:attendance:2026-07-30:0:[A-Za-z0-9_-]{8}$/);
  assert.match(callbacks[1], /^home:pick:attendance:2026-07-30:1:[A-Za-z0-9_-]{8}$/);
  assert.notEqual(callbacks[0].split(":").at(-1), callbacks[1].split(":").at(-1));
});

test("daily attendance prompt ids distinguish new prompts and stay within Telegram limits", () => {
  const config = {
    attendanceOptions: ["PRESENT", "MC"],
    timezone: "Asia/Singapore"
  };
  const menu = __testing.buildDatedAttendanceMenu(
    config,
    new Date("2026-07-30T04:00:00.000Z"),
    0,
    "home:pick:attendance",
    "home:attendance:page",
    "home:main",
    [],
    { promptId: "prompt01" }
  );
  const callbacks = menu.reply_markup.inline_keyboard
    .flat()
    .map((button) => button.callback_data)
    .filter((value) => value?.startsWith("home:pick:attendance"));

  assert.match(callbacks[0], /^home:pick:attendance:prompt01:2026-07-30:0:[A-Za-z0-9_-]{8}$/);
  assert.ok(callbacks.every((value) => Buffer.byteLength(value, "utf8") <= 64));
});

test("stale interactions leave a visible explanation even after callback acknowledgement", async () => {
  const calls = [];
  const ctx = {
    answerCbQuery: async () => { throw new Error("already answered"); },
    editMessageText: async (message) => calls.push(["edit", message]),
    editMessageReplyMarkup: async () => calls.push(["markup"]),
    reply: async (message) => calls.push(["reply", message])
  };

  await __testing.rejectExpiredInteraction(ctx, "Expired. Nothing was changed.");

  assert.deepEqual(calls, [["edit", "Expired. Nothing was changed."]]);
});

test("completed attendance removes old prompts and retires undeletable buttons", async () => {
  const deleted = [];
  const retired = [];
  const telegram = {
    async deleteMessage(chatId, messageId) {
      deleted.push([chatId, messageId]);
      if (messageId === 11) {
        throw new Error("message is too old to delete");
      }
    },
    async editMessageReplyMarkup(chatId, messageId, inlineMessageId, markup) {
      retired.push([chatId, messageId, inlineMessageId, markup]);
    }
  };

  await __testing.removeObsoleteAttendancePromptMessages(
    telegram,
    "chat-1",
    [11, 12, 13, 12],
    13
  );

  assert.deepEqual(deleted.sort((left, right) => left[1] - right[1]), [
    ["chat-1", 11],
    ["chat-1", 12]
  ]);
  assert.deepEqual(retired, [[
    "chat-1",
    11,
    undefined,
    { inline_keyboard: [] }
  ]]);
});

test("weekly flow state is restored from persisted user data after restart", () => {
  const ctx = {
    session: {
      weeklyAttendanceDates: [],
      weeklyAttendanceIndex: 0,
      weeklyAttendanceEntries: []
    }
  };
  const user = {
    weeklyAttendanceDates: [
      "2026-03-23T12:00:00.000Z",
      "2026-03-24T12:00:00.000Z"
    ],
    weeklyAttendanceIndex: 1,
    weeklyAttendanceEntries: [
      { date: "2026-03-23", status: "PRESENT" }
    ]
  };

  const state = __testing.getWeeklyAttendanceState(ctx, user);
  __testing.restoreWeeklyAttendanceSession(ctx, state);

  assert.deepEqual(state, {
    dates: user.weeklyAttendanceDates,
    index: 1,
    entries: user.weeklyAttendanceEntries
  });
  assert.equal(ctx.session.awaitingWeeklyAttendance, true);
  assert.deepEqual(ctx.session.weeklyAttendanceDates, user.weeklyAttendanceDates);
  assert.deepEqual(ctx.session.weeklyAttendanceEntries, user.weeklyAttendanceEntries);
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

test("attendance queue threshold requests an explicit background flush", async () => {
  const calls = [];
  const cache = {
    syncManager: {
      runCycle: async (options) => { calls.push(options); }
    }
  };

  const belowThreshold = await __testing.triggerAttendanceQueueThresholdFlush(cache, {
    listPendingAttendanceEventsFn: async () => Array.from({ length: 24 }, () => ({}))
  });
  const atThreshold = await __testing.triggerAttendanceQueueThresholdFlush(cache, {
    listPendingAttendanceEventsFn: async () => Array.from({ length: 25 }, () => ({}))
  });

  assert.equal(belowThreshold, false);
  assert.equal(atThreshold, true);
  assert.deepEqual(calls, [{
    force: true,
    flushQueue: true,
    reason: "queue-threshold"
  }]);
});

test("syncroster admin action refreshes sheets and reports current and next month", async () => {
  __testing.resetRosterSyncGuard();
  const messages = [];
  const calls = [];

  await __testing.handleSyncRosterAdminAction(
    {},
    { onboardingSheetTitle: "ONBOARDING", timezone: "Asia/Singapore" },
    {
      syncRosterState: async () => {
        calls.push("syncRosterState");
        return { prevMonthTitle: "Feb 26", currentMonthTitle: "Mar 26", nextMonthTitle: "Apr 26" };
      },
      refreshAdminCache: async () => calls.push("refreshAdminCache"),
      preloadSheetSnapshots: async (_sheets, _config, _cache, options) => {
        calls.push(`preloadSheetSnapshots:force=${options.force},structural=${options.structural},normalizeAliases=${options.normalizeAliases}`);
      },
      resetConflictedQueueEntries: async () => {
        calls.push("resetConflictedQueueEntries");
        return { resetCount: 0 };
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
    "refreshAdminCache",
    "preloadSheetSnapshots:force=true,structural=false,normalizeAliases=true",
    "resetConflictedQueueEntries"
  ]);
  assert.equal(
    messages[0],
    "Syncing roster with Google Sheets. This may take a minute with a large roster — please wait."
  );
  assert.equal(
    messages[1],
    [
      "✅ Roster synced from ONBOARDING.",
      "Last month: Feb 26",
      "Current month: Mar 26",
      "Next month: Apr 26"
    ].join("\n")
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

test("syncroster admin action rejects concurrent sync attempts", async () => {
  __testing.resetRosterSyncGuard();
  const messages = [];
  let resolveFirst;
  const firstSyncPending = new Promise((resolve) => { resolveFirst = resolve; });

  // Start a sync that won't complete yet — don't await it
  const firstSync = __testing.handleSyncRosterAdminAction(
    {},
    { onboardingSheetTitle: "ONBOARDING", timezone: "Asia/Singapore" },
    {
      syncRosterState: async () => firstSyncPending,
      ensureNextMonthSheetExists: async () => {},
      refreshAdminCache: async () => {},
      preloadSheetSnapshots: async () => {},
      resetConflictedQueueEntries: async () => ({ resetCount: 0 }),
      sendOrUpdateAdminMessage: async (_ctx, message) => messages.push(message),
      sheets: {},
      cache: {}
    }
  );

  // A concurrent attempt should be rejected immediately with an informational message
  await __testing.handleSyncRosterAdminAction(
    {},
    { onboardingSheetTitle: "ONBOARDING", timezone: "Asia/Singapore" },
    {
      syncRosterState: async () => { throw new Error("should not be reached"); },
      ensureNextMonthSheetExists: async () => {},
      refreshAdminCache: async () => {},
      preloadSheetSnapshots: async () => {},
      resetConflictedQueueEntries: async () => ({ resetCount: 0 }),
      sendOrUpdateAdminMessage: async (_ctx, message) => messages.push(message),
      sheets: {},
      cache: {}
    }
  );

  // Resolve the first sync and let it finish
  resolveFirst({ prevMonthTitle: "Feb 26", currentMonthTitle: "Mar 26", nextMonthTitle: "Apr 26" });
  await firstSync;

  assert.equal(
    messages[0],
    "Syncing roster with Google Sheets. This may take a minute with a large roster — please wait."
  );
  assert.equal(
    messages[1],
    "A roster sync is already in progress. Please wait for the current sync to complete."
  );
  assert.equal(
    messages[2],
    [
      "✅ Roster synced from ONBOARDING.",
      "Last month: Feb 26",
      "Current month: Mar 26",
      "Next month: Apr 26"
    ].join("\n")
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

  assert.match(description, /• CO \(default, registered\)/);
  assert.match(description, /• XO \(default, not registered\)/);
  assert.match(description, /• COXN \(default, not registered\)/);
  assert.match(description, /• SCSE \(default, registered\)/);
  assert.match(description, /• OPS 1 \(default, not registered\)/);
  assert.match(description, /• ALPHA \(custom, registered\)/);
  assert.ok(description.indexOf("• CO (default, registered)") < description.indexOf("• XO (default, not registered)"));
  assert.ok(description.indexOf("• XO (default, not registered)") < description.indexOf("• COXN (default, not registered)"));
  assert.ok(description.indexOf("• COXN (default, not registered)") < description.indexOf("• SCSE (default, registered)"));
  assert.ok(description.indexOf("• SCSE (default, registered)") < description.indexOf("• OPS 1 (default, not registered)"));
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

test("attendance selection groups preserve configured categories and collect custom options", () => {
  const groups = __testing.getAttendanceOptionGroups({
    attendanceOptions: ["PRESENT", "DUTY", "LL", "FCL"],
    attendanceGroups: [
      { key: "present", label: "Present", options: ["PRESENT", "DUTY"] },
      { key: "local_leave", label: "Local Leave", options: ["LL"] }
    ]
  });

  assert.deepEqual(groups.map((group) => group.key), ["present", "local_leave", "other"]);
  assert.deepEqual(groups.at(-1).options, ["FCL"]);
});

test("singleton attendance statuses use direct selection callbacks", () => {
  const menu = __testing.buildAttendanceGroupMenu(
    {
      attendanceOptions: ["PRESENT", "DUTY", "FISHING", "OTHER"],
      attendanceGroups: [
        { key: "present", label: "PRESENT", options: ["PRESENT"] },
        { key: "duty", label: "DUTY", options: ["DUTY"] },
        { key: "fishing", label: "FISHING", options: ["FISHING"] },
        { key: "other", label: "Other", options: ["OTHER"] }
      ]
    },
    (key) => `group:${key}`,
    "back",
    [],
    { directOptionCallbackBuilder: (option) => `direct:${option}` }
  );

  assert.deepEqual(
    menu.reply_markup.inline_keyboard[0].map((button) => button.callback_data),
    ["direct:PRESENT", "direct:DUTY", "direct:FISHING"]
  );
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
      { appointment: "C Owl" },
      { appointment: "Owl 1" }
    ],
    sheetSnapshots: {
      synchronizedAt: "2026-03-24T00:00:00.000Z",
      snapshots: new Map([["Mar 26", {
        appointments: ["CO", "SCSE", "C Owl", "Owl 1"],
        statusesByDay: new Map([[24, ["PRESENT", "", "", ""]]])
      }]])
    }
  };
  const config = {
    timezone: "Asia/Singapore",
    hierarchy: [
      { key: "OFFICERS", label: "Officers" },
      { key: "OWL", label: "Owl" }
    ],
    appointmentMetadataByName: new Map([
      ["CO", { hierarchyNodeKey: "OFFICERS" }],
      ["SCSE", { hierarchyNodeKey: "OFFICERS" }],
      ["C OWL", { hierarchyNodeKey: "OWL" }],
      ["OWL 1", { hierarchyNodeKey: "OWL" }]
    ])
  };

  const viewModel = __testing.buildDepartmentWorkweekViewModel(
    cache,
    config,
    { appointment: "CO" },
    { departmentKey: "OWL", isAdminUser: true, weekOffset: 0 }
  );

  assert.equal(viewModel.ok, true);
  assert.equal(viewModel.departmentLabel, "Owl");
  assert.equal(viewModel.canSwitchDepartments, true);
  assert.deepEqual(
    viewModel.allDepartmentOptions.map((entry) => entry.label),
    ["Officers", "Owl"]
  );
  assert.deepEqual(
    viewModel.members.map((member) => member.appointment),
    ["C Owl", "Owl 1"]
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
  const removeTip = "💡 To remove someone from the roster entirely, use ➖ Remove Appointment instead.";

  assert.equal(
    __testing.buildInvitationAdminDescription(1),
    [
      "Send Invitation",
      "",
      "1 person has not yet registered.",
      "Select a name to generate a forwardable invitation.",
      "",
      removeTip
    ].join("\n")
  );

  assert.equal(
    __testing.buildInvitationAdminDescription(3),
    [
      "Send Invitation",
      "",
      "3 people have not yet registered.",
      "Select a name to generate a forwardable invitation.",
      "",
      removeTip
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
  assert.match(ctx.replies[0].message, /3 people have not yet registered\./);
  assert.match(ctx.replies[0].message, /Select a name to generate a forwardable invitation\./);
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
  assert.doesNotMatch(message, /<b>Missing attendance:/);
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

test("unaccounted details separate Telegram users from people not registered", () => {
  const details = __testing.buildUnaccountedDetails(
    new Date("2026-03-28T12:00:00.000Z"),
    { timezone: "Asia/Singapore" },
    ["BOUND", "NO TELEGRAM"],
    {
      appointments: [
        { appointment: "BOUND", boundChatId: "chat-1", boundUsername: "bound" },
        { appointment: "NO TELEGRAM" }
      ]
    }
  );

  assert.match(details.lines.join("\n"), /registered with the attendance bot who have not submitted attendance:/);
  assert.match(details.lines.join("\n"), /not yet registered with the attendance bot:/);
  assert.match(details.lines.join("\n"), /BOUND/);
  assert.match(details.lines.join("\n"), /NO TELEGRAM/);
  assert.equal(details.boundRows[0][0].url, "https://t.me/bound");
});

test("unaccounted details explain when attendance data is unavailable", () => {
  const details = __testing.buildUnaccountedDetails(
    new Date("2026-03-28T12:00:00.000Z"),
    { timezone: "Asia/Singapore" },
    null,
    { appointments: [] }
  );

  assert.match(details.lines.join("\n"), /data .* not available yet/);
  assert.doesNotMatch(details.lines.join("\n"), /Everyone has entered attendance/);
});

test("missing attendance day data is not treated as an all-clear", () => {
  const result = __testing.getUnaccountedAppointments(
    {
      sheetSnapshots: {
        snapshots: new Map([["Mar 26", {
          appointments: ["ALPHA"],
          statusesByDay: new Map()
        }]])
      }
    },
    { timezone: "Asia/Singapore" },
    new Date("2026-03-28T12:00:00.000Z")
  );

  assert.equal(result, null);
});

test("background schedules keep both 1-minute and 5-minute reconciliation intervals", async () => {
  const intervals = [];
  const schedules = [];
  const runCycleCalls = [];
  let cleanupCalls = 0;

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
        },
        setMaintenanceRunning: () => {}
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
      cleanupExpiredAttendanceButtonsFn: async () => {
        cleanupCalls += 1;
        return { attempted: 0, removed: 0, retired: 0, retrying: 0 };
      },
      runDailySheetMaintenanceFn: async () => {},
      runStartupSheetCleanupFn: async () => {}
    }
  });

  assert.deepEqual(
    intervals.map((entry) => entry.delay),
    [60 * 1000, 60 * 1000, 5 * 60 * 1000]
  );
  // First cron is 2 AM structural maintenance; second is 02:05 queue compaction.
  assert.equal(schedules[0].expression, "0 2 * * *");
  assert.equal(schedules[1].expression, "5 2 * * *");
  assert.ok(schedules.some((entry) => entry.expression === "0 7 * * *"));
  assert.ok(schedules.some((entry) => entry.expression === "0 8 * * *"));
  await intervals[1].fn();
  assert.equal(cleanupCalls, 1);
  // Startup cycle runs after cleanup (async) — drain microtasks before asserting.
  await new Promise((resolve) => setImmediate(resolve));
  // Startup cycle is now lightweight (force: false).
  assert.deepEqual(runCycleCalls, [{ force: false, reason: "startup" }]);
});

test("first scheduled reminder refreshes Sheets without delaying prompts", async () => {
  const schedules = [];
  const runCycleCalls = [];
  const prompts = [];
  let releaseReminderSync;
  let reminderRefreshSawBroadcast = false;
  const reminderSync = new Promise((resolve) => {
    releaseReminderSync = resolve;
  });

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

          if (options.reason === "reminder") {
            reminderRefreshSawBroadcast = shouldDeferSnapshotRefresh();
            await reminderSync;
          }
        },
        setMaintenanceRunning: () => {}
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
      runStartupSheetCleanupFn: async () => {},
      isReminderWorkingDayFn: async () => true,
      listUsersFn: async () => [{ chatId: "chat-1", appointment: "ALPHA" }],
      sendPromptToChatFn: async (_bot, _config, chatId) => {
        prompts.push(chatId);
      }
    }
  });

  const reminderSchedule = schedules.find((entry) => entry.expression === "0 7 * * *");
  // Allow the startup cleanup → sync chain to settle before the reminder handler
  // runs.  The cleanup is 3 microtask steps deep; setImmediate fires after all
  // pending microtasks have drained so the startup runCycle has already pushed
  // its entry before the reminder handler starts.
  await new Promise((resolve) => setImmediate(resolve));
  const reminderResult = await Promise.race([
    reminderSchedule.fn().then(() => "sent"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 250))
  ]);

  assert.deepEqual(runCycleCalls, [
    { force: false, reason: "startup" },
    { force: true, reason: "reminder" }
  ]);
  assert.equal(reminderResult, "sent", "first reminder should not wait for Sheets refresh");
  assert.equal(reminderRefreshSawBroadcast, true);
  assert.deepEqual(prompts, ["chat-1"]);
  releaseReminderSync();
  await new Promise((resolve) => setImmediate(resolve));
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
        },
        setMaintenanceRunning: () => {}
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
      runStartupSheetCleanupFn: async () => {},
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
  let releaseReminderSync;
  let reminderRefreshWasEssential = false;
  const reminderSync = new Promise((resolve) => {
    releaseReminderSync = resolve;
  });
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
        runCycle: async (options) => {
          if (options.reason === "reminder") {
            reminderRefreshWasEssential = options.essentialSnapshotRefresh === true;
            await reminderSync;
            return { monthSlicesRefreshed: true };
          }
          return { monthSlicesRefreshed: true };
        },
        setMaintenanceRunning: () => {}
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
      runStartupSheetCleanupFn: async () => {},
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
    await new Promise((resolve) => setImmediate(resolve));
    const reminderResult = reminderSchedule.fn();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(prompts, [], "second reminder must wait for fresh Sheets data");
    releaseReminderSync();
    await reminderResult;
  } finally {
    global.Date = RealDate;
  }

  assert.deepEqual(prompts, ["chat-2"]);
  assert.equal(reminderRefreshWasEssential, true);
});

test("0800 reminder skips recipients when its essential refresh is deferred", async () => {
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
        runCycle: async (options) => options.reason === "reminder"
          ? { monthSlicesRefreshed: false }
          : { monthSlicesRefreshed: true },
        setMaintenanceRunning: () => {}
      },
      sheetSnapshots: {
        snapshots: new Map()
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
      runStartupSheetCleanupFn: async () => {},
      isReminderWorkingDayFn: async () => true,
      listUsersFn: async () => [{ chatId: "chat-1", appointment: "ALPHA" }],
      sendPromptToChatFn: async (_bot, _config, chatId) => prompts.push(chatId)
    }
  });

  const reminderSchedule = schedules.find((entry) => entry.expression === "0 8 * * *");
  await reminderSchedule.fn();

  assert.deepEqual(prompts, []);
});

test("queue status shows empty message when nothing is outstanding", async () => {
  const messages = [];

  await __testing.handleQueueStatusAdminAction(
    {},
    {
      getAttendanceQueueStatus: async () => ({ queueDepth: 0, conflictedCount: 0, nextRetryAt: null }),
      listPendingAttendanceEvents: async () => [],
      sendOrUpdateAdminMessage: async (_ctx, message) => { messages.push(message); },
      buildAdminMenu: () => ({})
    }
  );

  assert.equal(messages.length, 1);
  assert.match(messages[0], /No outstanding attendance/);
});

test("queue status lists pending entries grouped by date newest-first", async () => {
  const messages = [];

  await __testing.handleQueueStatusAdminAction(
    {},
    {
      getAttendanceQueueStatus: async () => ({ queueDepth: 3, conflictedCount: 0, nextRetryAt: null }),
      listPendingAttendanceEvents: async () => [
        { appointment: "ALPHA", status: "PRESENT", date: "2026-05-06" },
        { appointment: "BRAVO", status: "WFH", date: "2026-05-07" },
        { appointment: "CHARLIE", status: "OS", date: "2026-05-06" }
      ],
      sendOrUpdateAdminMessage: async (_ctx, message) => { messages.push(message); },
      buildAdminMenu: () => ({})
    }
  );

  assert.equal(messages.length, 1);
  const msg = messages[0];
  // Should mention count
  assert.match(msg, /3 outstanding/);
  // Newest date (2026-05-07) should appear before older date (2026-05-06)
  assert.ok(msg.indexOf("2026-05-07") < msg.indexOf("2026-05-06"));
  // Each entry should appear
  assert.match(msg, /ALPHA.*PRESENT/s);
  assert.match(msg, /BRAVO.*WFH/s);
  assert.match(msg, /CHARLIE.*OS/s);
});

test("queue status surfaces conflicted entries with sync reminder", async () => {
  const messages = [];

  await __testing.handleQueueStatusAdminAction(
    {},
    {
      getAttendanceQueueStatus: async () => ({ queueDepth: 0, conflictedCount: 2, nextRetryAt: null }),
      listPendingAttendanceEvents: async () => [],
      sendOrUpdateAdminMessage: async (_ctx, message) => { messages.push(message); },
      buildAdminMenu: () => ({})
    }
  );

  assert.equal(messages.length, 1);
  assert.match(messages[0], /2 conflicted/);
  assert.match(messages[0], /Sync Roster/);
});

test("attendance push self-heals a roster conflict and retries once", async () => {
  const messages = [];
  let flushCalls = 0;
  let syncCalls = 0;
  let resetCalls = 0;

  await __testing.handleFlushAttendanceAdminAction({}, { timezone: "Asia/Singapore" }, {
    getAttendanceQueueStatus: async () => ({ queueDepth: 1, conflictedCount: 0, permanentlyFailedCount: 0 }),
    flushAttendanceQueue: async (writeEntries) => {
      flushCalls += 1;
      const outcome = await writeEntries([{
        id: "event-1",
        appointment: "ALPHA",
        date: "2026-03-24",
        status: "PRESENT"
      }]);
      return { flushedEvents: outcome.writtenEventIds ?? [] };
    },
    reconcilePendingAttendanceWithSheets: async () => flushCalls === 1
      ? { writtenEventIds: [], skippedEvents: [], conflictedEvents: [{ eventId: "event-1", reason: "appointment_missing" }] }
      : { writtenEventIds: ["event-1"], skippedEvents: [], conflictedEvents: [] },
    syncRosterState: async () => {
      syncCalls += 1;
      return { currentMonthTitle: "Mar 26", nextMonthTitle: "Apr 26", driftDetected: false };
    },
    refreshAdminCache: async () => {},
    preloadSheetSnapshots: async () => {},
    resetConflictedQueueEntries: async () => {
      resetCalls += 1;
      return { resetCount: 1 };
    },
    sendOrUpdateAdminMessage: async (_ctx, message) => messages.push(message),
    sendCompletionMessage: async (_ctx, message) => messages.push(message),
    sheets: {},
    cache: {}
  });

  assert.equal(flushCalls, 2);
  assert.equal(syncCalls, 1);
  assert.equal(resetCalls, 1);
  assert.match(messages.at(-1), /1 entry written to sheet/);
});
