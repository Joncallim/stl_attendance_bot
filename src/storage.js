import { randomBytes } from "node:crypto";
import { getDataFile } from "./dataDir.js";
import { readJsonFile, runSerialized, writeJsonFile } from "./fileStore.js";

const STORAGE_MUTEX_KEY = "storage";
const ATTENDANCE_OPTION_SCHEMA_VERSION = 2;

function getUsersFile() {
  return getDataFile("users.json");
}

function getAppointmentRegistryFile() {
  return getDataFile("appointment-registry.json");
}

function getSettingsFile() {
  return getDataFile("settings.json");
}

function normalizeCode(code) {
  return String(code ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeAppointmentName(value) {
  return String(value ?? "").trim().toUpperCase();
}

function generateSecretCode(existingCodes) {
  let code = "";

  do {
    code = randomBytes(4).toString("hex").toUpperCase();
  } while (existingCodes.has(code));

  return code;
}

function logStorageSuccess(message, details = null) {
  if (details) {
    console.log(`${message} ${JSON.stringify(details)}`);
    return;
  }

  console.log(message);
}

function clearUserBindingFields(user) {
  return {
    ...user,
    appointment: null,
    onboardingSecretCode: null,
    onboardingCompletedAt: null,
    awaitingSecretCode: false,
    awaitingAttendance: false,
    updatedAt: new Date().toISOString()
  };
}

let usersCache = null;
let usersCacheAt = 0;
const USERS_CACHE_TTL_MS = 30_000;

async function readUsers() {
  if (usersCache !== null && Date.now() - usersCacheAt < USERS_CACHE_TTL_MS) {
    return usersCache;
  }
  const users = await readJsonFile(getUsersFile(), []);
  usersCache = users;
  usersCacheAt = Date.now();
  return users;
}

async function writeUsers(users) {
  await writeJsonFile(getUsersFile(), users);
  usersCache = users;
  usersCacheAt = Date.now();
}

async function readAppointmentRegistry() {
  return readJsonFile(getAppointmentRegistryFile(), {
    updatedAt: null,
    appointments: [],
    adminAppointments: []
  });
}

async function writeAppointmentRegistry(registry) {
  await writeJsonFile(getAppointmentRegistryFile(), registry);
}

async function readSettings() {
  return readJsonFile(getSettingsFile(), {
    updatedAt: null,
    attendanceOptions: null,
    attendanceOptionsVersion: null,
    attendanceOptionUsage: null,
    attendanceOptionUsageUpdatedAt: null
  });
}

async function writeSettings(settings) {
  await writeJsonFile(getSettingsFile(), settings);
}

function normalizeAttendanceOption(value) {
  return String(value ?? "").trim();
}

function findAppointmentEntry(registry, appointment) {
  const normalized = normalizeAppointmentName(appointment);
  return registry.appointments.find(
    (entry) => normalizeAppointmentName(entry.appointment) === normalized
  );
}

function normalizeAppointmentInput(value) {
  return String(value ?? "").trim();
}

function pruneUnboundAdminAppointments(registry) {
  const boundActiveAppointments = new Set(
    registry.appointments
      .filter((entry) => entry.active && entry.boundChatId)
      .map((entry) => normalizeAppointmentName(entry.appointment))
  );

  return (registry.adminAppointments ?? []).filter((appointment) =>
    boundActiveAppointments.has(normalizeAppointmentName(appointment))
  );
}

function withStorageMutation(operation) {
  return runSerialized(STORAGE_MUTEX_KEY, operation);
}

export async function upsertUser(user) {
  return withStorageMutation(async () => {
    const users = await readUsers();
    const index = users.findIndex((entry) => entry.chatId === user.chatId);

    if (index >= 0) {
      users[index] = { ...users[index], ...user };
    } else {
      users.push(user);
    }

    await writeUsers(users);
    return index >= 0 ? users[index] : user;
  });
}

export async function listUsers() {
  return readUsers();
}

export async function getUserByChatId(chatId) {
  const users = await readUsers();
  return users.find((entry) => entry.chatId === String(chatId)) ?? null;
}

export async function updateUserByChatId(chatId, patch) {
  return withStorageMutation(async () => {
    const users = await readUsers();
    const index = users.findIndex((entry) => entry.chatId === String(chatId));

    if (index === -1) {
      return null;
    }

    users[index] = { ...users[index], ...patch };
    await writeUsers(users);
    return users[index];
  });
}

// Applies multiple patches in a single read-modify-write cycle. Use this
// instead of calling updateUserByChatId in a loop when many users need updating
// at once (e.g. after a batch reminder send).
export async function batchUpdateUsersByChatId(patches) {
  if (!patches || patches.length === 0) return [];
  return withStorageMutation(async () => {
    const users = await readUsers();
    const results = [];
    for (const { chatId, patch } of patches) {
      const index = users.findIndex((entry) => entry.chatId === String(chatId));
      if (index === -1) {
        results.push(null);
        continue;
      }
      users[index] = { ...users[index], ...patch };
      results.push(users[index]);
    }
    await writeUsers(users);
    return results;
  });
}

export async function syncAppointmentRegistry(appointments) {
  return withStorageMutation(async () => {
    const registry = await readAppointmentRegistry();
    const users = await readUsers();

    // Build a lookup of chatIds that are confirmed active in the users list
    // AND whose appointment field matches some registry entry.  Used below to
    // detect "orphaned" registry bindings where the user record has been
    // removed or their appointment field was cleared.
    const activeUserByChatId = new Map(
      users
        .filter((u) => u.chatId && u.appointment)
        .map((u) => [String(u.chatId), normalizeAppointmentName(u.appointment)])
    );

    const uniqueAppointments = [...new Set(
      appointments.map((value) => value.trim()).filter(Boolean)
    )];
    const currentSet = new Set(uniqueAppointments);
    const currentNormalizedSet = new Set(uniqueAppointments.map(normalizeAppointmentName));
    const existingCodes = new Set(
      registry.appointments.map((entry) => normalizeCode(entry.secretCode))
    );

    const nextAppointments = uniqueAppointments.map((appointment) => {
      const existing = registry.appointments.find((entry) => entry.appointment === appointment);

      if (existing) {
        // Detect orphaned binding: registry claims a user is bound but the
        // users list has no matching active record for this appointment.
        // This can happen after a partial data loss, manual file edit, or
        // redeployment that reset the users store while the registry survived.
        // → Clear the stale binding and issue a fresh code so the slot is
        //   available again and the sheet no longer shows "IN-USE".
        if (existing.boundChatId) {
          const boundChatIdStr = String(existing.boundChatId);
          const userAppointment = activeUserByChatId.get(boundChatIdStr);
          const isOrphaned =
            !userAppointment ||
            userAppointment !== normalizeAppointmentName(existing.appointment);

          if (isOrphaned) {
            const secretCode = generateSecretCode(existingCodes);
            existingCodes.add(secretCode);
            logStorageSuccess(
              `# Cleared orphaned binding and regenerated code. {"appointment":"${appointment}","staleBoundChatId":"${existing.boundChatId}"}`
            );
            return {
              ...existing,
              appointment,
              secretCode,
              boundChatId: null,
              boundUserId: null,
              boundUsername: null,
              boundFullName: null,
              boundAt: null,
              active: true
            };
          }
        }

        // If the entry has a blank secret code (and is not bound to a user),
        // generate a fresh code so the ONBOARDING sheet cell is never empty.
        if (!existing.secretCode && !existing.boundChatId) {
          const secretCode = generateSecretCode(existingCodes);
          existingCodes.add(secretCode);
          logStorageSuccess(`# Generated secret code for existing appointment with blank code. {"appointment":"${appointment}"}`);
          return { ...existing, appointment, secretCode, active: true };
        }
        return {
          ...existing,
          appointment,
          active: true
        };
      }

      const secretCode = generateSecretCode(existingCodes);
      existingCodes.add(secretCode);

      return {
        appointment,
        secretCode,
        active: true,
        boundChatId: null,
        boundUserId: null,
        boundUsername: null,
        boundFullName: null,
        boundAt: null
      };
    });

    // Rule 1: bound entries not in the sheet are kept (active:false) so
    // syncRosterState can restore them to the sheet on the next sync.
    // Rule 2: unbound entries not in the sheet are pruned from the JSON entirely —
    // they are stale slots that serve no purpose and only create noise.
    const droppedUnbound = registry.appointments.filter(
      (entry) => !currentSet.has(entry.appointment) && !entry.boundChatId
    );
    if (droppedUnbound.length > 0) {
      logStorageSuccess(
        `# Pruned ${droppedUnbound.length} unbound appointment(s) not in sheet: ${droppedUnbound.map((e) => e.appointment).join(", ")}`
      );
    }

    const inactiveAppointments = registry.appointments
      .filter((entry) => !currentSet.has(entry.appointment) && entry.boundChatId)
      .map((entry) => ({
        ...entry,
        active: false
      }));

    const nextRegistry = {
      updatedAt: new Date().toISOString(),
      appointments: [...nextAppointments, ...inactiveAppointments],
      adminAppointments: pruneUnboundAdminAppointments({
        ...registry,
        appointments: [...nextAppointments, ...inactiveAppointments],
        adminAppointments: (registry.adminAppointments ?? []).filter((appointment) =>
          currentNormalizedSet.has(normalizeAppointmentName(appointment))
        )
      })
    };

    await writeAppointmentRegistry(nextRegistry);
    return nextRegistry;
  });
}

export async function addAppointmentToRegistry(appointment) {
  return withStorageMutation(async () => {
    const normalizedAppointment = normalizeAppointmentInput(appointment);

    if (!normalizedAppointment) {
      return { ok: false, reason: "invalid_appointment" };
    }

    const registry = await readAppointmentRegistry();
    const existing = findAppointmentEntry(registry, normalizedAppointment);

    if (existing?.active) {
      return { ok: false, reason: "appointment_exists", appointment: existing.appointment };
    }

    const existingCodes = new Set(
      registry.appointments.map((entry) => normalizeCode(entry.secretCode))
    );
    const secretCode = generateSecretCode(existingCodes);

    if (existing) {
      registry.appointments = registry.appointments.map((entry) =>
        normalizeAppointmentName(entry.appointment) === normalizeAppointmentName(normalizedAppointment)
          ? {
            ...entry,
            appointment: normalizedAppointment,
            secretCode,
            active: true,
            boundChatId: null,
            boundUserId: null,
            boundUsername: null,
            boundFullName: null,
            boundAt: null
          }
          : entry
      );
    } else {
      registry.appointments.push({
        appointment: normalizedAppointment,
        secretCode,
        active: true,
        boundChatId: null,
        boundUserId: null,
        boundUsername: null,
        boundFullName: null,
        boundAt: null
      });
    }

    registry.updatedAt = new Date().toISOString();
    await writeAppointmentRegistry(registry);
    logStorageSuccess("Generated secret code for new appointment.", {
      appointment: normalizedAppointment
    });
    return { ok: true, appointment: normalizedAppointment, secretCode };
  });
}

export async function removeAppointmentFromRegistry(appointment) {
  return withStorageMutation(async () => {
    const registry = await readAppointmentRegistry();
    const target = findAppointmentEntry(registry, appointment);

    if (!target || !target.active) {
      return { ok: false, reason: "appointment_not_found" };
    }

    registry.appointments = registry.appointments.map((entry) =>
      normalizeAppointmentName(entry.appointment) === normalizeAppointmentName(target.appointment)
        ? {
          ...entry,
          active: false,
          boundChatId: null,
          boundUserId: null,
          boundUsername: null,
          boundFullName: null,
          boundAt: null
        }
        : entry
    );
    registry.adminAppointments = pruneUnboundAdminAppointments(registry);
    registry.updatedAt = new Date().toISOString();
    await writeAppointmentRegistry(registry);

    const users = await readUsers();
    const nextUsers = users.map((user) =>
      normalizeAppointmentName(user.appointment) === normalizeAppointmentName(target.appointment)
        ? clearUserBindingFields(user)
        : user
    );
    await writeUsers(nextUsers);

    return { ok: true, appointment: target.appointment };
  });
}

export async function listActiveAppointmentCodes() {
  const registry = await readAppointmentRegistry();
  return registry.appointments.filter((entry) => entry.active);
}

export async function listPendingAppointments() {
  const registry = await readAppointmentRegistry();
  return registry.appointments.filter((entry) => entry.active && !entry.boundChatId);
}

export async function getAppointmentRegistry() {
  return readAppointmentRegistry();
}

export async function getSettings() {
  return readSettings();
}

export async function setAttendanceOptions(attendanceOptions) {
  return withStorageMutation(async () => {
    const settings = await readSettings();
    settings.updatedAt = new Date().toISOString();
    settings.attendanceOptionsVersion = ATTENDANCE_OPTION_SCHEMA_VERSION;
    settings.attendanceOptions = [...new Set(
      attendanceOptions
        .map(normalizeAttendanceOption)
        .filter(Boolean)
    )];
    await writeSettings(settings);
    return settings.attendanceOptions;
  });
}

export async function resetAttendanceOptions() {
  return withStorageMutation(async () => {
    const settings = await readSettings();
    settings.updatedAt = new Date().toISOString();
    settings.attendanceOptionsVersion = ATTENDANCE_OPTION_SCHEMA_VERSION;
    settings.attendanceOptions = null;
    await writeSettings(settings);
    return settings;
  });
}

export async function setAttendanceOptionUsage(attendanceOptionUsage) {
  return withStorageMutation(async () => {
    const settings = await readSettings();
    settings.updatedAt = new Date().toISOString();
    settings.attendanceOptionUsageUpdatedAt = settings.updatedAt;
    settings.attendanceOptionUsage = attendanceOptionUsage;
    await writeSettings(settings);
    return settings;
  });
}

export async function listAdminAppointments(defaultAdminAppointments) {
  const registry = await readAppointmentRegistry();
  const prunedCustomAdmins = pruneUnboundAdminAppointments(registry);

  if ((registry.adminAppointments ?? []).length !== prunedCustomAdmins.length) {
    await withStorageMutation(async () => {
      const refreshedRegistry = await readAppointmentRegistry();
      refreshedRegistry.adminAppointments = pruneUnboundAdminAppointments(refreshedRegistry);
      refreshedRegistry.updatedAt = new Date().toISOString();
      await writeAppointmentRegistry(refreshedRegistry);
    });
  }

  const boundActiveAppointments = new Map(
    registry.appointments
      .filter((entry) => entry.active && entry.boundChatId)
      .map((entry) => [normalizeAppointmentName(entry.appointment), entry.appointment])
  );
  const effectiveAdmins = new Map();

  for (const appointment of defaultAdminAppointments) {
    const normalizedAppointment = normalizeAppointmentName(appointment);

    if (appointment.trim() && boundActiveAppointments.has(normalizedAppointment)) {
      effectiveAdmins.set(normalizedAppointment, {
        appointment: boundActiveAppointments.get(normalizedAppointment),
        source: "default"
      });
    }
  }

  for (const appointment of prunedCustomAdmins) {
    const normalizedAppointment = normalizeAppointmentName(appointment);

    if (appointment.trim() && boundActiveAppointments.has(normalizedAppointment)) {
      effectiveAdmins.set(normalizedAppointment, {
        appointment: boundActiveAppointments.get(normalizedAppointment),
        source: "custom"
      });
    }
  }

  return [...effectiveAdmins.values()];
}

export async function addAdminAppointment(appointment) {
  return withStorageMutation(async () => {
    const registry = await readAppointmentRegistry();
    const target = findAppointmentEntry(registry, appointment);

    if (!target || !target.active) {
      return { ok: false, reason: "appointment_not_found" };
    }

    if (!target.boundChatId) {
      return { ok: false, reason: "appointment_not_bound" };
    }

    const alreadyPresent = (registry.adminAppointments ?? []).some(
      (entry) =>
        normalizeAppointmentName(entry) === normalizeAppointmentName(target.appointment)
    );

    if (!alreadyPresent) {
      registry.adminAppointments = [
        ...(registry.adminAppointments ?? []),
        target.appointment
      ];
      registry.adminAppointments = pruneUnboundAdminAppointments(registry);
      registry.updatedAt = new Date().toISOString();
      await writeAppointmentRegistry(registry);
    }

    return { ok: true, appointment: target.appointment };
  });
}

export async function removeAdminAppointment(appointment, defaultAdminAppointments) {
  return withStorageMutation(async () => {
    const registry = await readAppointmentRegistry();
    const target = findAppointmentEntry(registry, appointment);
    const normalizedTarget = normalizeAppointmentName(target?.appointment ?? appointment);

    if (
      defaultAdminAppointments.some(
        (entry) => normalizeAppointmentName(entry) === normalizedTarget
      )
    ) {
      return { ok: false, reason: "default_admin" };
    }

    const before = registry.adminAppointments ?? [];
    const after = before.filter(
      (entry) => normalizeAppointmentName(entry) !== normalizedTarget
    );

    if (before.length === after.length) {
      return { ok: false, reason: "admin_not_found" };
    }

    registry.adminAppointments = after;
    registry.adminAppointments = pruneUnboundAdminAppointments(registry);
    registry.updatedAt = new Date().toISOString();
    await writeAppointmentRegistry(registry);
    return { ok: true, appointment: target?.appointment ?? appointment.trim() };
  });
}

export async function deregisterAppointmentBinding(appointment) {
  return withStorageMutation(async () => {
    const registry = await readAppointmentRegistry();
    const target = findAppointmentEntry(registry, appointment);

    if (!target || !target.active) {
      return { ok: false, reason: "appointment_not_found" };
    }

    if (!target.boundChatId) {
      return { ok: false, reason: "not_bound", appointment: target.appointment };
    }

    const existingCodes = new Set(
      registry.appointments
        .filter((entry) => entry.appointment !== target.appointment)
        .map((entry) => normalizeCode(entry.secretCode))
    );
    const rotatedSecretCode = generateSecretCode(existingCodes);

    const updatedTarget = {
      ...target,
      secretCode: rotatedSecretCode,
      boundChatId: null,
      boundUserId: null,
      boundUsername: null,
      boundFullName: null,
      boundAt: null
    };

    registry.appointments = registry.appointments.map((entry) =>
      normalizeAppointmentName(entry.appointment) ===
      normalizeAppointmentName(target.appointment)
        ? updatedTarget
        : entry
    );
    registry.adminAppointments = pruneUnboundAdminAppointments(registry);
    registry.updatedAt = new Date().toISOString();
    await writeAppointmentRegistry(registry);

    const users = await readUsers();
    const nextUsers = users.map((user) =>
      user.chatId === target.boundChatId
        ? clearUserBindingFields(user)
        : user
    );
    await writeUsers(nextUsers);

    return {
      ok: true,
      appointment: target.appointment,
      previousChatId: target.boundChatId,
      secretCode: rotatedSecretCode
    };
  });
}

/**
 * Transfers a user's binding from one appointment slot to another.
 *
 * - `fromAppointment` must be active and bound to a user.
 * - `toAppointment` must be active and currently unbound.
 *
 * After the transfer:
 *   - The user's appointment field is updated to `toAppointment`.
 *   - The `to` registry entry inherits all binding fields from `from`.
 *   - The `from` registry entry is cleared and issued a fresh secret code.
 *
 * Returns `{ ok, fromAppointment, toAppointment, chatId, username, fullName }` on
 * success or `{ ok: false, reason }` on failure.
 */
export async function transferAppointmentBinding(fromAppointment, toAppointment) {
  return withStorageMutation(async () => {
    const registry = await readAppointmentRegistry();
    const fromEntry = findAppointmentEntry(registry, fromAppointment);
    const toEntry = findAppointmentEntry(registry, toAppointment);

    if (!fromEntry || !fromEntry.active) {
      return { ok: false, reason: "from_not_found" };
    }
    if (!fromEntry.boundChatId) {
      return { ok: false, reason: "from_not_bound" };
    }
    if (!toEntry || !toEntry.active) {
      return { ok: false, reason: "to_not_found" };
    }
    if (toEntry.boundChatId) {
      return { ok: false, reason: "to_already_bound" };
    }

    const existingCodes = new Set(
      registry.appointments
        .filter((e) => e.appointment !== fromEntry.appointment)
        .map((e) => normalizeCode(e.secretCode))
    );
    const freshCode = generateSecretCode(existingCodes);

    registry.appointments = registry.appointments.map((entry) => {
      const norm = normalizeAppointmentName(entry.appointment);
      if (norm === normalizeAppointmentName(fromEntry.appointment)) {
        return {
          ...entry,
          secretCode: freshCode,
          boundChatId: null,
          boundUserId: null,
          boundUsername: null,
          boundFullName: null,
          boundAt: null
        };
      }
      if (norm === normalizeAppointmentName(toEntry.appointment)) {
        return {
          ...entry,
          boundChatId: fromEntry.boundChatId,
          boundUserId: fromEntry.boundUserId,
          boundUsername: fromEntry.boundUsername,
          boundFullName: fromEntry.boundFullName,
          boundAt: fromEntry.boundAt
        };
      }
      return entry;
    });

    registry.adminAppointments = pruneUnboundAdminAppointments(registry);
    registry.updatedAt = new Date().toISOString();
    await writeAppointmentRegistry(registry);

    const users = await readUsers();
    const nextUsers = users.map((user) =>
      String(user.chatId) === String(fromEntry.boundChatId)
        ? { ...user, appointment: toEntry.appointment, updatedAt: new Date().toISOString() }
        : user
    );
    await writeUsers(nextUsers);

    logStorageSuccess(`# Transferred binding.`, {
      from: fromEntry.appointment,
      to: toEntry.appointment,
      chatId: fromEntry.boundChatId,
      username: fromEntry.boundUsername
    });

    return {
      ok: true,
      fromAppointment: fromEntry.appointment,
      toAppointment: toEntry.appointment,
      chatId: fromEntry.boundChatId,
      username: fromEntry.boundUsername,
      fullName: fromEntry.boundFullName
    };
  });
}

export async function deregisterRequestorByChatId(chatId) {
  const users = await readUsers();
  const user = users.find((entry) => entry.chatId === String(chatId));

  if (!user?.appointment) {
    return { ok: false, reason: "not_bound" };
  }

  return deregisterAppointmentBinding(user.appointment);
}

export async function getOnboardingInvite(appointment) {
  const registry = await readAppointmentRegistry();
  const target = findAppointmentEntry(registry, appointment);

  if (!target || !target.active) {
    return { ok: false, reason: "appointment_not_found" };
  }

  return {
    ok: true,
    appointment: target.appointment,
    secretCode: target.secretCode,
    bound: Boolean(target.boundChatId)
  };
}

export async function bindAppointmentCode(secretCode, telegramUser) {
  return withStorageMutation(async () => {
    const normalizedCode = normalizeCode(secretCode);
    const registry = await readAppointmentRegistry();
    const targetIndex = registry.appointments.findIndex(
      (entry) => normalizeCode(entry.secretCode) === normalizedCode
    );

    if (targetIndex === -1) {
      return { ok: false, reason: "invalid_code" };
    }

    const target = registry.appointments[targetIndex];

    if (!target.active) {
      return { ok: false, reason: "inactive_code", appointment: target.appointment };
    }

    if (
      target.boundChatId &&
      (target.boundChatId !== telegramUser.chatId || target.boundUserId !== telegramUser.userId)
    ) {
      return { ok: false, reason: "code_already_claimed", appointment: target.appointment };
    }

    registry.appointments = registry.appointments.map((entry) => {
      if (
        entry.boundChatId === telegramUser.chatId &&
        entry.appointment !== target.appointment
      ) {
        return {
          ...entry,
          boundChatId: null,
          boundUserId: null,
          boundUsername: null,
          boundFullName: null,
          boundAt: null
        };
      }

      return entry;
    });

    registry.appointments[targetIndex] = {
      ...registry.appointments[targetIndex],
      boundChatId: telegramUser.chatId,
      boundUserId: telegramUser.userId,
      boundUsername: telegramUser.username,
      boundFullName: telegramUser.fullName,
      boundAt: new Date().toISOString()
    };
    registry.adminAppointments = pruneUnboundAdminAppointments(registry);
    registry.updatedAt = new Date().toISOString();

    await writeAppointmentRegistry(registry);

    return {
      ok: true,
      appointment: registry.appointments[targetIndex].appointment,
      secretCode: registry.appointments[targetIndex].secretCode
    };
  });
}
