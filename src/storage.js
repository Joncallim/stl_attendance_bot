import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const APPOINTMENT_REGISTRY_FILE = path.join(DATA_DIR, "appointment-registry.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readJsonFile(filePath, fallbackValue) {
  await ensureDataDir();

  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }

    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  await ensureDataDir();
  await writeFile(filePath, JSON.stringify(value, null, 2));
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

async function readUsers() {
  return readJsonFile(USERS_FILE, []);
}

async function writeUsers(users) {
  await writeJsonFile(USERS_FILE, users);
}

async function readAppointmentRegistry() {
  return readJsonFile(APPOINTMENT_REGISTRY_FILE, {
    updatedAt: null,
    appointments: [],
    adminAppointments: []
  });
}

async function writeAppointmentRegistry(registry) {
  await writeJsonFile(APPOINTMENT_REGISTRY_FILE, registry);
}

async function readSettings() {
  return readJsonFile(SETTINGS_FILE, {
    updatedAt: null,
    attendanceOptions: null,
    attendanceOptionsVersion: null,
    attendanceOptionUsage: null,
    attendanceOptionUsageUpdatedAt: null
  });
}

async function writeSettings(settings) {
  await writeJsonFile(SETTINGS_FILE, settings);
}

function normalizeAttendanceOption(value) {
  return String(value ?? "").trim();
}

const ATTENDANCE_OPTION_SCHEMA_VERSION = 2;

export async function upsertUser(user) {
  const users = await readUsers();
  const index = users.findIndex((entry) => entry.chatId === user.chatId);

  if (index >= 0) {
    users[index] = { ...users[index], ...user };
  } else {
    users.push(user);
  }

  await writeUsers(users);
}

export async function listUsers() {
  return readUsers();
}

export async function getUserByChatId(chatId) {
  const users = await readUsers();
  return users.find((entry) => entry.chatId === String(chatId)) ?? null;
}

export async function updateUserByChatId(chatId, patch) {
  const users = await readUsers();
  const index = users.findIndex((entry) => entry.chatId === String(chatId));

  if (index === -1) {
    return null;
  }

  users[index] = { ...users[index], ...patch };
  await writeUsers(users);
  return users[index];
}

export async function syncAppointmentRegistry(appointments) {
  const registry = await readAppointmentRegistry();
  const uniqueAppointments = [...new Set(appointments.map((value) => value.trim()).filter(Boolean))];
  const currentSet = new Set(uniqueAppointments);
  const currentNormalizedSet = new Set(uniqueAppointments.map(normalizeAppointmentName));
  const existingCodes = new Set(
    registry.appointments.map((entry) => normalizeCode(entry.secretCode))
  );

  const nextAppointments = uniqueAppointments.map((appointment) => {
    const existing = registry.appointments.find((entry) => entry.appointment === appointment);

    if (existing) {
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

  const inactiveAppointments = registry.appointments
    .filter((entry) => !currentSet.has(entry.appointment))
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
}

export async function resetAttendanceOptions() {
  const settings = await readSettings();
  settings.updatedAt = new Date().toISOString();
  settings.attendanceOptionsVersion = ATTENDANCE_OPTION_SCHEMA_VERSION;
  settings.attendanceOptions = null;
  await writeSettings(settings);
  return settings;
}

export async function setAttendanceOptionUsage(attendanceOptionUsage) {
  const settings = await readSettings();
  settings.updatedAt = new Date().toISOString();
  settings.attendanceOptionUsageUpdatedAt = settings.updatedAt;
  settings.attendanceOptionUsage = attendanceOptionUsage;
  await writeSettings(settings);
  return settings;
}

export async function listAdminAppointments(defaultAdminAppointments) {
  const registry = await readAppointmentRegistry();
  const prunedCustomAdmins = pruneUnboundAdminAppointments(registry);

  if ((registry.adminAppointments ?? []).length !== prunedCustomAdmins.length) {
    registry.adminAppointments = prunedCustomAdmins;
    registry.updatedAt = new Date().toISOString();
    await writeAppointmentRegistry(registry);
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

function findAppointmentEntry(registry, appointment) {
  const normalized = normalizeAppointmentName(appointment);
  return registry.appointments.find(
    (entry) => normalizeAppointmentName(entry.appointment) === normalized
  );
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

export async function addAdminAppointment(appointment) {
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
}

export async function removeAdminAppointment(appointment, defaultAdminAppointments) {
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
}

export async function deregisterAppointmentBinding(appointment) {
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
}
