import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  batchUpdateUsersByChatId,
  getUserByChatId,
  listUsers,
  syncAppointmentRegistry,
  updateUserByChatId,
  upsertUser
} from "../src/storage.js";

async function withTempDataDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "storage-batch-"));
  process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;
  try {
    await run(tempDir);
  } finally {
    delete process.env.ATTENDANCE_BOT_DATA_DIR;
    await rm(tempDir, { recursive: true, force: true });
  }
}

function makeUser(chatId, n = 0) {
  return {
    chatId,
    userId: `user-${chatId}`,
    username: `user${n}`,
    fullName: `User ${n}`,
    appointment: null,
    awaitingAttendance: false,
    awaitingSecretCode: false,
    awaitingWeeklyAttendance: false,
    weeklyAttendanceDates: [],
    weeklyAttendanceIndex: 0,
    weeklyAttendanceEntries: [],
    weeklyAttendanceResults: [],
    updatedAt: new Date().toISOString()
  };
}

// ── batchUpdateUsersByChatId ──────────────────────────────────────────────────

test("batchUpdateUsersByChatId updates all matched users in a single write", async () => {
  await withTempDataDir(async () => {
    const count = 50;
    for (let i = 0; i < count; i++) {
      await upsertUser(makeUser(String(i), i));
    }

    const patches = Array.from({ length: count }, (_, i) => ({
      chatId: String(i),
      patch: { awaitingAttendance: true, promptedAt: "2026-03-10T07:00:00.000Z" }
    }));

    const results = await batchUpdateUsersByChatId(patches);
    assert.equal(results.length, count, "should return one result per patch");
    assert.ok(results.every((r) => r !== null), "all users should be found and updated");
    assert.ok(results.every((r) => r.awaitingAttendance === true), "all users should have awaitingAttendance=true");

    // Verify persistence
    const users = await listUsers();
    assert.ok(users.every((u) => u.awaitingAttendance === true));
  });
});

test("batchUpdateUsersByChatId returns null for chatIds not in the store", async () => {
  await withTempDataDir(async () => {
    await upsertUser(makeUser("known-id", 1));

    const results = await batchUpdateUsersByChatId([
      { chatId: "known-id", patch: { awaitingAttendance: true } },
      { chatId: "ghost-id", patch: { awaitingAttendance: true } }
    ]);

    assert.equal(results.length, 2);
    assert.notEqual(results[0], null, "known user should be found");
    assert.equal(results[1], null, "unknown chatId should return null");
  });
});

test("batchUpdateUsersByChatId returns empty array for empty patch list", async () => {
  await withTempDataDir(async () => {
    const results = await batchUpdateUsersByChatId([]);
    assert.deepEqual(results, []);
  });
});

test("batchUpdateUsersByChatId null/undefined input returns empty array", async () => {
  await withTempDataDir(async () => {
    assert.deepEqual(await batchUpdateUsersByChatId(null), []);
    assert.deepEqual(await batchUpdateUsersByChatId(undefined), []);
  });
});

// ── Cache integrity after batch write ────────────────────────────────────────

test("getUserByChatId reflects batch updates without a disk re-read", async () => {
  await withTempDataDir(async () => {
    await upsertUser(makeUser("chat-A", 1));
    await upsertUser(makeUser("chat-B", 2));

    await batchUpdateUsersByChatId([
      { chatId: "chat-A", patch: { awaitingAttendance: true } },
      { chatId: "chat-B", patch: { awaitingAttendance: false } }
    ]);

    const userA = await getUserByChatId("chat-A");
    const userB = await getUserByChatId("chat-B");

    assert.equal(userA?.awaitingAttendance, true, "cache should reflect patch for chat-A");
    assert.equal(userB?.awaitingAttendance, false, "cache should reflect patch for chat-B");
  });
});

// ── Concurrent batch writes are serialized ───────────────────────────────────

test("concurrent batchUpdateUsersByChatId calls do not lose updates", async () => {
  await withTempDataDir(async () => {
    const count = 20;
    for (let i = 0; i < count; i++) {
      await upsertUser(makeUser(String(i), i));
    }

    const promptedAt1 = "2026-03-10T07:00:00.000Z";
    const promptedAt2 = "2026-03-10T08:00:00.000Z";

    // Fire two concurrent batch updates touching different users
    const evens = Array.from({ length: count / 2 }, (_, i) => ({
      chatId: String(i * 2),
      patch: { awaitingAttendance: true, promptedAt: promptedAt1 }
    }));
    const odds = Array.from({ length: count / 2 }, (_, i) => ({
      chatId: String(i * 2 + 1),
      patch: { awaitingAttendance: false, promptedAt: promptedAt2 }
    }));

    await Promise.all([
      batchUpdateUsersByChatId(evens),
      batchUpdateUsersByChatId(odds)
    ]);

    const users = await listUsers();

    for (const user of users) {
      const id = Number(user.chatId);
      if (id % 2 === 0) {
        assert.equal(user.awaitingAttendance, true, `even user ${id} should be marked awaiting`);
        assert.equal(user.promptedAt, promptedAt1);
      } else {
        assert.equal(user.awaitingAttendance, false, `odd user ${id} should not be awaiting`);
        assert.equal(user.promptedAt, promptedAt2);
      }
    }
  });
});

// ── Large batch (100 users) ───────────────────────────────────────────────────

test("batchUpdateUsersByChatId handles 100-user batches correctly", async () => {
  await withTempDataDir(async () => {
    const count = 100;
    for (let i = 0; i < count; i++) {
      await upsertUser(makeUser(String(i), i));
    }

    const patches = Array.from({ length: count }, (_, i) => ({
      chatId: String(i),
      patch: { awaitingAttendance: i < 50, promptedAt: "2026-06-04T07:00:00.000Z" }
    }));

    const results = await batchUpdateUsersByChatId(patches);

    assert.equal(results.filter((r) => r !== null).length, count);
    assert.equal(results.filter((r) => r?.awaitingAttendance === true).length, 50);
    assert.equal(results.filter((r) => r?.awaitingAttendance === false).length, 50);

    // Spot-check via getUserByChatId
    const user50 = await getUserByChatId("50");
    assert.equal(user50?.awaitingAttendance, false);
    const user49 = await getUserByChatId("49");
    assert.equal(user49?.awaitingAttendance, true);
  });
});

test("concurrent single-user patches are coalesced without losing updates", async () => {
  await withTempDataDir(async () => {
    const count = 50;

    for (let i = 0; i < count; i++) {
      await upsertUser(makeUser(String(i), i));
    }

    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        updateUserByChatId(String(i), {
          awaitingAttendance: false,
          lastSubmittedAt: `submission-${i}`
        })
      )
    );

    assert.equal(results.length, count);
    assert.ok(results.every(Boolean));

    const users = await listUsers();
    assert.deepEqual(
      users.map((user) => user.lastSubmittedAt),
      Array.from({ length: count }, (_, i) => `submission-${i}`)
    );
  });
});
