import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

/*
 * Coordinates attendance-prompt broadcasts with snapshot refreshes.
 *
 * Two separate guarantees live here:
 * 1. Prompt broadcasts are serialized. Each broadcast writes prompt/message state
 *    back to user records after sending, so overlapping jobs could otherwise let
 *    an older broadcast overwrite state produced by a newer one.
 * 2. Nonessential sheet snapshots are deferred while a broadcast is active and
 *    for a short cooldown afterward. This reserves Sheets/network capacity for
 *    the user-visible broadcast path.
 *
 * A reimplementation does not need AsyncLocalStorage, but it does need an
 * equivalent way to tag nonessential refresh work and enforce these two rules.
 */

function boundedIntegerEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isInteger(value)
    ? Math.min(Math.max(value, min), max)
    : fallback;
}

export const SNAPSHOT_REFRESH_POST_BROADCAST_DELAY_MS = boundedIntegerEnv(
  "SNAPSHOT_REFRESH_POST_BROADCAST_DELAY_MS",
  30_000,
  0,
  10 * 60 * 1000
);

let postBroadcastDelayMs = SNAPSHOT_REFRESH_POST_BROADCAST_DELAY_MS;
let activeBroadcasts = 0;
let snapshotRefreshDeferredUntil = 0;
let queuedPromptBroadcasts = 0;
let promptBroadcastTail = Promise.resolve();
const snapshotRefreshContext = new AsyncLocalStorage();

export async function runWithBroadcastActivity(operation) {
  activeBroadcasts += 1;

  try {
    return await operation();
  } finally {
    activeBroadcasts = Math.max(0, activeBroadcasts - 1);
    if (activeBroadcasts === 0) {
      snapshotRefreshDeferredUntil = Math.max(
        snapshotRefreshDeferredUntil,
        performance.now() + postBroadcastDelayMs
      );
    }
  }
}

// Queue complete prompt jobs rather than individual Telegram sends. The state
// update belonging to one job therefore finishes before the next job starts.
export function enqueueAttendancePromptBroadcast(operation) {
  const wasQueued = queuedPromptBroadcasts > 0 || activeBroadcasts > 0;
  queuedPromptBroadcasts += 1;
  const completion = promptBroadcastTail
    .catch(() => {})
    .then(async () => {
      queuedPromptBroadcasts = Math.max(0, queuedPromptBroadcasts - 1);
      return runWithBroadcastActivity(operation);
    });

  // A failed broadcast must not break the queue chain for later jobs. The
  // caller still receives the original `completion` promise and sees failure.
  promptBroadcastTail = completion.catch(() => {});
  return { wasQueued, completion };
}

export function shouldDeferSnapshotRefresh() {
  return activeBroadcasts > 0 || performance.now() < snapshotRefreshDeferredUntil;
}

// The context marker lets lower-level Sheets code distinguish a refresh that
// may safely yield from a foreground/structural read that must complete.
export function runAsNonessentialSnapshotRefresh(operation) {
  return snapshotRefreshContext.run({ nonessentialSnapshotRefresh: true }, operation);
}

export function isNonessentialSnapshotRefresh() {
  return snapshotRefreshContext.getStore()?.nonessentialSnapshotRefresh === true;
}

export function getBroadcastActivityStatus() {
  return {
    activeBroadcasts,
    queuedPromptBroadcasts,
    snapshotRefreshDeferred: shouldDeferSnapshotRefresh(),
    snapshotRefreshDeferredUntil
  };
}

export const __testing = {
  reset() {
    activeBroadcasts = 0;
    snapshotRefreshDeferredUntil = 0;
    queuedPromptBroadcasts = 0;
    promptBroadcastTail = Promise.resolve();
    postBroadcastDelayMs = SNAPSHOT_REFRESH_POST_BROADCAST_DELAY_MS;
  },
  setPostBroadcastDelayMs(value) {
    postBroadcastDelayMs = Math.max(0, Number(value) || 0);
  }
};
