import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import {
  ATTENDANCE_BUTTON_TTL_MS,
  cancelAttendanceButtonCleanup,
  cleanupExpiredAttendanceButtons,
  listPendingAttendanceButtonCleanups,
  scheduleAttendanceButtonCleanup
} from "../src/messageCleanup.js";

async function withTempDataDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "attendance-cleanup-"));
  process.env.ATTENDANCE_BOT_DATA_DIR = directory;

  try {
    await run(directory);
  } finally {
    delete process.env.ATTENDANCE_BOT_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  }
}

test("attendance button cleanup is persisted for exactly one hour", async () => {
  await withTempDataDir(async (directory) => {
    const completedAt = new Date("2026-07-30T08:00:00.000Z");
    const job = await scheduleAttendanceButtonCleanup(
      "chat-1",
      123,
      completedAt
    );
    const jobs = await listPendingAttendanceButtonCleanups();

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].scheduleId, job.scheduleId);
    assert.equal(
      Date.parse(jobs[0].removeAfter) - completedAt.getTime(),
      ATTENDANCE_BUTTON_TTL_MS
    );
    assert.equal(
      (await stat(path.join(directory, "attendance-button-cleanup.json"))).mode & 0o777,
      0o600
    );
  });
});

test("cleanup keeps buttons before expiry and removes them after expiry", async () => {
  await withTempDataDir(async () => {
    const completedAt = new Date("2026-07-30T08:00:00.000Z");
    const edits = [];
    const telegram = {
      async editMessageReplyMarkup(chatId, messageId, inlineMessageId, markup) {
        edits.push({ chatId, messageId, inlineMessageId, markup });
      }
    };
    await scheduleAttendanceButtonCleanup("chat-1", 123, completedAt);

    assert.deepEqual(
      await cleanupExpiredAttendanceButtons(telegram, {
        now: new Date(completedAt.getTime() + ATTENDANCE_BUTTON_TTL_MS - 1)
      }),
      { attempted: 0, removed: 0, retired: 0, retrying: 0 }
    );
    assert.equal(edits.length, 0);

    assert.deepEqual(
      await cleanupExpiredAttendanceButtons(telegram, {
        now: new Date(completedAt.getTime() + ATTENDANCE_BUTTON_TTL_MS)
      }),
      { attempted: 1, removed: 1, retired: 0, retrying: 0 }
    );
    assert.deepEqual(edits, [{
      chatId: "chat-1",
      messageId: 123,
      inlineMessageId: undefined,
      markup: { inline_keyboard: [] }
    }]);
    assert.deepEqual(await listPendingAttendanceButtonCleanups(), []);
  });
});

test("using a confirmation button cancels its delayed cleanup", async () => {
  await withTempDataDir(async () => {
    await scheduleAttendanceButtonCleanup(
      "chat-1",
      123,
      new Date("2026-07-30T08:00:00.000Z")
    );

    assert.equal(await cancelAttendanceButtonCleanup("chat-1", 123), true);
    assert.equal(await cancelAttendanceButtonCleanup("chat-1", 123), false);
    assert.deepEqual(await listPendingAttendanceButtonCleanups(), []);
  });
});

test("transient Telegram failures are retained with retry backoff", async () => {
  await withTempDataDir(async () => {
    const completedAt = new Date("2026-07-30T08:00:00.000Z");
    let attempts = 0;
    await scheduleAttendanceButtonCleanup("chat-1", 123, completedAt);

    const result = await cleanupExpiredAttendanceButtons({
      async editMessageReplyMarkup() {
        attempts += 1;
        const error = new Error("Telegram unavailable");
        error.code = 500;
        throw error;
      }
    }, {
      now: new Date(completedAt.getTime() + ATTENDANCE_BUTTON_TTL_MS)
    });

    assert.deepEqual(result, {
      attempted: 1,
      removed: 0,
      retired: 0,
      retrying: 1
    });
    assert.equal(attempts, 3);
    const [job] = await listPendingAttendanceButtonCleanups();
    assert.equal(job.retryCount, 1);
    assert.equal(
      Date.parse(job.nextAttemptAt),
      completedAt.getTime() + ATTENDANCE_BUTTON_TTL_MS + 60 * 1000
    );
  });
});

test("permanent Telegram failures retire cleanup jobs", async () => {
  await withTempDataDir(async () => {
    const completedAt = new Date("2026-07-30T08:00:00.000Z");
    await scheduleAttendanceButtonCleanup("chat-1", 123, completedAt);

    const result = await cleanupExpiredAttendanceButtons({
      async editMessageReplyMarkup() {
        const error = new Error("Forbidden: bot was blocked by the user");
        error.code = 403;
        throw error;
      }
    }, {
      now: new Date(completedAt.getTime() + ATTENDANCE_BUTTON_TTL_MS)
    });

    assert.deepEqual(result, {
      attempted: 1,
      removed: 0,
      retired: 1,
      retrying: 0
    });
    assert.deepEqual(await listPendingAttendanceButtonCleanups(), []);
  });
});

test("cancellation waits for an in-flight cleanup before a new keyboard is installed", async () => {
  await withTempDataDir(async () => {
    const firstCompletedAt = new Date("2026-07-30T08:00:00.000Z");
    const cleanupAt = new Date(
      firstCompletedAt.getTime() + ATTENDANCE_BUTTON_TTL_MS
    );
    let releaseEdit;
    let notifyEditStarted;
    const editStarted = new Promise((resolve) => {
      notifyEditStarted = resolve;
    });
    const editReleased = new Promise((resolve) => {
      releaseEdit = resolve;
    });
    let finalMarkup = { inline_keyboard: [[{ text: "old" }]] };

    await scheduleAttendanceButtonCleanup("chat-1", 123, firstCompletedAt);
    const cleanupPromise = cleanupExpiredAttendanceButtons({
      async editMessageReplyMarkup() {
        notifyEditStarted();
        await editReleased;
        finalMarkup = { inline_keyboard: [] };
      }
    }, { now: cleanupAt });

    await editStarted;
    const cancelPromise = cancelAttendanceButtonCleanup("chat-1", 123);
    releaseEdit();
    assert.equal(await cancelPromise, true, "cancellation runs after the old edit completes");
    finalMarkup = { inline_keyboard: [[{ text: "fresh" }]] };
    const newerJob = await scheduleAttendanceButtonCleanup("chat-1", 123, cleanupAt);

    assert.deepEqual(await cleanupPromise, {
      attempted: 1,
      removed: 0,
      retired: 0,
      retrying: 0
    });
    const [pendingJob] = await listPendingAttendanceButtonCleanups();
    assert.equal(pendingJob.scheduleId, newerJob.scheduleId);
    assert.equal(
      Date.parse(pendingJob.removeAfter),
      cleanupAt.getTime() + ATTENDANCE_BUTTON_TTL_MS
    );
    assert.deepEqual(finalMarkup, { inline_keyboard: [[{ text: "fresh" }]] });
  });
});
