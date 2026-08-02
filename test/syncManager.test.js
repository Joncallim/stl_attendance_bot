import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createSyncManager } from "../src/syncManager.js";

test("sync manager serializes overlapping cycles and tracks timestamps", async () => {
  const calls = [];
  const syncManager = createSyncManager({
    flushQueue: async () => {
      calls.push("flush");
      await delay(25);
    },
    refreshOnboarding: async () => {
      calls.push("onboarding");
    },
    refreshAdminCache: async () => {
      calls.push("cache");
    },
    refreshMonthSlices: async () => {
      calls.push("months");
    }
  });

  await Promise.all([
    syncManager.runCycle({ force: true, reason: "five-minute" }),
    syncManager.runCycle({ force: true, reason: "five-minute" })
  ]);

  assert.deepEqual(calls, ["flush", "onboarding", "cache", "months"]);

  const status = syncManager.getStatus();
  assert.equal(status.cycleInProgress, false);
  assert.ok(status.lastQueueFlushAt > 0);
  assert.ok(status.lastOnboardingRefreshAt > 0);
  assert.ok(status.lastMonthRefreshAt > 0);
  assert.ok(status.lastFiveMinuteReconcileAt > 0);
});

test("queue flushes are batched by interval", async () => {
  let now = 1000;
  let flushCount = 0;
  const syncManager = createSyncManager({
    flushQueue: async () => { flushCount += 1; },
    flushQueueIntervalMs: 120_000,
    refreshAdminCache: async () => {},
    nowFn: () => now
  });

  await syncManager.runCycle();
  now += 60_000;
  await syncManager.runCycle();
  assert.equal(flushCount, 1);

  now += 60_000;
  await syncManager.runCycle();
  assert.equal(flushCount, 2);
});

test("queue depth threshold flushes before the interval", async () => {
  let now = 1000;
  let thresholdReached = false;
  let flushCount = 0;
  const syncManager = createSyncManager({
    flushQueue: async () => { flushCount += 1; },
    flushQueueIntervalMs: 120_000,
    shouldFlushQueue: async () => thresholdReached,
    refreshAdminCache: async () => {},
    nowFn: () => now
  });

  await syncManager.runCycle();
  now += 1000;
  thresholdReached = true;
  await syncManager.runCycle();

  assert.equal(flushCount, 2);
});

test("failed flush attempts remain interval-limited", async () => {
  let now = 1000;
  let flushCount = 0;
  const syncManager = createSyncManager({
    flushQueue: async () => {
      flushCount += 1;
      throw new Error("Sheets unavailable");
    },
    flushQueueIntervalMs: 120_000,
    refreshAdminCache: async () => {},
    nowFn: () => now
  });

  await assert.rejects(syncManager.runCycle(), /Sheets unavailable/);
  now += 1000;
  await syncManager.runCycle();

  assert.equal(flushCount, 1);
  assert.equal(syncManager.getStatus().lastQueueFlushAttemptAt, 1000);
  assert.equal(syncManager.getStatus().lastQueueFlushAt, 0);
});
