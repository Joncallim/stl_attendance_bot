import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  compactAttendanceQueue,
  enqueueAttendanceEvent,
  enqueueAttendanceEvents,
  flushAttendanceQueue,
  getAttendanceQueueStatus,
  listPendingAttendanceEvents,
  loadAttendanceQueueState,
  resetConflictedQueueEntries
} from "../src/attendanceQueue.js";

const CONFIG = { timezone: "Asia/Singapore" };

async function withTempDataDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aq-resilience-"));
  process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;
  try {
    await run(tempDir);
  } finally {
    delete process.env.ATTENDANCE_BOT_DATA_DIR;
    await rm(tempDir, { recursive: true, force: true });
  }
}

function makeEvent(appointment, status, dayOffset = 0) {
  const d = new Date("2026-03-10T12:00:00.000Z");
  d.setDate(d.getDate() + dayOffset);
  return { appointment, status, date: d, source: "daily" };
}

// ── Retry backoff ──────────────────────────────────────────────────────────────

test("retry delay doubles until the 15-minute cap", async () => {
  await withTempDataDir(async () => {
    await enqueueAttendanceEvent(CONFIG, makeEvent("ALPHA", "PRESENT"));

    const delays = [];

    for (let i = 1; i <= 12; i++) {
      // Clear nextRetryAt to simulate time passing between retries
      const state = await loadAttendanceQueueState();
      for (const ev of state.events.values()) {
        ev.nextRetryAt = null;
      }

      const before = Date.now();
      try {
        await flushAttendanceQueue(async () => { throw new Error("outage"); });
      } catch { /* expected */ }
      const freshState = await loadAttendanceQueueState();
      const event = [...freshState.events.values()].find((e) => e.appointment === "ALPHA");
      if (event?.nextRetryAt) {
        const delayMs = new Date(event.nextRetryAt).getTime() - before;
        delays.push(delayMs);
      }
    }

    // First retry should be ~2s (2^1)
    assert.ok(delays[0] < 3500, `retry 1 delay should be ~2s, got ${delays[0]}ms`);

    // After retry 10, delay should be at the 15-min cap (clamped exponent = 10 → 2^10=1024s > 900s)
    const lateDelay = delays[delays.length - 1];
    assert.ok(lateDelay >= 14 * 60 * 1000, `late retry should be near 15 min, got ${lateDelay}ms`);
    assert.ok(lateDelay <= 15 * 60 * 1000 + 500, `late retry should not exceed 15 min cap+jitter, got ${lateDelay}ms`);
  });
});

// ── Permanent-fail transition ─────────────────────────────────────────────────

test("event permanently fails after MAX_RETRY_COUNT consecutive failures", async () => {
  await withTempDataDir(async () => {
    // Seed an event with retryCount just below the limit so we don't have
    // to run 20 flush loops; instead pre-set retryCount via multiple failures.
    await enqueueAttendanceEvent(CONFIG, makeEvent("BRAVO", "WFH"));

    const MAX = 20;

    // Drive the event to retryCount = MAX by injecting failures directly.
    // Bypass the nextRetryAt gate by resetting it in the in-memory state each loop.
    for (let i = 0; i < MAX; i++) {
      const state = await loadAttendanceQueueState();
      for (const ev of state.events.values()) {
        ev.nextRetryAt = null; // clear backoff so next flush picks it up
      }
      try {
        await flushAttendanceQueue(async () => { throw new Error("still down"); });
      } catch { /* expected until exhausted */ }
    }

    const status = await getAttendanceQueueStatus();
    assert.equal(status.queueDepth, 0, "permanently failed event should leave the retry queue");
    assert.equal(status.permanentlyFailedCount, 1, "should report 1 permanently failed event");

    const state = await loadAttendanceQueueState();
    const event = [...state.events.values()].find((e) => e.appointment === "BRAVO");
    assert.equal(event?.queueStatus, "failed_permanent");
    assert.ok(event?.lastError);

    const pending = await listPendingAttendanceEvents();
    assert.equal(pending.length, 0, "permanently failed events are not listed as pending");
  });
});

// ── Mix: some exhaust, some survive ──────────────────────────────────────────

test("only exhausted events become failed_permanent; retryable events stay in queue", async () => {
  await withTempDataDir(async () => {
    await enqueueAttendanceEvent(CONFIG, makeEvent("C1", "PRESENT", 0));
    await enqueueAttendanceEvent(CONFIG, makeEvent("C2", "DUTY", 1));

    // Manually set C1 to retryCount 20 to trigger exhaustion on next failure.
    // C2 stays at retryCount 0.
    const state = await loadAttendanceQueueState();
    for (const ev of state.events.values()) {
      ev.nextRetryAt = null;
      if (ev.appointment === "C1") ev.retryCount = 20;
    }

    try {
      await flushAttendanceQueue(async () => { throw new Error("boom"); });
    } catch { /* expected */ }

    const status = await getAttendanceQueueStatus();
    assert.equal(status.permanentlyFailedCount, 1, "C1 should be permanently failed");
    assert.equal(status.queueDepth, 1, "C2 should still be in retry queue");
  });
});

// ── Compaction ────────────────────────────────────────────────────────────────

test("compactAttendanceQueue drops flushed records but retains failed_permanent attendance", async () => {
  await withTempDataDir(async () => {
    // Enqueue two events
    await enqueueAttendanceEvent(CONFIG, makeEvent("D1", "PRESENT", 0));
    await enqueueAttendanceEvent(CONFIG, makeEvent("D2", "MC", 1));

    // Flush D1 successfully, leaving D2 unresolved.
    await flushAttendanceQueue(async (entries) => ({
      writtenEventIds: entries
        .filter((event) => event.appointment === "D1")
        .map((event) => event.id),
      skippedEvents: [],
      conflictedEvents: []
    }));

    // Exhaust D2 by pre-setting high retryCount
    const state = await loadAttendanceQueueState();
    const d2 = [...state.events.values()].find((e) => e.appointment === "D2");
    if (d2) {
      d2.retryCount = 20;
      d2.nextRetryAt = null;
    }
    try {
      await flushAttendanceQueue(async () => { throw new Error("gone"); });
    } catch { /* expected */ }

    const beforeCompact = await loadAttendanceQueueState();
    assert.ok(beforeCompact.records.length > 2, "records should accumulate before compaction");

    const result = await compactAttendanceQueue();
    assert.equal(result.compacted, true);
    assert.ok(result.removedCount > 0);

    const afterCompact = await loadAttendanceQueueState();
    assert.equal(afterCompact.events.size, 1);
    const retained = [...afterCompact.events.values()][0];
    assert.equal(retained.appointment, "D2");
    assert.equal(retained.queueStatus, "failed_permanent");
    assert.ok(afterCompact.records.length > 0, "failed attendance must remain recoverable");
  });
});

test("compactAttendanceQueue preserves pending events and their records", async () => {
  await withTempDataDir(async () => {
    await enqueueAttendanceEvent(CONFIG, makeEvent("E1", "PRESENT", 0));
    await enqueueAttendanceEvent(CONFIG, makeEvent("E2", "WFH", 1));

    // Flush E1 (resolved), leave E2 pending
    await flushAttendanceQueue(async (entries) => {
      const e1 = entries.find((e) => e.appointment === "E1");
      return {
        writtenEventIds: e1 ? [e1.id] : [],
        skippedEvents: [],
        conflictedEvents: []
      };
    });

    const result = await compactAttendanceQueue();
    assert.equal(result.compacted, true);

    const state = await loadAttendanceQueueState();
    assert.equal(state.events.size, 1, "pending E2 should remain");
    const e2 = [...state.events.values()][0];
    assert.equal(e2.appointment, "E2");
    assert.equal(e2.queueStatus, "pending");
  });
});

// ── Conflict reset ────────────────────────────────────────────────────────────

test("resetConflictedQueueEntries transitions conflicted events back to pending", async () => {
  await withTempDataDir(async () => {
    await enqueueAttendanceEvent(CONFIG, makeEvent("F1", "PRESENT"));

    // Simulate a conflict outcome from flush
    await flushAttendanceQueue(async (entries) => ({
      writtenEventIds: [],
      skippedEvents: [],
      conflictedEvents: entries.map((e) => ({
        eventId: e.id,
        reason: "appointment_missing"
      }))
    }));

    const beforeReset = await getAttendanceQueueStatus();
    assert.equal(beforeReset.conflictedCount, 1);
    assert.equal(beforeReset.queueDepth, 0);

    const result = await resetConflictedQueueEntries();
    assert.equal(result.resetCount, 1);

    const afterReset = await getAttendanceQueueStatus();
    assert.equal(afterReset.conflictedCount, 0);
    assert.equal(afterReset.queueDepth, 1, "reset events should be back in the retry queue");
  });
});

// ── Batch enqueue coalescing ──────────────────────────────────────────────────

test("enqueueAttendanceEvents then flush writes last-write-wins across 10 events", async () => {
  await withTempDataDir(async () => {
    const base = new Date("2026-03-10T12:00:00.000Z");
    const events = Array.from({ length: 10 }, (_, i) => ({
      appointment: "GOLF",
      status: i % 2 === 0 ? "PRESENT" : "WFH",
      date: base,
      source: "weekly"
    }));

    await enqueueAttendanceEvents(CONFIG, events);

    const state = await loadAttendanceQueueState();
    assert.equal(state.events.size, 10, "all 10 events should be in state");

    const flushed = [];
    await flushAttendanceQueue(async (entries) => {
      flushed.push(...entries);
    });

    assert.equal(flushed.length, 1, "should coalesce to 1 entry (last write wins)");
    assert.equal(flushed[0].status, "WFH", "last status in the batch should win");

    const pending = await listPendingAttendanceEvents();
    assert.equal(pending.length, 0);
  });
});

test("new attendance can be enqueued while a remote flush is still running", async () => {
  await withTempDataDir(async () => {
    await enqueueAttendanceEvent(CONFIG, makeEvent("HOTEL", "PRESENT"));

    let releaseRemoteWrite;
    let signalRemoteWriteStarted;
    const remoteWriteStarted = new Promise((resolve) => {
      signalRemoteWriteStarted = resolve;
    });
    const remoteWriteGate = new Promise((resolve) => {
      releaseRemoteWrite = resolve;
    });

    const flushPromise = flushAttendanceQueue(async (entries) => {
      signalRemoteWriteStarted();
      await remoteWriteGate;
      return {
        writtenEventIds: entries.map((entry) => entry.id),
        skippedEvents: [],
        conflictedEvents: []
      };
    });

    await remoteWriteStarted;

    try {
      let enqueueTimeout;
      const enqueued = await Promise.race([
        enqueueAttendanceEvent(CONFIG, makeEvent("INDIA", "WFH")),
        new Promise((_, reject) => {
          enqueueTimeout = setTimeout(
            () => reject(new Error("enqueue was blocked by the remote flush")),
            500
          );
        })
      ]);
      clearTimeout(enqueueTimeout);

      assert.equal(enqueued.appointment, "INDIA");
    } finally {
      releaseRemoteWrite();
    }

    await flushPromise;

    const pending = await listPendingAttendanceEvents();
    assert.deepEqual(
      pending.map((event) => event.appointment),
      ["INDIA"],
      "the event added during the flush must remain pending for the next cycle"
    );
  });
});
