import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  enqueueAttendanceEvent,
  flushAttendanceQueue,
  listPendingAttendanceEvents,
  loadAttendanceQueueState
} from "../src/attendanceQueue.js";

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
    assert.equal(pending.length, 1);
    assert.equal(pending[0].appointment, "BRAVO");
  });
});
