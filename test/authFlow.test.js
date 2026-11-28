import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";

process.env.GOOGLE_PRIVATE_KEY ??= "test-key";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.GOOGLE_SHEETS_SPREADSHEET_ID ??= "test-sheet";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ??= "bot@example.com";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "attendance-auth-"));
process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;

const { upsertUser, updateUserByChatId, getUserByChatId } = await import("../src/storage.js");
const { getDataFile } = await import("../src/dataDir.js");
const { __testing } = await import("../src/bot.js");

test.after(async () => {
  delete process.env.ATTENDANCE_BOT_DATA_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

async function readUsersFile() {
  const file = getDataFile("users.json");
  return { users: JSON.parse(await readFile(file, "utf8")), mtimeMs: (await stat(file)).mtimeMs };
}

const baseUser = {
  chatId: "100",
  userId: "100",
  username: "jon",
  firstName: "Jon",
  lastName: "",
  fullName: "Jon",
  awaitingAttendance: false,
  awaitingSecretCode: false
};

test("upsertUser skips the rewrite when only updatedAt would change", async () => {
  await upsertUser({ ...baseUser, updatedAt: "2026-01-01T00:00:00.000Z" });
  const before = await readUsersFile();

  const returned = await upsertUser({ ...baseUser, updatedAt: "2026-02-02T00:00:00.000Z" });
  const after = await readUsersFile();

  assert.equal(after.users[0].updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(returned.username, "jon");
});

test("upsertUser still writes a real change", async () => {
  await upsertUser({ ...baseUser, username: "jon_new", updatedAt: "2026-03-03T00:00:00.000Z" });
  const after = await readUsersFile();
  assert.equal(after.users[0].username, "jon_new");
  assert.equal(after.users[0].updatedAt, "2026-03-03T00:00:00.000Z");
});

test("updateUserByChatId skips no-op patches and applies real ones", async () => {
  const before = await readUsersFile();
  await updateUserByChatId("100", { awaitingAttendance: false, awaitingSecretCode: false });
  const unchanged = await readUsersFile();
  assert.equal(unchanged.mtimeMs, before.mtimeMs);

  await updateUserByChatId("100", { awaitingSecretCode: true });
  const changed = await readUsersFile();
  assert.equal(changed.users[0].awaitingSecretCode, true);
  assert.equal((await getUserByChatId("100")).awaitingSecretCode, true);
});

test("updateUserByChatId treats equal arrays as unchanged", async () => {
  await updateUserByChatId("100", { weeklyAttendanceDates: ["2026-03-02"] });
  const before = await readUsersFile();
  await updateUserByChatId("100", { weeklyAttendanceDates: ["2026-03-02"], updatedAt: "later" });
  const after = await readUsersFile();
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("secret-code limiter locks after 5 failures and releases after the window", () => {
  const userId = "limiter-1";
  const start = 1_000_000;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    __testing.recordSecretCodeFailure(userId, start + attempt);
    assert.equal(__testing.getSecretCodeLockout(userId, start + attempt).locked, false);
  }
  __testing.recordSecretCodeFailure(userId, start + 5);
  const locked = __testing.getSecretCodeLockout(userId, start + 6);
  assert.equal(locked.locked, true);
  assert.equal(locked.retryAfterMinutes, 10);

  assert.equal(__testing.getSecretCodeLockout(userId, start + 10 * 60 * 1000 + 1).locked, false);
});

test("a successful bind clears the failure count", () => {
  const userId = "limiter-2";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    __testing.recordSecretCodeFailure(userId, 5_000);
  }
  assert.equal(__testing.getSecretCodeLockout(userId, 5_001).locked, true);
  __testing.clearSecretCodeFailures(userId);
  assert.equal(__testing.getSecretCodeLockout(userId, 5_002).locked, false);
});
