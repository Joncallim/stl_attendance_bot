import { randomUUID } from "node:crypto";
import { getDataFile } from "./dataDir.js";
import { appendJsonLine, appendJsonLines, readJsonLines, runSerialized, writeJsonLines } from "./fileStore.js";

const QUEUE_MUTEX_KEY = "attendance-queue";
const QUEUE_FLUSH_MUTEX_KEY = "attendance-queue-flush";
const ATTENDANCE_QUEUE_FILE = () => getDataFile("attendance-queue.ndjson");
// After this many consecutive flush failures an event is marked failed_permanent
// and will no longer be retried. The retry delay formula caps at 15 minutes
// (exponent clamped at 10, giving 2^10 ≈ 17 min → capped to 15 min). After the
// backoff saturates (~retry 10, ~34 min total), each further retry adds ~15 min.
// 20 retries gives roughly 3 hours of coverage during a Sheets outage.
const MAX_RETRY_COUNT = 20;
let cachedQueueState = null;
let cachedQueueFilePath = null;
let queueStateLoadPromise = null;

function toEventDateString(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function createQueueState(records) {
  const events = new Map();

  for (const record of records) {
    if (record.kind === "attendance_enqueued") {
      events.set(record.event.id, {
        ...record.event,
        queueStatus: "pending",
        flushedAt: null,
        failedAt: null,
        lastError: null,
        conflictReason: null,
        retryCount: 0,
        nextRetryAt: null
      });
    }

    if (record.kind === "attendance_flushed") {
      const current = events.get(record.eventId);

      if (current) {
        current.queueStatus = "flushed";
        current.flushedAt = record.flushedAt;
        current.failedAt = null;
        current.lastError = null;
        current.conflictReason = null;
        current.nextRetryAt = null;
      }
    }

    if (record.kind === "attendance_flush_failed") {
      const current = events.get(record.eventId);

      if (current) {
        current.queueStatus = "failed_retryable";
        current.failedAt = record.failedAt;
        current.lastError = record.error;
        current.retryCount = Number(record.retryCount ?? current.retryCount ?? 0);
        current.nextRetryAt = record.nextRetryAt ?? null;
      }
    }

    if (record.kind === "attendance_conflicted") {
      const current = events.get(record.eventId);

      if (current) {
        current.queueStatus = "conflicted";
        current.conflictReason = record.reason ?? "sheet_layout_changed";
        current.lastError = record.error ?? null;
        current.nextRetryAt = null;
      }
    }

    if (record.kind === "attendance_skipped") {
      const current = events.get(record.eventId);

      if (current) {
        current.queueStatus = "skipped_noop";
        current.flushedAt = record.skippedAt ?? null;
        current.failedAt = null;
        current.lastError = null;
        current.conflictReason = null;
        current.nextRetryAt = null;
      }
    }

    if (record.kind === "attendance_conflict_reset") {
      const current = events.get(record.eventId);

      if (current && current.queueStatus === "conflicted") {
        current.queueStatus = "pending";
        current.conflictReason = null;
        current.lastError = null;
        current.nextRetryAt = null;
      }
    }

    if (record.kind === "attendance_exhausted") {
      const current = events.get(record.eventId);

      if (current) {
        current.queueStatus = "failed_permanent";
        current.failedAt = record.failedAt;
        current.lastError = record.error;
        current.retryCount = Number(record.retryCount ?? current.retryCount ?? 0);
        current.nextRetryAt = null;
      }
    }
  }

  return {
    events,
    records
  };
}

export async function loadAttendanceQueueState() {
  const queueFilePath = ATTENDANCE_QUEUE_FILE();

  if (cachedQueueFilePath !== queueFilePath) {
    cachedQueueState = null;
    cachedQueueFilePath = queueFilePath;
    queueStateLoadPromise = null;
  }

  if (cachedQueueState) {
    return cachedQueueState;
  }

  if (!queueStateLoadPromise) {
    queueStateLoadPromise = readJsonLines(queueFilePath)
      .then((records) => {
        cachedQueueState = createQueueState(records);
        return cachedQueueState;
      })
      .finally(() => {
        queueStateLoadPromise = null;
      });
  }

  return queueStateLoadPromise;
}

export async function listPendingAttendanceEvents() {
  const state = await loadAttendanceQueueState();
  const now = Date.now();
  return [...state.events.values()].filter((event) =>
    (event.queueStatus === "pending" || event.queueStatus === "failed_retryable") &&
    (!event.nextRetryAt || new Date(event.nextRetryAt).getTime() <= now)
  );
}

export async function enqueueAttendanceEvent(config, event) {
  return runSerialized(QUEUE_MUTEX_KEY, async () => {
    const state = await loadAttendanceQueueState();
    const nextEvent = {
      id: randomUUID(),
      type: "attendance_status",
      appointment: event.appointment,
      status: event.status,
      date: toEventDateString(event.date ?? new Date(), config.timezone),
      createdAt: new Date().toISOString(),
      source: event.source ?? "daily",
      targetSheetTitle: event.targetSheetTitle ?? null,
      expectedPreviousValue: event.expectedPreviousValue ?? "",
      expectedAppointment: event.expectedAppointment ?? event.appointment,
      expectedDateLabel: event.expectedDateLabel ?? null,
      baseCacheTimestamp: event.baseCacheTimestamp ?? null
    };

    await appendJsonLine(ATTENDANCE_QUEUE_FILE(), {
      kind: "attendance_enqueued",
      event: nextEvent
    });
    state.records.push({
      kind: "attendance_enqueued",
      event: nextEvent
    });
    state.events.set(nextEvent.id, {
      ...nextEvent,
      queueStatus: "pending",
      flushedAt: null,
      failedAt: null,
      lastError: null,
      conflictReason: null,
      retryCount: 0,
      nextRetryAt: null
    });

    return nextEvent;
  });
}

export async function enqueueAttendanceEvents(config, events) {
  return runSerialized(QUEUE_MUTEX_KEY, async () => {
    const state = await loadAttendanceQueueState();
    const nextEvents = events.map((event) => ({
      id: randomUUID(),
      type: "attendance_status",
      appointment: event.appointment,
      status: event.status,
      date: toEventDateString(event.date ?? new Date(), config.timezone),
      createdAt: new Date().toISOString(),
      source: event.source ?? "weekly",
      targetSheetTitle: event.targetSheetTitle ?? null,
      expectedPreviousValue: event.expectedPreviousValue ?? "",
      expectedAppointment: event.expectedAppointment ?? event.appointment,
      expectedDateLabel: event.expectedDateLabel ?? null,
      baseCacheTimestamp: event.baseCacheTimestamp ?? null
    }));

    const enqueueRecords = nextEvents.map((event) => ({ kind: "attendance_enqueued", event }));
    await appendJsonLines(ATTENDANCE_QUEUE_FILE(), enqueueRecords);

    for (const event of nextEvents) {
      state.records.push({ kind: "attendance_enqueued", event });
      state.events.set(event.id, {
        ...event,
        queueStatus: "pending",
        flushedAt: null,
        failedAt: null,
        lastError: null,
        conflictReason: null,
        retryCount: 0,
        nextRetryAt: null
      });
    }

    return nextEvents;
  });
}

export async function flushAttendanceQueue(writeEntries) {
  // Keep remote writes serialized, but only hold the queue mutex while taking
  // the pending snapshot and committing bookkeeping. Google Sheets calls can
  // take many seconds; holding the local mutex across that await made every
  // simultaneous Telegram submission wait behind the network.
  return runSerialized(QUEUE_FLUSH_MUTEX_KEY, async () => {
    const { pendingEvents, eventGroups, finalEvents } = await runSerialized(
      QUEUE_MUTEX_KEY,
      async () => {
        const state = await loadAttendanceQueueState();
        const now = Date.now();
        const pendingEvents = [...state.events.values()]
          .filter((event) =>
            (event.queueStatus === "pending" || event.queueStatus === "failed_retryable") &&
            (!event.nextRetryAt || new Date(event.nextRetryAt).getTime() <= now)
          )
          .sort((left, right) => {
            if (left.createdAt !== right.createdAt) {
              return left.createdAt.localeCompare(right.createdAt);
            }

            // Array#sort is stable in supported Node versions. Preserve the
            // NDJSON/Map insertion order when a burst shares one millisecond;
            // sorting random UUIDs here broke last-write-wins batch ordering.
            return 0;
          });

        const coalescedEntries = new Map();
        const eventGroups = new Map();

        for (const event of pendingEvents) {
          const key = `${event.appointment}:${event.date}`;
          coalescedEntries.set(key, event);

          if (!eventGroups.has(key)) {
            eventGroups.set(key, []);
          }

          eventGroups.get(key).push(event);
        }

        return {
          pendingEvents,
          eventGroups,
          finalEvents: [...coalescedEntries.values()]
        };
      }
    );

    if (pendingEvents.length === 0) {
      return { flushedEvents: [], pendingEvents: [] };
    }

    console.log(
      `[Queue] Flushing ${pendingEvents.length} pending event(s) → ` +
      `${finalEvents.length} coalesced (last-write-wins per appointment+date).`
    );

    try {
      const outcome = await writeEntries(
        finalEvents.map((event) => ({
          ...event,
          date: new Date(`${event.date}T12:00:00.000Z`)
        }))
      );
      const writtenEventIds = new Set(
        Array.isArray(outcome?.writtenEventIds)
          ? outcome.writtenEventIds
          : finalEvents.map((event) => event.id)
      );
      const skippedEvents = Array.isArray(outcome?.skippedEvents) ? outcome.skippedEvents : [];
      const conflictedEvents = Array.isArray(outcome?.conflictedEvents) ? outcome.conflictedEvents : [];

      const flushedAt = new Date().toISOString();

      await runSerialized(QUEUE_MUTEX_KEY, async () => {
        const state = await loadAttendanceQueueState();
        // Collect all bookkeeping records, then write them in one batch append.
        const bookkeepingRecords = [];

        for (const event of finalEvents) {
          if (!writtenEventIds.has(event.id)) {
            continue;
          }

          const groupedEvents = eventGroups.get(`${event.appointment}:${event.date}`) ?? [event];

          for (const groupedEvent of groupedEvents) {
            const record = { kind: "attendance_flushed", eventId: groupedEvent.id, flushedAt };
            bookkeepingRecords.push(record);
            state.records.push(record);
            const current = state.events.get(groupedEvent.id);

            if (current) {
              current.queueStatus = "flushed";
              current.flushedAt = flushedAt;
              current.failedAt = null;
              current.lastError = null;
              current.conflictReason = null;
              current.nextRetryAt = null;
            }
          }
        }

        for (const skippedEvent of skippedEvents) {
          const sourceEvent = state.events.get(skippedEvent.eventId);
          const groupedEvents = sourceEvent
            ? eventGroups.get(`${sourceEvent.appointment}:${sourceEvent.date}`) ?? [sourceEvent]
            : [];

          for (const groupedEvent of groupedEvents) {
            const record = {
              kind: "attendance_skipped",
              eventId: groupedEvent.id,
              skippedAt: flushedAt,
              reason: skippedEvent.reason ?? "noop"
            };
            bookkeepingRecords.push(record);
            state.records.push(record);
            const current = state.events.get(groupedEvent.id);

            if (current) {
              current.queueStatus = "skipped_noop";
              current.flushedAt = flushedAt;
              current.failedAt = null;
              current.lastError = null;
              current.conflictReason = null;
              current.nextRetryAt = null;
            }
          }
        }

        for (const conflictedEvent of conflictedEvents) {
          const sourceEvent = state.events.get(conflictedEvent.eventId);
          const groupedEvents = sourceEvent
            ? eventGroups.get(`${sourceEvent.appointment}:${sourceEvent.date}`) ?? [sourceEvent]
            : [];

          for (const groupedEvent of groupedEvents) {
            const record = {
              kind: "attendance_conflicted",
              eventId: groupedEvent.id,
              conflictedAt: flushedAt,
              reason: conflictedEvent.reason ?? "sheet_layout_changed",
              error: conflictedEvent.error ?? null
            };
            bookkeepingRecords.push(record);
            state.records.push(record);
            const current = state.events.get(groupedEvent.id);

            if (current) {
              current.queueStatus = "conflicted";
              current.conflictReason = conflictedEvent.reason ?? "sheet_layout_changed";
              current.lastError = conflictedEvent.error ?? null;
              current.nextRetryAt = null;
            }
          }
        }

        await appendJsonLines(ATTENDANCE_QUEUE_FILE(), bookkeepingRecords);
      });

      const writtenCount = outcome?.writtenEventIds?.length ?? finalEvents.length;
      const skippedCount = outcome?.skippedEvents?.length ?? 0;
      const conflictedCount = outcome?.conflictedEvents?.length ?? 0;
      console.log(
        `[Queue] Flush complete: ${writtenCount} written, ${skippedCount} skipped, ` +
        `${conflictedCount} conflicted.` +
        (conflictedCount > 0 ? " Run Sync Roster to fix layout mismatch." : "")
      );

      return { flushedEvents: finalEvents, pendingEvents: [], outcome };
    } catch (error) {
      const failedAt = new Date().toISOString();
      const retryableCount = await runSerialized(QUEUE_MUTEX_KEY, async () => {
        const state = await loadAttendanceQueueState();
        const bookkeepingRecords = [];
        const exhaustedIds = [];

        for (const event of pendingEvents) {
          const current = state.events.get(event.id);
          const nextRetryCount = Number(current?.retryCount ?? event.retryCount ?? 0) + 1;

          if (nextRetryCount >= MAX_RETRY_COUNT) {
            console.error(
              `[Queue] Event ${event.id} permanently failed after ${nextRetryCount - 1} attempts ` +
              `(appointment=${event.appointment} date=${event.date}): ${error.message}`
            );
            const record = {
              kind: "attendance_exhausted",
              eventId: event.id,
              failedAt,
              error: error.message,
              retryCount: nextRetryCount
            };
            bookkeepingRecords.push(record);
            exhaustedIds.push(event.id);
            state.records.push(record);

            if (current) {
              current.queueStatus = "failed_permanent";
              current.failedAt = failedAt;
              current.lastError = error.message;
              current.retryCount = nextRetryCount;
              current.nextRetryAt = null;
            }
          } else {
            const nextRetryAt = new Date(
              Date.now() + Math.min(15 * 60 * 1000, 1000 * (2 ** Math.min(nextRetryCount, 10))) + Math.floor(Math.random() * 250)
            ).toISOString();
            const record = {
              kind: "attendance_flush_failed",
              eventId: event.id,
              failedAt,
              error: error.message,
              retryCount: nextRetryCount,
              nextRetryAt
            };
            bookkeepingRecords.push(record);
            state.records.push(record);

            if (current) {
              current.queueStatus = "failed_retryable";
              current.failedAt = failedAt;
              current.lastError = error.message;
              current.retryCount = nextRetryCount;
              current.nextRetryAt = nextRetryAt;
            }
          }
        }

        await appendJsonLines(ATTENDANCE_QUEUE_FILE(), bookkeepingRecords);
        return pendingEvents.length - exhaustedIds.length;
      });

      if (retryableCount > 0) {
        console.error(
          `[Queue] Flush failed (${retryableCount} event(s) will retry): ${error.message}`
        );
      }

      throw error;
    }
  });
}

export async function getAttendanceQueueStatus() {
  const state = await loadAttendanceQueueState();
  const events = [...state.events.values()];
  const pending = events.filter((event) => event.queueStatus === "pending" || event.queueStatus === "failed_retryable");
  const conflicted = events.filter((event) => event.queueStatus === "conflicted");
  const permanentlyFailed = events.filter((event) => event.queueStatus === "failed_permanent");
  const nextRetryAt = pending
    .map((event) => event.nextRetryAt)
    .filter(Boolean)
    .sort()[0] ?? null;

  return {
    queueDepth: pending.length,
    conflictedCount: conflicted.length,
    permanentlyFailedCount: permanentlyFailed.length,
    nextRetryAt
  };
}

/**
 * Resets all conflicted queue entries back to pending so they will be retried
 * on the next flush cycle. Should be called after a structural sheet sync that
 * fixes the layout mismatch that caused the conflicts.
 */
export async function resetConflictedQueueEntries() {
  return runSerialized(QUEUE_MUTEX_KEY, async () => {
    const state = await loadAttendanceQueueState();
    const conflicted = [...state.events.values()].filter(
      (event) => event.queueStatus === "conflicted"
    );

    if (conflicted.length === 0) {
      return { resetCount: 0 };
    }

    const resetAt = new Date().toISOString();

    await appendJsonLines(
      ATTENDANCE_QUEUE_FILE(),
      conflicted.map((event) => ({ kind: "attendance_conflict_reset", eventId: event.id, resetAt }))
    );

    for (const event of conflicted) {
      event.queueStatus = "pending";
      event.conflictReason = null;
      event.lastError = null;
      event.nextRetryAt = null;
    }

    return { resetCount: conflicted.length };
  });
}

// Rewrites the queue file keeping every unresolved event. Conflicted and
// permanently-failed events are deliberately retained until an administrator
// repairs or explicitly resolves them; compaction must never destroy attendance.
export async function compactAttendanceQueue() {
  return runSerialized(QUEUE_MUTEX_KEY, async () => {
    const state = await loadAttendanceQueueState();
    const activeIds = new Set(
      [...state.events.values()]
        .filter((event) => !["flushed", "skipped"].includes(event.queueStatus))
        .map((event) => event.id)
    );

    if (activeIds.size === state.events.size) {
      return { compacted: false, removedCount: 0 };
    }

    const retainedRecords = state.records.filter((record) => {
      const eventId = record.event?.id ?? record.eventId;
      return activeIds.has(eventId);
    });

    await writeJsonLines(ATTENDANCE_QUEUE_FILE(), retainedRecords);

    const removedCount = state.records.length - retainedRecords.length;
    cachedQueueState = createQueueState(retainedRecords);
    cachedQueueState.records = retainedRecords;

    return { compacted: true, removedCount };
  });
}
