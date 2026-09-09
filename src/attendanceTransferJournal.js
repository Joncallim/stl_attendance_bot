/*
 * Appointment transfers span several durable systems: Sheets attendance,
 * Telegram/user bindings, and the local appointment registry. Those writes
 * cannot be committed atomically as one transaction.
 *
 * This journal is the crash boundary. A transfer writes `prepared` before the
 * dangerous work starts, advances the recorded phase as each durable step
 * completes, and removes the journal only after the transfer is fully settled.
 * If the process dies halfway through, startup/recovery code has a concrete
 * record of what was intended and must not infer completion from partial state.
 *
 * Only one transfer journal may exist at a time. Starting a second transfer
 * while one is unresolved would make recovery ambiguous, so it is rejected.
 */

import { randomUUID } from "node:crypto";
import { getDataFile } from "./dataDir.js";
import { readJsonFile, removePrivateFile, runSerialized, writeJsonFile } from "./fileStore.js";

const JOURNAL_FILE = () => getDataFile("attendance-transfer-journal.json");
const JOURNAL_LOCK = "attendance-transfer-journal";

/** Read the current transfer recovery record, or null when no transfer is open. */
export async function getAttendanceTransferJournal() {
  return readJsonFile(JOURNAL_FILE(), null);
}

/**
 * Open a transfer journal before any cross-store mutation occurs.
 * `expectedFromBindingIdentity` lets recovery verify that the source binding is
 * still the one that was inspected when the transfer began.
 */
export async function beginAttendanceTransferJournal(
  fromAppointment,
  toAppointment,
  details = {}
) {
  return runSerialized(JOURNAL_LOCK, async () => {
    const existing = await getAttendanceTransferJournal();
    if (existing) {
      throw new Error(
        `Attendance transfer recovery is required for ${existing.fromAppointment} → ${existing.toAppointment} (phase: ${existing.phase}).`
      );
    }

    const journal = {
      version: 1,
      id: randomUUID(),
      fromAppointment,
      toAppointment,
      expectedFromBindingIdentity: details.expectedFromBindingIdentity ?? null,
      phase: "prepared",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await writeJsonFile(JOURNAL_FILE(), journal);
    return journal;
  });
}

/**
 * Advance the journal after a durable transfer step completes. The id check is
 * deliberate: stale recovery code must never advance a newer transfer record.
 */
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

/**
 * Remove a completed journal. Refuse to clear a different journal so cleanup
 * from an old operation cannot erase the recovery record for a newer one.
 */
export async function clearAttendanceTransferJournal(id) {
  return runSerialized(JOURNAL_LOCK, async () => {
    const current = await getAttendanceTransferJournal();
    if (current && current.id !== id) {
      throw new Error("Refusing to clear a different attendance transfer journal.");
    }
    return removePrivateFile(JOURNAL_FILE());
  });
}
