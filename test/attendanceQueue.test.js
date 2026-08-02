import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  ATTENDANCE_QUEUE_FLUSH_INTERVAL_MS,
  ATTENDANCE_QUEUE_FLUSH_THRESHOLD,
  enqueueAttendanceEvent,
  enqueueAttendanceEvents,
  flushAttendanceQueue,
  getAttendanceQueueStatus,
  listPendingAttendanceEvents,
  loadAttendanceQueueState
} from "../src/attendanceQueue.js";

test("attendance queue batching defaults are two minutes and 25 entries", () => {
  assert.equal(ATTENDANCE_QUEUE_FLUSH_INTERVAL_MS, 120_000);
  assert.equal(ATTENDANCE_QUEUE_FLUSH_THRESHOLD, 25);
});

async function withTempDataDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "attendance-queue-"));
  process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;

  try {
    await run(tempDir);
  } finally {
    delete process.env.ATTENDANCE_BOT_DATA_DIR;
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("attendance queue survives reload and flush coalesces last write wins", async () => {
  await withTempDataDir(async () => {
    const config = { timezone: "Asia/Singapore" };
    await enqueueAttendanceEvent(config, {
      appointment: "ALPHA",
      status: "PRESENT",
      date: new Date("2026-03-24T00:00:00.000Z"),
      source: "daily"
    });
    await enqueueAttendanceEvent(config, {
      appointment: "ALPHA",
      status: "WFH",
      date: new Date("2026-03-24T00:00:00.000Z"),
      source: "daily"
    });

    const queueState = await loadAttendanceQueueState();
    assert.equal(queueState.events.size, 2);

    const flushed = [];
    const result = await flushAttendanceQueue(async (entries) => {
      flushed.push(...entries);
    });

    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].status, "WFH");
    assert.equal(result.flushedEvents.length, 1);

    const pending = await listPendingAttendanceEvents();
    assert.equal(pending.length, 0);
  });
});

test("attendance queue deduplicates a retried interaction idempotency key", async () => {
  await withTempDataDir(async () => {
    const config = { timezone: "Asia/Singapore" };
    const event = {
      appointment: "ALPHA",
      status: "PRESENT",
      date: new Date("2026-03-24T00:00:00.000Z"),
      source: "department",
      idempotencyKey: "department:menu-1:ALPHA:2026-03-24"
    };

    const [first, second] = await Promise.all([
      enqueueAttendanceEvent(config, event),
      enqueueAttendanceEvent(config, event)
    ]);

    assert.equal(first.id, second.id);
    const state = await loadAttendanceQueueState();
    assert.equal(state.events.size, 1);
  });
});

test("attendance queue deduplicates repeated keys inside one batch", async () => {
  await withTempDataDir(async () => {
    const config = { timezone: "Asia/Singapore" };
    const event = {
      appointment: "ALPHA",
      status: "PRESENT",
      date: new Date("2026-03-24T00:00:00.000Z"),
      source: "weekly",
      idempotencyKey: "weekly:flow-1:ALPHA:2026-03-24"
    };

    const [first, second] = await enqueueAttendanceEvents(config, [event, event]);

    assert.equal(first.id, second.id);
    const state = await loadAttendanceQueueState();
    assert.equal(state.events.size, 1);
  });
});

test("attendance queue keeps events pending after a failed flush", async () => {
  await withTempDataDir(async () => {
    const config = { timezone: "Asia/Singapore" };
    await enqueueAttendanceEvent(config, {
      appointment: "BRAVO",
      status: "PRESENT",
      date: new Date("2026-03-24T00:00:00.000Z"),
      source: "daily"
    });

    await assert.rejects(
      flushAttendanceQueue(async () => {
        throw new Error("boom");
      }),
      /boom/
    );

    const pending = await listPendingAttendanceEvents();
    assert.equal(pending.length, 0);
    const queueState = await loadAttendanceQueueState();
    const retryableEvent = [...queueState.events.values()][0];
    assert.equal(retryableEvent.appointment, "BRAVO");
    assert.equal(retryableEvent.queueStatus, "failed_retryable");
    const status = await getAttendanceQueueStatus();
    assert.equal(status.queueDepth, 1);
    assert.ok(status.nextRetryAt);
  });
});
