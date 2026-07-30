import { createHash, randomBytes, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
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

function getStorageTransactionFile() {
  return getDataFile("storage-transaction.json");
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

function isDeliberatelyRemoved(entry) {
  return Boolean(entry?.removedByBotAt);
}

function invalidateRegistryIntegrity(registry) {
  registry.integrity = null;
}

export function computeRosterChecksum(appointments) {
  const canonicalAppointments = [...new Set(
    (appointments ?? [])
      .map(normalizeAppointmentName)
      .filter(Boolean)
  )].sort();

  return createHash("sha256")
    .update(canonicalAppointments.join("\n"))
    .digest("hex");
}

function computeBindingChecksum(bindings) {
  const canonicalBindings = [...new Set(
    (bindings ?? [])
      .map(({ appointment, chatId }) => {
        const normalizedAppointment = normalizeAppointmentName(appointment);
        const normalizedChatId = String(chatId ?? "").trim();
        return normalizedAppointment && normalizedChatId
          ? `${normalizedAppointment}:${normalizedChatId}`
          : "";
      })
      .filter(Boolean)
  )].sort();

  return createHash("sha256")
    .update(canonicalBindings.join("\n"))
    .digest("hex");
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
let usersCachedPath = null;
// chatId → array-index lookup built in sync with usersCache.
// Eliminates O(n) findIndex on every user read/write.
let usersByIdIndex = null;
const USERS_CACHE_TTL_MS = 30_000;

function buildUsersByIdIndex(users) {
  return new Map(users.map((u, i) => [String(u.chatId), i]));
}

async function readUsers() {
  const filePath = getUsersFile();
  if (
    usersCache !== null &&
    filePath === usersCachedPath &&
    Date.now() - usersCacheAt < USERS_CACHE_TTL_MS
  ) {
    return usersCache;
  }
  const users = await readJsonFile(filePath, []);
  usersCache = users;
  usersByIdIndex = buildUsersByIdIndex(users);
  usersCachedPath = filePath;
  usersCacheAt = Date.now();
  return users;
}

async function writeUsers(users) {
  const filePath = getUsersFile();
  await writeJsonFile(filePath, users);
  usersCache = users;
  usersByIdIndex = buildUsersByIdIndex(users);
  usersCachedPath = filePath;
  usersCacheAt = Date.now();
}

let registryCache = null;
let registryCacheAt = 0;
let registryCachedPath = null;
const REGISTRY_CACHE_TTL_MS = 30_000;

async function readAppointmentRegistry() {
  const filePath = getAppointmentRegistryFile();
  if (
    registryCache !== null &&
    filePath === registryCachedPath &&
    Date.now() - registryCacheAt < REGISTRY_CACHE_TTL_MS
  ) {
    return registryCache;
  }
  const registry = await readJsonFile(filePath, {
    updatedAt: null,
    appointments: [],
    adminAppointments: []
  });
  registryCache = registry;
  registryCachedPath = filePath;
  registryCacheAt = Date.now();
  return registry;
}

async function writeAppointmentRegistry(registry) {
  const filePath = getAppointmentRegistryFile();
  await writeJsonFile(filePath, registry);
  registryCache = registry;
  registryCachedPath = filePath;
  registryCacheAt = Date.now();
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

// WeakMap keyed on the appointments *array reference* so the index is
// automatically invalidated whenever registry.appointments is replaced by a
// new array (e.g. via .map()).  Eliminates O(n) Array.find on every lookup.
const appointmentNameIndexCache = new WeakMap();

function findAppointmentEntry(registry, appointment) {
  let index = appointmentNameIndexCache.get(registry.appointments);
  if (!index) {
    index = new Map(
      registry.appointments.map((entry) => [normalizeAppointmentName(entry.appointment), entry])
    );
    appointmentNameIndexCache.set(registry.appointments, index);
  }
  return index.get(normalizeAppointmentName(appointment)) ?? null;
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

async function recoverStorageTransaction() {
  const transaction = await readJsonFile(getStorageTransactionFile(), null);

  if (!transaction) {
    return;
  }

  if (
    transaction.version !== 1 ||
    !transaction.registry ||
    !Array.isArray(transaction.users)
  ) {
    throw new Error("Invalid storage transaction journal; refusing unsafe recovery.");
  }

  await writeAppointmentRegistry(transaction.registry);
  await writeUsers(transaction.users);
  await unlink(getStorageTransactionFile()).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  logStorageSuccess("# Recovered interrupted storage transaction.", {
    transactionId: transaction.id,
    operation: transaction.operation
  });
}

async function commitRegistryAndUsers(registry, users, operation) {
  const transaction = {
    version: 1,
    id: randomUUID(),
    operation,
    createdAt: new Date().toISOString(),
    registry,
    users
  };

  await writeJsonFile(getStorageTransactionFile(), transaction);
  await writeAppointmentRegistry(registry);
  await writeUsers(users);
  await unlink(getStorageTransactionFile()).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

function withStorageMutation(operation) {
  return runSerialized(STORAGE_MUTEX_KEY, async () => {
    await recoverStorageTransaction();
    return operation();
  });
}

export async function recoverStorageTransactions() {
  return runSerialized(STORAGE_MUTEX_KEY, recoverStorageTransaction);
}

let pendingUserUpdateBatch = null;

function createUserUpdateBatch() {
  const requests = [];
  const ready = new Promise((resolve) => setImmediate(resolve));
  const flushPromise = withStorageMutation(async () => {
    // One event-loop turn collects attendance submissions that arrived in the
    // same Telegram update burst. The mutation is registered with the storage
    // serializer immediately, preserving its order relative to other writes.
    await ready;

    if (pendingUserUpdateBatch?.requests === requests) {
      pendingUserUpdateBatch = null;
    }

    const users = await readUsers();
    const results = [];

    for (const { chatId, patch } of requests) {
      const index = usersByIdIndex?.get(String(chatId)) ?? -1;

      if (index === -1) {
        results.push(null);
        continue;
      }

      users[index] = { ...users[index], ...patch };
      results.push(users[index]);
    }

    if (requests.length > 0) {
      await writeUsers(users);
    }

    return results;
  });
  const batch = { requests, flushPromise };
  pendingUserUpdateBatch = batch;
  return batch;
}

export async function upsertUser(user) {
  return withStorageMutation(async () => {
    const users = await readUsers();
    const index = usersByIdIndex?.get(String(user.chatId)) ?? -1;

    if (index >= 0) {
      users[index] = { ...users[index], ...user };
    } else {
      users.push(user);
    }

    await writeUsers(users);
    return index >= 0 ? users[index] : users[users.length - 1];
  });
}

export async function listUsers() {
  return readUsers();
}

export async function getUserByChatId(chatId) {
  await readUsers(); // ensures cache + index are populated
  const index = usersByIdIndex?.get(String(chatId));
  return index !== undefined ? (usersCache[index] ?? null) : null;
}

export async function updateUserByChatId(chatId, patch) {
  const batch = pendingUserUpdateBatch ?? createUserUpdateBatch();
  const resultIndex = batch.requests.push({ chatId, patch }) - 1;
  const results = await batch.flushPromise;
  return results[resultIndex] ?? null;
}

// Applies multiple patches in a single read-modify-write cycle. Use this
// instead of calling updateUserByChatId in a loop when many users need updating
// at once (e.g. after a batch reminder send).
export async function batchUpdateUsersByChatId(patches) {
  if (!patches || patches.length === 0) return [];
  return withStorageMutation(async () => {
    const users = await readUsers();
    const results = [];
    for (const {
      chatId,
      patch,
      expectedAppointment,
      notSubmittedAfter,
      notPromptedAfter
    } of patches) {
      const index = usersByIdIndex?.get(String(chatId)) ?? -1;
      if (index === -1) {
        results.push(null);
        continue;
      }
      const currentUser = users[index];
      const submittedAt = Date.parse(currentUser.lastSubmittedAt ?? "");
      const promptedAt = Date.parse(currentUser.promptedAt ?? "");

      if (
        (expectedAppointment !== undefined &&
          normalizeAppointmentName(currentUser.appointment) !==
            normalizeAppointmentName(expectedAppointment)) ||
        (notSubmittedAfter &&
          Number.isFinite(submittedAt) &&
          submittedAt >= Date.parse(notSubmittedAfter)) ||
        (notPromptedAfter &&
          Number.isFinite(promptedAt) &&
          promptedAt > Date.parse(notPromptedAfter))
      ) {
        results.push(null);
        continue;
      }
      users[index] = { ...currentUser, ...patch };
      results.push(users[index]);
    }
    await writeUsers(users);
    return results;
  });
}

export async function syncAppointmentRegistry(appointments = null) {
  return withStorageMutation(async () => {
    const registry = await readAppointmentRegistry();
    const users = await readUsers();
    const now = new Date().toISOString();
    const sheetWasProvided = Array.isArray(appointments);
    const sheetAppointmentsByIdentity = new Map();

    for (const value of appointments ?? []) {
      const appointment = String(value ?? "").trim();
      const identity = normalizeAppointmentName(appointment);

      if (identity && !sheetAppointmentsByIdentity.has(identity)) {
        sheetAppointmentsByIdentity.set(identity, appointment);
      }
    }

    const existingByIdentity = new Map();

    for (const entry of registry.appointments ?? []) {
      const identity = normalizeAppointmentName(entry.appointment);

      if (identity && !existingByIdentity.has(identity)) {
        existingByIdentity.set(identity, entry);
      }
    }

    const deliberatelyRemovedIdentities = new Set(
      [...existingByIdentity.entries()]
        .filter(([, entry]) => isDeliberatelyRemoved(entry))
        .map(([identity]) => identity)
    );
    const activeIdentities = new Set();

    // The active roster is the union of Google ONBOARDING and the main local
    // registry. A one-sided disappearance is treated as an interrupted write
    // and repaired, never as permission to delete. Only a bot tombstone wins
    // over this union.
    for (const identity of sheetAppointmentsByIdentity.keys()) {
      if (!deliberatelyRemovedIdentities.has(identity)) {
        activeIdentities.add(identity);
      }
    }

    for (const [identity, entry] of existingByIdentity) {
      const recoverableLegacyBinding = !entry.active && entry.boundChatId && !isDeliberatelyRemoved(entry);

      if ((entry.active || recoverableLegacyBinding) && !deliberatelyRemovedIdentities.has(identity)) {
        activeIdentities.add(identity);
      }
    }

    const existingCodes = new Set(
      (registry.appointments ?? []).map((entry) => normalizeCode(entry.secretCode)).filter(Boolean)
    );
    const orderedActiveIdentities = [
      ...sheetAppointmentsByIdentity.keys(),
      ...[...activeIdentities].filter((identity) => !sheetAppointmentsByIdentity.has(identity))
    ].filter((identity, index, values) =>
      activeIdentities.has(identity) && values.indexOf(identity) === index
    );
    const nextAppointments = orderedActiveIdentities.map((identity) => {
      const existing = existingByIdentity.get(identity);
      const appointment = sheetAppointmentsByIdentity.get(identity) ?? existing?.appointment ?? identity;
      let secretCode = normalizeCode(existing?.secretCode);

      if (!secretCode) {
        secretCode = generateSecretCode(existingCodes);
        existingCodes.add(secretCode);
      }

      return {
        ...existing,
        appointment,
        secretCode,
        active: true,
        boundChatId: existing?.boundChatId ?? null,
        boundUserId: existing?.boundUserId ?? null,
        boundUsername: existing?.boundUsername ?? null,
        boundFullName: existing?.boundFullName ?? null,
        boundAt: existing?.boundAt ?? null,
        removedByBotAt: null,
        removalReason: null
      };
    });

    const tombstones = [...existingByIdentity.entries()]
      .filter(([identity, entry]) =>
        deliberatelyRemovedIdentities.has(identity) && !activeIdentities.has(identity) && isDeliberatelyRemoved(entry)
      )
      .map(([, entry]) => ({ ...entry, active: false }));
    const legacyInactiveAppointments = [...existingByIdentity.entries()]
      .filter(([identity, entry]) =>
        !activeIdentities.has(identity) && !isDeliberatelyRemoved(entry)
      )
      .map(([, entry]) => ({ ...entry, active: false }));
    const nextByIdentity = new Map(
      nextAppointments.map((entry) => [normalizeAppointmentName(entry.appointment), entry])
    );
    const nextUsers = users.map((user) => ({ ...user }));
    const userIndexByChatId = new Map(
      nextUsers.map((user, index) => [String(user.chatId), index])
    );
    const userCandidatesByAppointment = new Map();
    const bindingConflicts = [];
    const repairedUserBindings = [];
    const repairedRegistryBindings = [];
    const clearedUserBindings = [];

    for (const user of nextUsers) {
      const identity = normalizeAppointmentName(user.appointment);

      if (!identity) {
        continue;
      }

      if (!activeIdentities.has(identity)) {
        Object.assign(user, clearUserBindingFields(user));
        clearedUserBindings.push(String(user.chatId));
        continue;
      }

      if (!userCandidatesByAppointment.has(identity)) {
        userCandidatesByAppointment.set(identity, []);
      }
      userCandidatesByAppointment.get(identity).push(user);
    }

    const registryAppointmentsByChatId = new Map();

    for (const entry of nextAppointments) {
      if (!entry.boundChatId) {
        continue;
      }

      const chatId = String(entry.boundChatId);
      const existingAppointment = registryAppointmentsByChatId.get(chatId);

      if (existingAppointment && existingAppointment !== entry.appointment) {
        bindingConflicts.push({
          reason: "registry_chat_bound_twice",
          chatId,
          appointments: [existingAppointment, entry.appointment]
        });
        continue;
      }
      registryAppointmentsByChatId.set(chatId, entry.appointment);

      const userIndex = userIndexByChatId.get(chatId);

      if (userIndex === undefined) {
        const recoveredUser = {
          chatId,
          userId: entry.boundUserId ? String(entry.boundUserId) : "",
          username: entry.boundUsername ?? "",
          firstName: "",
          lastName: "",
          fullName: entry.boundFullName ?? "",
          appointment: entry.appointment,
          onboardingSecretCode: entry.secretCode,
          onboardingCompletedAt: entry.boundAt ?? now,
          awaitingAttendance: false,
          awaitingSecretCode: false,
          awaitingWeeklyAttendance: false,
          weeklyAttendanceDates: [],
          weeklyAttendanceIndex: 0,
          weeklyAttendanceResults: [],
          weeklyAttendanceEntries: [],
          recoveredFromRegistryAt: now,
          updatedAt: now
        };
        userIndexByChatId.set(chatId, nextUsers.length);
        nextUsers.push(recoveredUser);
        repairedUserBindings.push(chatId);
        continue;
      }

      const user = nextUsers[userIndex];
      const userIdentity = normalizeAppointmentName(user.appointment);
      const entryIdentity = normalizeAppointmentName(entry.appointment);

      if (userIdentity && userIdentity !== entryIdentity) {
        bindingConflicts.push({
          reason: "chat_appointment_mismatch",
          chatId,
          registryAppointment: entry.appointment,
          userAppointment: user.appointment
        });
        continue;
      }

      if (!userIdentity || user.appointment !== entry.appointment) {
        Object.assign(user, {
          appointment: entry.appointment,
          onboardingSecretCode: entry.secretCode,
          onboardingCompletedAt: user.onboardingCompletedAt ?? entry.boundAt ?? now,
          awaitingSecretCode: false,
          repairedFromRegistryAt: now,
          updatedAt: now
        });
        repairedUserBindings.push(chatId);
      }
    }

    for (const [identity, candidates] of userCandidatesByAppointment) {
      const entry = nextByIdentity.get(identity);

      // A binding-removal tombstone is authoritative. It prevents an
      // interrupted or manually-restored users.json write from silently
      // re-creating a binding that the bot deliberately removed.
      if (entry?.bindingRemovedAt && !entry.boundChatId) {
        for (const candidate of candidates) {
          Object.assign(candidate, clearUserBindingFields(candidate));
          clearedUserBindings.push(String(candidate.chatId));
        }
        continue;
      }

      if (!entry || entry.boundChatId) {
        if (entry?.boundChatId) {
          const boundChatId = String(entry.boundChatId);
          for (const candidate of candidates) {
            if (String(candidate.chatId) !== boundChatId) {
              bindingConflicts.push({
                reason: "appointment_claimed_by_multiple_users",
                appointment: entry.appointment,
                registryChatId: boundChatId,
                userChatId: String(candidate.chatId)
              });
            }
          }
        }
        continue;
      }

      if (candidates.length !== 1) {
        bindingConflicts.push({
          reason: "appointment_claimed_by_multiple_users",
          appointment: entry.appointment,
          userChatIds: candidates.map((user) => String(user.chatId))
        });
        continue;
      }

      const user = candidates[0];
      const chatId = String(user.chatId);
      const otherAppointment = registryAppointmentsByChatId.get(chatId);

      if (otherAppointment && normalizeAppointmentName(otherAppointment) !== identity) {
        bindingConflicts.push({
          reason: "user_chat_bound_to_different_registry_appointment",
          chatId,
          registryAppointment: otherAppointment,
          userAppointment: user.appointment
        });
        continue;
      }

      Object.assign(entry, {
        boundChatId: chatId,
        boundUserId: user.userId ? String(user.userId) : null,
        boundUsername: user.username ?? "",
        boundFullName: user.fullName ?? "",
        boundAt: user.onboardingCompletedAt ?? user.updatedAt ?? now
      });
      registryAppointmentsByChatId.set(chatId, entry.appointment);
      repairedRegistryBindings.push(chatId);
    }

    const activeAppointmentNames = nextAppointments.map((entry) => entry.appointment);
    const sheetAppointmentNames = [...sheetAppointmentsByIdentity.values()];
    const checksum = computeRosterChecksum(activeAppointmentNames);
    const sheetChecksum = sheetWasProvided ? computeRosterChecksum(sheetAppointmentNames) : null;
    const registryBindingChecksum = computeBindingChecksum(
      nextAppointments
        .filter((entry) => entry.boundChatId)
        .map((entry) => ({ appointment: entry.appointment, chatId: entry.boundChatId }))
    );
    const userBindingChecksum = computeBindingChecksum(
      nextUsers
        .filter((user) => user.appointment)
        .map((user) => ({ appointment: user.appointment, chatId: user.chatId }))
    );

    const nextRegistry = {
      ...registry,
      updatedAt: now,
      appointments: [...nextAppointments, ...tombstones, ...legacyInactiveAppointments],
      adminAppointments: pruneUnboundAdminAppointments({
        ...registry,
        appointments: nextAppointments,
        adminAppointments: registry.adminAppointments ?? []
      }),
      integrity: {
        version: 1,
        checkedAt: now,
        checksum,
        sheetChecksum,
        registryChecksum: checksum,
        registryBindingChecksum,
        userBindingChecksum,
        rosterConsistent: sheetChecksum === null ? null : sheetChecksum === checksum,
        bindingsConsistent:
          registryBindingChecksum === userBindingChecksum && bindingConflicts.length === 0,
        sheetCount: sheetWasProvided ? sheetAppointmentNames.length : null,
        registryCount: activeAppointmentNames.length,
        repairedUserBindings,
        repairedRegistryBindings,
        clearedUserBindings,
        conflicts: bindingConflicts
      }
    };

    await commitRegistryAndUsers(nextRegistry, nextUsers, "sync_appointment_registry");

    logStorageSuccess("# Roster integrity checksum completed.", {
      checksum,
      rosterConsistent: nextRegistry.integrity.rosterConsistent,
      bindingsConsistent: nextRegistry.integrity.bindingsConsistent,
      repairedUserBindings: repairedUserBindings.length,
      repairedRegistryBindings: repairedRegistryBindings.length,
      clearedUserBindings: clearedUserBindings.length,
      conflicts: bindingConflicts.length
    });
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
            removedByBotAt: null,
            removalReason: null,
            boundChatId: null,
            boundUserId: null,
            boundUsername: null,
            boundFullName: null,
            boundAt: null
          }
          : entry
      );
    } else {
      registry.appointments = [
        ...registry.appointments,
        {
          appointment: normalizedAppointment,
          secretCode,
          active: true,
          removedByBotAt: null,
          removalReason: null,
          boundChatId: null,
          boundUserId: null,
          boundUsername: null,
          boundFullName: null,
          boundAt: null
        }
      ];
    }

    registry.updatedAt = new Date().toISOString();
    invalidateRegistryIntegrity(registry);
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

    const removedAt = new Date().toISOString();
    registry.appointments = registry.appointments.map((entry) =>
      normalizeAppointmentName(entry.appointment) === normalizeAppointmentName(target.appointment)
        ? {
          ...entry,
          active: false,
          removedByBotAt: removedAt,
          removalReason: "bot",
          boundChatId: null,
          boundUserId: null,
          boundUsername: null,
          boundFullName: null,
          boundAt: null
        }
        : entry
    );
    registry.adminAppointments = pruneUnboundAdminAppointments(registry);
    registry.updatedAt = removedAt;
    invalidateRegistryIntegrity(registry);
    const users = await readUsers();
    const nextUsers = users.map((user) =>
      normalizeAppointmentName(user.appointment) === normalizeAppointmentName(target.appointment)
        ? clearUserBindingFields(user)
        : user
    );
    await commitRegistryAndUsers(
      registry,
      nextUsers,
      "remove_appointment"
    );

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
    invalidateRegistryIntegrity(registry);
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

    const bindingRemovedAt = new Date().toISOString();
    const updatedTarget = {
      ...target,
      secretCode: rotatedSecretCode,
      boundChatId: null,
      boundUserId: null,
      boundUsername: null,
      boundFullName: null,
      boundAt: null,
      bindingRemovedAt,
      bindingRemovalReason: "deregistered"
    };

    registry.appointments = registry.appointments.map((entry) =>
      normalizeAppointmentName(entry.appointment) ===
      normalizeAppointmentName(target.appointment)
        ? updatedTarget
        : entry
    );
    registry.adminAppointments = pruneUnboundAdminAppointments(registry);
    registry.updatedAt = bindingRemovedAt;
    invalidateRegistryIntegrity(registry);

    const users = await readUsers();
    const nextUsers = users.map((user) =>
      String(user.chatId) === String(target.boundChatId)
        ? clearUserBindingFields(user)
        : user
    );
    await commitRegistryAndUsers(registry, nextUsers, "deregister_binding");

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

    const transferredAt = new Date().toISOString();
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
          boundAt: null,
          bindingRemovedAt: transferredAt,
          bindingRemovalReason: "transferred"
        };
      }
      if (norm === normalizeAppointmentName(toEntry.appointment)) {
        return {
          ...entry,
          boundChatId: fromEntry.boundChatId,
          boundUserId: fromEntry.boundUserId,
          boundUsername: fromEntry.boundUsername,
          boundFullName: fromEntry.boundFullName,
          boundAt: fromEntry.boundAt,
          bindingRemovedAt: null,
          bindingRemovalReason: null
        };
      }
      return entry;
    });

    registry.adminAppointments = pruneUnboundAdminAppointments(registry);
    registry.updatedAt = transferredAt;
    invalidateRegistryIntegrity(registry);

    const users = await readUsers();
    const nextUsers = users.map((user) =>
      String(user.chatId) === String(fromEntry.boundChatId)
        ? { ...user, appointment: toEntry.appointment, updatedAt: transferredAt }
        : user
    );
    await commitRegistryAndUsers(registry, nextUsers, "transfer_binding");

    logStorageSuccess(`# Transferred binding.`, {
      from: fromEntry.appointment,
      to: toEntry.appointment
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
    const users = await readUsers();
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
      (
        String(target.boundChatId) !== String(telegramUser.chatId) ||
        String(target.boundUserId) !== String(telegramUser.userId)
      )
    ) {
      return { ok: false, reason: "code_already_claimed", appointment: target.appointment };
    }

    registry.appointments = registry.appointments.map((entry) => {
      if (
        String(entry.boundChatId ?? "") === String(telegramUser.chatId) &&
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

    const boundAt = new Date().toISOString();
    registry.appointments[targetIndex] = {
      ...registry.appointments[targetIndex],
      boundChatId: String(telegramUser.chatId),
      boundUserId: String(telegramUser.userId),
      boundUsername: telegramUser.username,
      boundFullName: telegramUser.fullName,
      boundAt,
      bindingRemovedAt: null,
      bindingRemovalReason: null
    };
    registry.adminAppointments = pruneUnboundAdminAppointments(registry);
    registry.updatedAt = boundAt;
    invalidateRegistryIntegrity(registry);

    const userIndex = usersByIdIndex?.get(String(telegramUser.chatId)) ?? -1;
    const userPatch = {
      chatId: String(telegramUser.chatId),
      userId: String(telegramUser.userId),
      username: telegramUser.username ?? "",
      fullName: telegramUser.fullName ?? "",
      appointment: registry.appointments[targetIndex].appointment,
      onboardingSecretCode: registry.appointments[targetIndex].secretCode,
      onboardingCompletedAt: boundAt,
      awaitingSecretCode: false,
      updatedAt: boundAt
    };

    if (userIndex >= 0) {
      users[userIndex] = { ...users[userIndex], ...userPatch };
    } else {
      users.push({
        firstName: "",
        lastName: "",
        awaitingAttendance: false,
        awaitingWeeklyAttendance: false,
        weeklyAttendanceDates: [],
        weeklyAttendanceIndex: 0,
        weeklyAttendanceResults: [],
        weeklyAttendanceEntries: [],
        ...userPatch
      });
    }
    await commitRegistryAndUsers(registry, users, "bind_appointment");

    return {
      ok: true,
      appointment: registry.appointments[targetIndex].appointment,
      secretCode: registry.appointments[targetIndex].secretCode
    };
  });
}
