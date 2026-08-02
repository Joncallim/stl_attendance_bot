import { randomUUID } from "node:crypto";
import { getDataFile } from "./dataDir.js";
import { readJsonFile, removePrivateFile, runSerialized, writeJsonFile } from "./fileStore.js";

const JOURNAL_FILE = () => getDataFile("attendance-transfer-journal.json");
const JOURNAL_LOCK = "attendance-transfer-journal";

export async function getAttendanceTransferJournal() {
  return readJsonFile(JOURNAL_FILE(), null);
}

// The journal is intentionally separate from the user-binding transaction: a
// crash between Sheets copy, binding commit, and source clear must leave a
// durable, operator-visible recovery record rather than silently guessing.
export async function beginAttendanceTransferJournal(fromAppointment, toAppointment) {
  return runSerialized(JOURNAL_LOCK, async () => {
    const existing = await getAttendanceTransferJournal();
    if (existing && (
      existing.fromAppointment !== fromAppointment ||
      existing.toAppointment !== toAppointment
    )) {
      throw new Error(
        `Another attendance transfer (${existing.fromAppointment} → ${existing.toAppointment}) requires recovery first.`
      );
    }
    if (existing) return existing;

    const journal = {
      version: 1,
      id: randomUUID(),
      fromAppointment,
      toAppointment,
      phase: "prepared",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await writeJsonFile(JOURNAL_FILE(), journal);
    return journal;
  });
}

export async function updateAttendanceTransferJournal(id, phase, details = {}) {
  return runSerialized(JOURNAL_LOCK, async () => {
    const current = await getAttendanceTransferJournal();
    if (!current || current.id !== id) {
      throw new Error("Attendance transfer journal is missing or was replaced.");
    }
    const next = { ...current, ...details, phase, updatedAt: new Date().toISOString() };
    await writeJsonFile(JOURNAL_FILE(), next);
    return next;
  });
}

export async function clearAttendanceTransferJournal(id) {
  return runSerialized(JOURNAL_LOCK, async () => {
    const current = await getAttendanceTransferJournal();
    if (current && current.id !== id) {
      throw new Error("Refusing to clear a different attendance transfer journal.");
    }
    return removePrivateFile(JOURNAL_FILE());
  });
}
