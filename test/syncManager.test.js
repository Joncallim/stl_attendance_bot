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
    syncRoster: async () => {
      calls.push("roster");
    },
    refreshAdminCache: async () => {
      calls.push("cache");
    },
    preloadSnapshots: async () => {
      calls.push("snapshot");
    }
  });

  await Promise.all([
    syncManager.runCycle({ force: true }),
    syncManager.runCycle({ force: true })
  ]);

  assert.deepEqual(calls, ["flush", "roster", "cache", "snapshot"]);

  const status = syncManager.getStatus();
  assert.equal(status.cycleInProgress, false);
  assert.ok(status.lastQueueFlushAt > 0);
  assert.ok(status.lastRosterSyncAt > 0);
  assert.ok(status.lastSnapshotSyncAt > 0);
});
