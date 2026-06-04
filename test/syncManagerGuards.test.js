import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createSyncManager } from "../src/syncManager.js";

function makeManager(overrides = {}) {
  const calls = [];
  const sm = createSyncManager({
    flushQueue: async () => { calls.push("flush"); await delay(10); },
    refreshOnboarding: async () => { calls.push("onboarding"); },
    refreshAdminCache: async () => { calls.push("cache"); },
    refreshMonthSlices: async () => { calls.push("months"); },
    ...overrides
  });
  return { sm, calls };
}

// ── maintenanceRunning guard ──────────────────────────────────────────────────

test("runCycle returns null immediately and runs nothing while maintenanceRunning", async () => {
  const { sm, calls } = makeManager();
  sm.setMaintenanceRunning(true);

  const result = await sm.runCycle({ force: true });
  assert.equal(result, null, "should return null when maintenance is running");
  assert.deepEqual(calls, [], "no handlers should run during maintenance");
});

test("runCycle runs normally after maintenanceRunning is cleared", async () => {
  const { sm, calls } = makeManager();
  sm.setMaintenanceRunning(true);
  sm.setMaintenanceRunning(false);

  await sm.runCycle({ force: true });
  assert.ok(calls.includes("flush"), "flush should run after maintenance clears");
});

// ── No null-chain crash ───────────────────────────────────────────────────────

test("forced cycle during maintenanceRunning does not throw (no null.then crash)", async () => {
  const { sm, calls } = makeManager();
  sm.setMaintenanceRunning(true);

  // This must not throw TypeError from state.cyclePromise.then on null
  await assert.doesNotReject(
    async () => { await sm.runCycle({ force: true }); },
    "forced runCycle during maintenance must not throw"
  );
  assert.deepEqual(calls, []);
});

// ── Forced follow-up cycle ────────────────────────────────────────────────────

test("forced cycle queues a follow-up when a non-forced cycle is already running", async () => {
  const callLog = [];
  let forcedRan = false;

  const sm = createSyncManager({
    flushQueue: async (options) => {
      callLog.push({ step: "flush", force: options?.force ?? "n/a" });
      await delay(40); // long enough that the second call arrives mid-run
    },
    refreshMonthSlices: async (options) => {
      if (options?.force) forcedRan = true;
    },
    refreshAdminCache: async () => {}
  });

  // Start a non-forced cycle
  const nonForcedPromise = sm.runCycle({ force: false });

  // Immediately request a forced cycle — it should queue as a follow-up
  const forcedPromise = sm.runCycle({ force: true, reason: "reminder" });

  await Promise.all([nonForcedPromise, forcedPromise]);

  assert.equal(forcedRan, true, "the forced follow-up cycle should run and pass force:true");
  assert.equal(callLog.length, 2, "flush should have run twice (non-forced + forced follow-up)");
});

test("only one follow-up forced cycle is queued even if multiple forced calls arrive", async () => {
  let flushCount = 0;

  const sm = createSyncManager({
    flushQueue: async () => { flushCount++; await delay(30); },
    refreshAdminCache: async () => {}
  });

  // Non-forced cycle in progress
  const nonForcedPromise = sm.runCycle({ force: false });

  // Three simultaneous forced calls arrive
  await Promise.all([
    sm.runCycle({ force: true }),
    sm.runCycle({ force: true }),
    sm.runCycle({ force: true }),
    nonForcedPromise
  ]);

  // Should run: 1 non-forced + 1 follow-up forced (not 3 follow-ups)
  assert.equal(flushCount, 2, "only one follow-up cycle should run regardless of how many forced calls arrived");
});

// ── cycleIsForced tracking ────────────────────────────────────────────────────

test("second forced call during a forced cycle does not queue a redundant follow-up", async () => {
  let flushCount = 0;

  const sm = createSyncManager({
    flushQueue: async () => { flushCount++; await delay(25); },
    refreshAdminCache: async () => {}
  });

  // Both calls are forced — second should just wait on the first, no extra cycle
  const [r1, r2] = await Promise.all([
    sm.runCycle({ force: true }),
    sm.runCycle({ force: true })
  ]);

  assert.equal(flushCount, 1, "duplicate forced calls should not spawn extra cycles");
});

// ── Timestamp tracking ────────────────────────────────────────────────────────

test("getStatus reports correct timestamps after a completed cycle", async () => {
  const { sm } = makeManager();

  const before = Date.now();
  await sm.runCycle({ force: true, reason: "five-minute" });
  const after = Date.now();

  const status = sm.getStatus();
  assert.equal(status.cycleInProgress, false);
  assert.ok(status.lastQueueFlushAt >= before && status.lastQueueFlushAt <= after);
  assert.ok(status.lastFiveMinuteReconcileAt >= before);
  assert.ok(status.lastMonthRefreshAt >= before);
});

test("getStatus cycleInProgress is true while a cycle is running", async () => {
  let resolveFlush;
  const flushGate = new Promise((r) => { resolveFlush = r; });

  const sm = createSyncManager({
    flushQueue: async () => { await flushGate; },
    refreshAdminCache: async () => {}
  });

  const cyclePromise = sm.runCycle();
  assert.equal(sm.getStatus().cycleInProgress, true, "cycleInProgress should be true mid-run");

  resolveFlush();
  await cyclePromise;
  assert.equal(sm.getStatus().cycleInProgress, false, "cycleInProgress should be false after completion");
});
