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

test("syncAppointmentRegistry clears orphaned bindings when user record is missing", async () => {
  await withTempDataDir(async () => {
    // Set up an appointment and bind it to a user.
    await syncAppointmentRegistry(["CHARLIE"]);
    const invite = await getOnboardingInvite("CHARLIE");

    await upsertUser({
      chatId: "chat-orphan",
      userId: "user-orphan",
      username: "charlie",
      fullName: "Charlie User",
      updatedAt: new Date().toISOString()
    });
    await bindAppointmentCode(invite.secretCode, {
      chatId: "chat-orphan",
      userId: "user-orphan",
      username: "charlie",
      fullName: "Charlie User"
    });
    await updateUserByChatId("chat-orphan", {
      appointment: "CHARLIE",
      onboardingCompletedAt: new Date().toISOString()
    });

    // Verify bound.
    const beforeRegistry = await getAppointmentRegistry();
    const beforeEntry = beforeRegistry.appointments.find((e) => e.appointment === "CHARLIE");
    assert.equal(beforeEntry.boundChatId, "chat-orphan");

    // Simulate user record being lost: clear the appointment field on the user
    // so the registry binding becomes "orphaned" (no matching user → appointment).
    await updateUserByChatId("chat-orphan", { appointment: null });

    // Sync should detect the orphaned binding, clear it, and issue a fresh code.
    await syncAppointmentRegistry(["CHARLIE"]);

    const afterRegistry = await getAppointmentRegistry();
    const afterEntry = afterRegistry.appointments.find((e) => e.appointment === "CHARLIE");
    assert.equal(afterEntry.boundChatId, null, "orphaned boundChatId cleared");
    assert.ok(afterEntry.secretCode, "new secret code generated");
    assert.notEqual(afterEntry.secretCode, invite.secretCode, "fresh code different from original");
  });
});

test("syncAppointmentRegistry preserves valid bindings where user record matches", async () => {
  await withTempDataDir(async () => {
    await syncAppointmentRegistry(["DELTA"]);
    const invite = await getOnboardingInvite("DELTA");

    await upsertUser({
      chatId: "chat-valid",
      userId: "user-valid",
      username: "delta",
      fullName: "Delta User",
      updatedAt: new Date().toISOString()
    });
    await bindAppointmentCode(invite.secretCode, {
      chatId: "chat-valid",
      userId: "user-valid",
      username: "delta",
      fullName: "Delta User"
    });
    await updateUserByChatId("chat-valid", {
      appointment: "DELTA",
      onboardingCompletedAt: new Date().toISOString()
    });

    // Sync again — binding is valid, should be left untouched.
    await syncAppointmentRegistry(["DELTA"]);

    const registry = await getAppointmentRegistry();
    const entry = registry.appointments.find((e) => e.appointment === "DELTA");
    assert.equal(entry.boundChatId, "chat-valid", "valid binding preserved");
    assert.equal(entry.secretCode, invite.secretCode, "secret code unchanged");
  });
});

test("syncAppointmentRegistry registry-sheet reconciliation rules", async () => {
  await withTempDataDir(async () => {
    // Seed: three appointments known to the registry.
    await syncAppointmentRegistry(["ALPHA", "BRAVO", "CHARLIE"]);

    // Bind ALPHA to a user (simulates a completed onboarding).
    await upsertUser({
      chatId: "chat-alpha",
      userId: "user-alpha",
      username: "alpha",
      fullName: "Alpha User",
      updatedAt: new Date().toISOString()
    });
    const alphaInvite = await getOnboardingInvite("ALPHA");
    await bindAppointmentCode(alphaInvite.secretCode, {
      chatId: "chat-alpha",
      userId: "user-alpha",
      username: "alpha",
      fullName: "Alpha User"
    });
    await updateUserByChatId("chat-alpha", {
      appointment: "ALPHA",
      onboardingCompletedAt: new Date().toISOString()
    });

    // Now sync against a sheet that:
    //   - is missing ALPHA (bound) and BRAVO (unbound)
    //   - has a new appointment DELTA that is not yet in the registry
    await syncAppointmentRegistry(["CHARLIE", "DELTA"]);

    const registry = await getAppointmentRegistry();

    // Rule 1 — bound appointment (ALPHA) not in sheet: kept in JSON (active:false)
    //           so syncRosterState can restore it to the sheet.
    const alphaEntry = registry.appointments.find((e) => e.appointment === "ALPHA");
    assert.ok(alphaEntry, "ALPHA must be retained (bound, missing from sheet)");
    assert.equal(alphaEntry.active, false, "ALPHA marked inactive");
    assert.equal(alphaEntry.boundChatId, "chat-alpha", "ALPHA binding preserved");

    // Rule 2 — unbound appointment (BRAVO) not in sheet: pruned from JSON entirely.
    const bravoEntry = registry.appointments.find((e) => e.appointment === "BRAVO");
    assert.equal(bravoEntry, undefined, "BRAVO must be pruned (unbound, missing from sheet)");

    // Rule 3 — appointment in sheet but not in JSON (DELTA): inserted as new entry.
    const deltaEntry = registry.appointments.find((e) => e.appointment === "DELTA");
    assert.ok(deltaEntry, "DELTA must be created (in sheet, new to registry)");
    assert.equal(deltaEntry.active, true);
    assert.ok(deltaEntry.secretCode, "DELTA gets a fresh secret code");
    assert.equal(deltaEntry.boundChatId, null);
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
