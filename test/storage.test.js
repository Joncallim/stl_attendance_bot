import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  addAdminAppointment,
  addAppointmentToRegistry,
  bindAppointmentCode,
  deregisterAppointmentBinding,
  getAppointmentRegistry,
  getOnboardingInvite,
  getUserByChatId,
  listAdminAppointments,
  removeAppointmentFromRegistry,
  syncAppointmentRegistry,
  updateUserByChatId,
  upsertUser
} from "../src/storage.js";

async function withTempDataDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "attendance-storage-"));
  process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;

  try {
    await run(tempDir);
  } finally {
    delete process.env.ATTENDANCE_BOT_DATA_DIR;
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("binding is serialized and deregistration clears binding and custom admin access", async () => {
  await withTempDataDir(async () => {
    await syncAppointmentRegistry(["ALPHA"]);
    const invite = await getOnboardingInvite("ALPHA");

    await upsertUser({
      chatId: "chat-1",
      userId: "user-1",
      username: "alpha",
      fullName: "Alpha User",
      updatedAt: new Date().toISOString()
    });

    const [first, second] = await Promise.all([
      bindAppointmentCode(invite.secretCode, {
        chatId: "chat-1",
        userId: "user-1",
        username: "alpha",
        fullName: "Alpha User"
      }),
      bindAppointmentCode(invite.secretCode, {
        chatId: "chat-2",
        userId: "user-2",
        username: "other",
        fullName: "Other User"
      })
    ]);

    const successfulBinding = first.ok ? first : second;
    const rejectedBinding = first.ok ? second : first;

    assert.equal(successfulBinding.ok, true);
    assert.equal(rejectedBinding.reason, "code_already_claimed");

    await updateUserByChatId("chat-1", {
      appointment: "ALPHA",
      onboardingCompletedAt: new Date().toISOString()
    });

    const adminGrant = await addAdminAppointment("ALPHA");
    assert.equal(adminGrant.ok, true);

    const deregistration = await deregisterAppointmentBinding("ALPHA");
    assert.equal(deregistration.ok, true);
    assert.notEqual(deregistration.secretCode, invite.secretCode);

    const registry = await getAppointmentRegistry();
    const alphaEntry = registry.appointments.find((entry) => entry.appointment === "ALPHA");
    assert.equal(alphaEntry.boundChatId, null);

    const user = await getUserByChatId("chat-1");
    assert.equal(user.appointment, null);

    const admins = await listAdminAppointments([]);
    assert.deepEqual(admins, []);
  });
});

test("appointments can be added to and removed from the active registry", async () => {
  await withTempDataDir(async () => {
    const addResult = await addAppointmentToRegistry("BRAVO");
    assert.equal(addResult.ok, true);
    assert.equal(addResult.appointment, "BRAVO");
    assert.ok(addResult.secretCode);

    const duplicateAdd = await addAppointmentToRegistry("BRAVO");
    assert.equal(duplicateAdd.ok, false);
    assert.equal(duplicateAdd.reason, "appointment_exists");

    const removeResult = await removeAppointmentFromRegistry("BRAVO");
    assert.equal(removeResult.ok, true);

    const registry = await getAppointmentRegistry();
    const bravoEntry = registry.appointments.find((entry) => entry.appointment === "BRAVO");
    assert.equal(bravoEntry.active, false);
    assert.equal(bravoEntry.boundChatId, null);
  });
});
