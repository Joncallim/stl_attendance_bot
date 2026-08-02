import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  addAdminAppointment,
  addAppointmentToRegistry,
  bindAppointmentCode,
  computeRosterChecksum,
  deregisterAppointmentBinding,
  getAppointmentBindingIdentity,
  getAppointmentRegistry,
  getAppointmentStateIdentity,
  getOnboardingInvite,
  getUserByChatId,
  listAdminAppointments,
  removeAdminAppointment,
  removeAppointmentFromRegistry,
  syncAppointmentRegistry,
  transferAppointmentBinding,
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

test("destructive registry mutations reject stale binding and state identities", async () => {
  await withTempDataDir(async () => {
    await syncAppointmentRegistry(["ALPHA", "BRAVO"]);
    const invite = await getOnboardingInvite("ALPHA");
    await bindAppointmentCode(invite.secretCode, {
      chatId: "chat-alpha",
      userId: "user-alpha",
      username: "alpha",
      fullName: "Alpha User"
    });

    let registry = await getAppointmentRegistry();
    const alpha = registry.appointments.find((entry) => entry.appointment === "ALPHA");
    const alphaBinding = getAppointmentBindingIdentity(alpha);
    const bravo = registry.appointments.find((entry) => entry.appointment === "BRAVO");
    const bravoState = getAppointmentStateIdentity(bravo);

    const staleDeregister = await deregisterAppointmentBinding("ALPHA", {
      expectedBindingIdentity: `${alphaBinding}:stale`
    });
    assert.equal(staleDeregister.reason, "binding_changed");

    const staleAdmin = await addAdminAppointment("ALPHA", {
      expectedBindingIdentity: `${alphaBinding}:stale`
    });
    assert.equal(staleAdmin.reason, "binding_changed");

    const adminGrant = await addAdminAppointment("ALPHA", {
      expectedBindingIdentity: alphaBinding
    });
    assert.equal(adminGrant.ok, true);
    const staleAdminRemoval = await removeAdminAppointment("ALPHA", [], {
      expectedBindingIdentity: `${alphaBinding}:stale`
    });
    assert.equal(staleAdminRemoval.reason, "binding_changed");
    assert.equal((await listAdminAppointments([])).length, 1);

    const bravoInvite = await getOnboardingInvite("BRAVO");
    await bindAppointmentCode(bravoInvite.secretCode, {
      chatId: "chat-bravo",
      userId: "user-bravo",
      username: "bravo",
      fullName: "Bravo User"
    });
    const staleRemoval = await removeAppointmentFromRegistry("BRAVO", {
      expectedStateIdentity: bravoState
    });
    assert.equal(staleRemoval.reason, "appointment_changed");

    registry = await getAppointmentRegistry();
    assert.equal(registry.appointments.find((entry) => entry.appointment === "ALPHA").boundChatId, "chat-alpha");
    assert.equal(registry.appointments.find((entry) => entry.appointment === "BRAVO").active, true);
  });
});

test("deregistration tombstone prevents a stale user file from restoring a binding", async () => {
  await withTempDataDir(async () => {
    await syncAppointmentRegistry(["ALPHA"]);
    const invite = await getOnboardingInvite("ALPHA");
    await upsertUser({
      chatId: "chat-stale",
      userId: "user-stale",
      username: "stale",
      fullName: "Stale User",
      updatedAt: new Date().toISOString()
    });
    await bindAppointmentCode(invite.secretCode, {
      chatId: "chat-stale",
      userId: "user-stale",
      username: "stale",
      fullName: "Stale User"
    });
    await deregisterAppointmentBinding("ALPHA");

    // Simulate an old users.json snapshot being restored after the deliberate
    // removal. The registry tombstone must win during reconciliation.
    await updateUserByChatId("chat-stale", {
      appointment: "ALPHA",
      onboardingCompletedAt: new Date(Date.now() - 60_000).toISOString()
    });
    await syncAppointmentRegistry(["ALPHA"]);

    const user = await getUserByChatId("chat-stale");
    const registry = await getAppointmentRegistry();
    const alpha = registry.appointments.find((entry) => entry.appointment === "ALPHA");
    assert.equal(user.appointment, null);
    assert.equal(alpha.boundChatId, null);
    assert.ok(alpha.bindingRemovedAt);
  });
});

test("syncAppointmentRegistry repairs a user-side binding from the main registry", async () => {
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

    // Simulate a partial write/data restore: the user-side appointment was lost
    // while the main registry binding survived.
    await updateUserByChatId("chat-orphan", { appointment: null });

    // Sync repairs the missing side. It must not discard the surviving binding.
    await syncAppointmentRegistry(["CHARLIE"]);

    const afterRegistry = await getAppointmentRegistry();
    const afterEntry = afterRegistry.appointments.find((e) => e.appointment === "CHARLIE");
    const afterUser = await getUserByChatId("chat-orphan");
    assert.equal(afterEntry.boundChatId, "chat-orphan", "surviving registry binding preserved");
    assert.equal(afterEntry.secretCode, invite.secretCode, "secret code is not rotated");
    assert.equal(afterUser.appointment, "CHARLIE", "missing user-side appointment repaired");
    assert.equal(afterRegistry.integrity.bindingsConsistent, true);
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

test("syncAppointmentRegistry preserves the union of sheet and main registry records", async () => {
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

    // Rule 1 — anything present in the main registry remains active so
    // syncRosterState can restore it to Google ONBOARDING.
    const alphaEntry = registry.appointments.find((e) => e.appointment === "ALPHA");
    assert.ok(alphaEntry, "ALPHA must be retained (bound, missing from sheet)");
    assert.equal(alphaEntry.active, true, "ALPHA remains active for sheet repair");
    assert.equal(alphaEntry.boundChatId, "chat-alpha", "ALPHA binding preserved");

    // Rule 2 — unbound main-registry records are also preserved. Absence from
    // one side is not treated as deletion permission.
    const bravoEntry = registry.appointments.find((e) => e.appointment === "BRAVO");
    assert.ok(bravoEntry, "BRAVO must be retained for sheet repair");
    assert.equal(bravoEntry.active, true);

    // Rule 3 — appointment in sheet but not in JSON (DELTA): inserted as new entry.
    const deltaEntry = registry.appointments.find((e) => e.appointment === "DELTA");
    assert.ok(deltaEntry, "DELTA must be created (in sheet, new to registry)");
    assert.equal(deltaEntry.active, true);
    assert.ok(deltaEntry.secretCode, "DELTA gets a fresh secret code");
    assert.equal(deltaEntry.boundChatId, null);

    assert.equal(registry.integrity.rosterConsistent, false);
    assert.equal(
      registry.integrity.registryChecksum,
      computeRosterChecksum(["ALPHA", "BRAVO", "CHARLIE", "DELTA"])
    );
  });
});

test("syncAppointmentRegistry restores a missing registry binding from users.json", async () => {
  await withTempDataDir(async () => {
    await syncAppointmentRegistry(["ALPHA"]);
    await upsertUser({
      chatId: "chat-user-only",
      userId: "user-only",
      username: "alpha",
      fullName: "Alpha User",
      appointment: "ALPHA",
      onboardingCompletedAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z"
    });

    const registry = await syncAppointmentRegistry(["ALPHA"]);
    const alpha = registry.appointments.find((entry) => entry.appointment === "ALPHA");

    assert.equal(alpha.boundChatId, "chat-user-only");
    assert.equal(alpha.boundUserId, "user-only");
    assert.equal(registry.integrity.bindingsConsistent, true);
    assert.deepEqual(registry.integrity.repairedRegistryBindings, ["chat-user-only"]);
  });
});

test("checksum clears a user binding only when appointment is absent from sheet and main registry", async () => {
  await withTempDataDir(async () => {
    await syncAppointmentRegistry(["ALPHA"]);
    await upsertUser({
      chatId: "chat-ghost",
      userId: "ghost",
      username: "ghost",
      fullName: "Ghost User",
      appointment: "GHOST",
      onboardingCompletedAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z"
    });

    const registry = await syncAppointmentRegistry(["ALPHA"]);
    const user = await getUserByChatId("chat-ghost");

    assert.equal(user.appointment, null);
    assert.deepEqual(registry.integrity.clearedUserBindings, ["chat-ghost"]);
    assert.equal(registry.integrity.rosterConsistent, true);
  });
});

test("a deliberate bot-removal tombstone prevents stale sheet data from resurrecting a user", async () => {
  await withTempDataDir(async () => {
    await syncAppointmentRegistry(["ALPHA", "BRAVO"]);
    const result = await removeAppointmentFromRegistry("BRAVO");
    assert.equal(result.ok, true);

    // Simulate a partial Sheets deletion: BRAVO is still visible remotely.
    const registry = await syncAppointmentRegistry(["ALPHA", "BRAVO"]);
    const bravo = registry.appointments.find((entry) => entry.appointment === "BRAVO");

    assert.equal(bravo.active, false);
    assert.ok(bravo.removedByBotAt);
    assert.equal(registry.integrity.registryCount, 1);
    assert.equal(registry.integrity.sheetCount, 2);
    assert.equal(registry.integrity.rosterConsistent, false, "stale sheet row remains visible to checksum");
  });
});

test("checksum reports contradictory bindings without guessing or moving the user", async () => {
  await withTempDataDir(async () => {
    await syncAppointmentRegistry(["ALPHA", "BRAVO"]);
    const invite = await getOnboardingInvite("ALPHA");
    await bindAppointmentCode(invite.secretCode, {
      chatId: "chat-conflict",
      userId: "user-conflict",
      username: "conflict",
      fullName: "Conflict User"
    });

    // Simulate contradictory surviving records. Picking either appointment
    // automatically could move future attendance to the wrong row.
    await updateUserByChatId("chat-conflict", { appointment: "BRAVO" });
    const registry = await syncAppointmentRegistry(["ALPHA", "BRAVO"]);
    const alpha = registry.appointments.find((entry) => entry.appointment === "ALPHA");
    const bravo = registry.appointments.find((entry) => entry.appointment === "BRAVO");
    const user = await getUserByChatId("chat-conflict");

    assert.equal(alpha.boundChatId, "chat-conflict");
    assert.equal(bravo.boundChatId, null);
    assert.equal(user.appointment, "BRAVO");
    assert.equal(registry.integrity.bindingsConsistent, false);
    assert.ok(registry.integrity.conflicts.length >= 1);
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

test("transferAppointmentBinding moves binding from one slot to another", async () => {
  await withTempDataDir(async () => {
    // Set up two appointments: ALPHA (will be bound) and BRAVO (unbound target).
    await syncAppointmentRegistry(["ALPHA", "BRAVO"]);
    const alphaInvite = await getOnboardingInvite("ALPHA");

    await upsertUser({
      chatId: "chat-transfer",
      userId: "user-transfer",
      username: "alpha",
      fullName: "Transfer User",
      updatedAt: new Date().toISOString()
    });
    await bindAppointmentCode(alphaInvite.secretCode, {
      chatId: "chat-transfer",
      userId: "user-transfer",
      username: "alpha",
      fullName: "Transfer User"
    });
    await updateUserByChatId("chat-transfer", {
      appointment: "ALPHA",
      onboardingCompletedAt: new Date().toISOString()
    });

    const result = await transferAppointmentBinding("ALPHA", "BRAVO");
    assert.equal(result.ok, true);
    assert.equal(result.fromAppointment, "ALPHA");
    assert.equal(result.toAppointment, "BRAVO");
    assert.equal(result.chatId, "chat-transfer");
    assert.equal(result.username, "alpha");
    assert.equal(result.fullName, "Transfer User");

    const registry = await getAppointmentRegistry();

    // ALPHA should now be unbound with a fresh secret code.
    const alphaEntry = registry.appointments.find((e) => e.appointment === "ALPHA");
    assert.equal(alphaEntry.boundChatId, null, "ALPHA binding cleared");
    assert.ok(alphaEntry.secretCode, "ALPHA has a secret code");
    assert.notEqual(alphaEntry.secretCode, alphaInvite.secretCode, "ALPHA has a fresh secret code");

    // BRAVO should now be bound to the transferred user.
    const bravoEntry = registry.appointments.find((e) => e.appointment === "BRAVO");
    assert.equal(bravoEntry.boundChatId, "chat-transfer", "BRAVO is now bound");
    assert.equal(bravoEntry.boundUsername, "alpha");
    assert.equal(bravoEntry.boundFullName, "Transfer User");

    // User record should reflect the new appointment.
    const user = await getUserByChatId("chat-transfer");
    assert.equal(user.appointment, "BRAVO", "user appointment updated to BRAVO");
  });
});

test("transferAppointmentBinding rejects invalid combinations", async () => {
  await withTempDataDir(async () => {
    await syncAppointmentRegistry(["ALPHA", "BRAVO", "CHARLIE"]);
    const alphaInvite = await getOnboardingInvite("ALPHA");
    const bravoInvite = await getOnboardingInvite("BRAVO");

    // Bind ALPHA and BRAVO to different users.
    await upsertUser({
      chatId: "chat-a",
      userId: "user-a",
      username: "alpha",
      fullName: "Alpha User",
      updatedAt: new Date().toISOString()
    });
    await upsertUser({
      chatId: "chat-b",
      userId: "user-b",
      username: "bravo",
      fullName: "Bravo User",
      updatedAt: new Date().toISOString()
    });
    await bindAppointmentCode(alphaInvite.secretCode, {
      chatId: "chat-a",
      userId: "user-a",
      username: "alpha",
      fullName: "Alpha User"
    });
    await updateUserByChatId("chat-a", {
      appointment: "ALPHA",
      onboardingCompletedAt: new Date().toISOString()
    });
    await bindAppointmentCode(bravoInvite.secretCode, {
      chatId: "chat-b",
      userId: "user-b",
      username: "bravo",
      fullName: "Bravo User"
    });
    await updateUserByChatId("chat-b", {
      appointment: "BRAVO",
      onboardingCompletedAt: new Date().toISOString()
    });

    // Cannot transfer to an already-bound slot, and must reject it before
    // running an external attendance preparation callback.
    let preparationCalled = false;
    const toBound = await transferAppointmentBinding("ALPHA", "BRAVO", {
      prepare: async () => {
        preparationCalled = true;
        return { ok: true };
      }
    });
    assert.equal(toBound.ok, false);
    assert.equal(toBound.reason, "to_already_bound");
    assert.equal(preparationCalled, false);

    // A stale source button cannot transfer a different user's replacement
    // binding from the same appointment slot.
    const sourceChanged = await transferAppointmentBinding("ALPHA", "CHARLIE", {
      expectedFromBindingIdentity: "ALPHA\u0000stale-chat-id",
      prepare: async () => {
        preparationCalled = true;
        return { ok: true };
      }
    });
    assert.equal(sourceChanged.ok, false);
    assert.equal(sourceChanged.reason, "from_binding_changed");
    assert.equal(preparationCalled, false);

    // Cannot transfer from an unbound slot.
    const fromUnbound = await transferAppointmentBinding("CHARLIE", "ALPHA");
    assert.equal(fromUnbound.ok, false);
    assert.equal(fromUnbound.reason, "from_not_bound");

    // Cannot transfer from a non-existent appointment.
    const fromMissing = await transferAppointmentBinding("DELTA", "CHARLIE");
    assert.equal(fromMissing.ok, false);
    assert.equal(fromMissing.reason, "from_not_found");

    // Cannot transfer to a non-existent appointment.
    const toMissing = await transferAppointmentBinding("ALPHA", "ECHO");
    assert.equal(toMissing.ok, false);
    assert.equal(toMissing.reason, "to_not_found");
  });
});

test("transferAppointmentBinding holds the binding lock during preparation", async () => {
  await withTempDataDir(async () => {
    await syncAppointmentRegistry(["ALPHA", "BRAVO"]);
    const alphaInvite = await getOnboardingInvite("ALPHA");
    const bravoInvite = await getOnboardingInvite("BRAVO");

    await upsertUser({
      chatId: "chat-transfer",
      userId: "user-transfer",
      username: "alpha",
      fullName: "Transfer User",
      updatedAt: new Date().toISOString()
    });
    await bindAppointmentCode(alphaInvite.secretCode, {
      chatId: "chat-transfer",
      userId: "user-transfer",
      username: "alpha",
      fullName: "Transfer User"
    });

    let preparationStarted;
    const preparationReady = new Promise((resolve) => {
      preparationStarted = resolve;
    });
    let finishPreparation;
    const preparationGate = new Promise((resolve) => {
      finishPreparation = resolve;
    });

    const transferPromise = transferAppointmentBinding("ALPHA", "BRAVO", {
      prepare: async () => {
        preparationStarted();
        await preparationGate;
        return { ok: true };
      }
    });

    await preparationReady;
    const competingBindPromise = bindAppointmentCode(bravoInvite.secretCode, {
      chatId: "chat-competing",
      userId: "user-competing",
      username: "bravo",
      fullName: "Competing User"
    });
    finishPreparation();

    const [transfer, competingBind] = await Promise.all([
      transferPromise,
      competingBindPromise
    ]);

    assert.equal(transfer.ok, true);
    assert.equal(competingBind.ok, false);
    assert.equal(competingBind.reason, "code_already_claimed");
  });
});
