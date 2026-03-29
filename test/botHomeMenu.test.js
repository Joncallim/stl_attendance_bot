import test from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_PRIVATE_KEY ??= "test-key";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.GOOGLE_SHEETS_SPREADSHEET_ID ??= "test-sheet";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ??= "bot@example.com";

const { __testing } = await import("../src/bot.js");

test("admin home menu includes admin action and synchronization footer", () => {
  const text = __testing.buildHomeMenuText({
    greeting: "Good Evening",
    name: "SCSE",
    isAdminUser: true,
    timezone: "Asia/Singapore",
    syncStatus: {
      lastQueueFlushAt: Date.UTC(2026, 2, 24, 10, 45, 12),
      lastOnboardingRefreshAt: Date.UTC(2026, 2, 24, 10, 44, 0),
      lastMonthRefreshAt: Date.UTC(2026, 2, 24, 10, 43, 0),
      lastFiveMinuteReconcileAt: Date.UTC(2026, 2, 24, 10, 42, 0)
    }
  });

  assert.match(text, /🛠️ Admin Menu:/);
  assert.match(text, /🏢 My Department:/);
  assert.match(text, /\n---\n/);
  assert.match(text, /Last Synchronisation: 184200 24 Mar 26/);
});

test("admin home menu uses five-minute reconciliation timestamp only", () => {
  const latest = __testing.getLatestHomeSynchronizationTimestamp({
    lastQueueFlushAt: 100,
    lastOnboardingRefreshAt: 300,
    lastMonthRefreshAt: 200,
    lastFiveMinuteReconcileAt: 250
  });

  assert.equal(latest, 250);
});

test("admin home menu shows not completed yet when no sync exists", () => {
  const text = __testing.buildHomeMenuText({
    greeting: "Good Evening",
    name: "SCSE",
    isAdminUser: true,
    timezone: "Asia/Singapore",
    syncStatus: {
      lastQueueFlushAt: 0,
      lastOnboardingRefreshAt: 0,
      lastMonthRefreshAt: 0,
      lastFiveMinuteReconcileAt: 0
    }
  });

  assert.match(text, /Last Synchronisation: Not completed yet/);
});

test("non-admin home menu has no admin section or footer", () => {
  const text = __testing.buildHomeMenuText({
    greeting: "Good Evening",
    name: "SCSE",
    isAdminUser: false,
    timezone: "Asia/Singapore",
    syncStatus: {
      lastQueueFlushAt: Date.UTC(2026, 2, 24, 10, 45, 12)
    }
  });

  assert.doesNotMatch(text, /🛠️ Admin Menu:/);
  assert.doesNotMatch(text, /---/);
  assert.doesNotMatch(text, /Last Synchronisation:/);
  assert.match(text, /🏢 My Department:/);
  assert.match(text, /❌ Close: Close this menu\.$/);
});

test("home inline menu includes My Department button for non-admins", () => {
  const menu = __testing.buildHomeMenu(false, "Asia/Singapore");
  const labels = menu.reply_markup.inline_keyboard.flat().map((button) => button.text);
  const callbacks = menu.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  const rowLengths = menu.reply_markup.inline_keyboard.map((row) => row.length);

  assert.ok(labels.includes("🏢 My Department"));
  assert.ok(callbacks.includes("home:department"));
  assert.ok(rowLengths.every((length) => length <= 2));
});

test("home inline menu includes My Department and Admin Menu for admins", () => {
  const menu = __testing.buildHomeMenu(true, "Asia/Singapore");
  const labels = menu.reply_markup.inline_keyboard.flat().map((button) => button.text);
  const callbacks = menu.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  const rowLengths = menu.reply_markup.inline_keyboard.map((row) => row.length);

  assert.ok(labels.includes("🏢 My Department"));
  assert.ok(callbacks.includes("home:department"));
  assert.ok(labels.includes("🛠️ Admin Menu"));
  assert.ok(rowLengths.every((length) => length <= 2));
});
