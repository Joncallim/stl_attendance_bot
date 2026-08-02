import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

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

// Attendance prompts carry user-state patches after delivery. Serializing whole
// prompt jobs prevents overlapping manual/scheduled jobs from overwriting each
// other's prompt ids or reintroducing an awaiting state after a newer prompt.
// The activity flag starts only when the queued job actually begins, so queued
// work does not unnecessarily suppress snapshot refreshes.
export function enqueueAttendancePromptBroadcast(operation) {
  const wasQueued = queuedPromptBroadcasts > 0 || activeBroadcasts > 0;
  queuedPromptBroadcasts += 1;
  const completion = promptBroadcastTail
    .catch(() => {})
    .then(async () => {
      queuedPromptBroadcasts = Math.max(0, queuedPromptBroadcasts - 1);
      return runWithBroadcastActivity(operation);
    });

  promptBroadcastTail = completion.catch(() => {});
  return { wasQueued, completion };
}

export function shouldDeferSnapshotRefresh() {
  return activeBroadcasts > 0 || performance.now() < snapshotRefreshDeferredUntil;
}

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
