import { randomUUID } from "node:crypto";
import { getDataFile } from "./dataDir.js";
import { appendJsonLine, readJsonLines, runSerialized } from "./fileStore.js";

const QUEUE_MUTEX_KEY = "attendance-queue";
const ATTENDANCE_QUEUE_FILE = () => getDataFile("attendance-queue.ndjson");
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
        flushedAt: null,
        failedAt: null,
        lastError: null
      });
    }

    if (record.kind === "attendance_flushed") {
      const current = events.get(record.eventId);

      if (current) {
        current.flushedAt = record.flushedAt;
        current.failedAt = null;
        current.lastError = null;
      }
    }

    if (record.kind === "attendance_flush_failed") {
      const current = events.get(record.eventId);

      if (current) {
        current.failedAt = record.failedAt;
        current.lastError = record.error;
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
  return [...state.events.values()].filter((event) => !event.flushedAt);
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
      source: event.source ?? "daily"
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
      flushedAt: null,
      failedAt: null,
      lastError: null
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
      source: event.source ?? "weekly"
    }));

    for (const event of nextEvents) {
      await appendJsonLine(ATTENDANCE_QUEUE_FILE(), {
        kind: "attendance_enqueued",
        event
      });
      state.records.push({
        kind: "attendance_enqueued",
        event
      });
      state.events.set(event.id, {
        ...event,
        flushedAt: null,
        failedAt: null,
        lastError: null
      });
    }

    return nextEvents;
  });
}

export async function flushAttendanceQueue(writeEntries) {
  return runSerialized(QUEUE_MUTEX_KEY, async () => {
    const state = await loadAttendanceQueueState();
    const pendingEvents = [...state.events.values()]
      .filter((event) => !event.flushedAt)
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt.localeCompare(right.createdAt);
        }

        return left.id.localeCompare(right.id);
      });

    if (pendingEvents.length === 0) {
      return { flushedEvents: [], pendingEvents: [] };
    }

    const coalescedEntries = new Map();

    for (const event of pendingEvents) {
      coalescedEntries.set(`${event.appointment}:${event.date}`, event);
    }

    const finalEvents = [...coalescedEntries.values()];

    try {
      await writeEntries(
        finalEvents.map((event) => ({
          appointment: event.appointment,
          status: event.status,
          date: new Date(`${event.date}T12:00:00.000Z`)
        }))
      );

      const flushedAt = new Date().toISOString();

      for (const event of pendingEvents) {
        await appendJsonLine(ATTENDANCE_QUEUE_FILE(), {
          kind: "attendance_flushed",
          eventId: event.id,
          flushedAt
        });
        state.records.push({
          kind: "attendance_flushed",
          eventId: event.id,
          flushedAt
        });
        const current = state.events.get(event.id);

        if (current) {
          current.flushedAt = flushedAt;
          current.failedAt = null;
          current.lastError = null;
        }
      }

      return { flushedEvents: finalEvents, pendingEvents: [] };
    } catch (error) {
      const failedAt = new Date().toISOString();

      for (const event of pendingEvents) {
        await appendJsonLine(ATTENDANCE_QUEUE_FILE(), {
          kind: "attendance_flush_failed",
          eventId: event.id,
          failedAt,
          error: error.message
        });
        state.records.push({
          kind: "attendance_flush_failed",
          eventId: event.id,
          failedAt,
          error: error.message
        });
        const current = state.events.get(event.id);

        if (current) {
          current.failedAt = failedAt;
          current.lastError = error.message;
        }
      }

      throw error;
    }
  });
}
