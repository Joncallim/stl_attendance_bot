/*
 * Cooperative priority control between user-facing Telegram work and background
 * maintenance.
 *
 * The bot deliberately does not use hard pre-emption. A network request that is
 * already in flight is allowed to finish; background code yields before its next
 * unit of work until all interactive handlers finish and a short quiet period
 * has elapsed. This keeps menus responsive without corrupting partially-complete
 * Sheets operations.
 *
 * AsyncLocalStorage carries the current priority through nested async calls so a
 * helper can tell whether it is serving a Telegram request or background work
 * without threading a priority argument through the entire call graph.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const priorityContext = new AsyncLocalStorage();
const configuredQuietPeriodMs = Number(
  process.env.INTERACTIVE_PRIORITY_QUIET_MS ?? 500
);
let quietPeriodMs = Number.isFinite(configuredQuietPeriodMs)
  ? Math.min(Math.max(configuredQuietPeriodMs, 0), 5000)
  : 500;
let activeInteractiveWork = 0;
let interactiveQuietUntil = 0;
let backgroundSheetProgressRequirements = 0;
let interactiveGeneration = 0;
const stateWaiters = new Set();

// Wake every waiter when the shared priority state changes. Waiters re-check the
// predicate themselves; this avoids trying to encode several scheduling rules
// into the notification mechanism.
function notifyStateChange() {
  const waiters = [...stateWaiters];
  stateWaiters.clear();
  for (const resolve of waiters) {
    resolve();
  }
}

function waitForStateChange(timeoutMs = null) {
  return new Promise((resolve) => {
    let timeoutId = null;
    const finish = () => {
      stateWaiters.delete(finish);
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      resolve();
    };

    stateWaiters.add(finish);
    if (Number.isFinite(timeoutMs)) {
      timeoutId = setTimeout(finish, Math.max(0, timeoutMs));
    }
  });
}

/** Return the priority inherited by the current async call chain. */
export function getCurrentWorkPriority() {
  return priorityContext.getStore()?.priority ?? "background";
}

/**
 * Run an operation as interactive work. Nested interactive calls do not double
 * count. The generation counter changes when new interactive work starts and is
 * used by dispatchers to detect a race between an idle check and an actual send.
 */
export function runWithInteractivePriority(operation) {
  if (getCurrentWorkPriority() === "interactive") {
    return operation();
  }

  activeInteractiveWork += 1;
  interactiveGeneration += 1;
  notifyStateChange();

  return priorityContext.run({ priority: "interactive" }, async () => {
    try {
      return await operation();
    } finally {
      activeInteractiveWork = Math.max(0, activeInteractiveWork - 1);
      interactiveQuietUntil = Math.max(
        interactiveQuietUntil,
        performance.now() + quietPeriodMs
      );
      notifyStateChange();
    }
  });
}

/** Mark a call chain as ordinary background work. */
export function runWithBackgroundPriority(operation) {
  return priorityContext.run({ priority: "background" }, operation);
}

// A background Sheets transaction may already own a higher-level logical lock
// when an interactive transaction arrives. In that one case, allow the owner
// to reach the end of its transaction so it can release the lock; otherwise a
// strict pause would deadlock both operations. The returned function releases
// the temporary exception at the safe transaction boundary.
export function requireBackgroundSheetProgress() {
  backgroundSheetProgressRequirements += 1;
  notifyStateChange();
  let released = false;

  return () => {
    if (released) {
      return;
    }
    released = true;
    backgroundSheetProgressRequirements = Math.max(
      0,
      backgroundSheetProgressRequirements - 1
    );
    notifyStateChange();
  };
}

// Background work yields cooperatively. An already in-flight network request is
// never aborted; the next request waits until every Telegram update has
// completed and the short quiet window has elapsed.
export async function waitForInteractiveIdle() {
  if (getCurrentWorkPriority() === "interactive") {
    return;
  }

  while (true) {
    const now = performance.now();
    if (activeInteractiveWork === 0 && now >= interactiveQuietUntil) {
      return;
    }

    const quietDelay = activeInteractiveWork === 0
      ? Math.max(0, interactiveQuietUntil - now)
      : null;
    await waitForStateChange(quietDelay);
  }
}

/** Snapshot scheduling state for dispatch and diagnostics. */
export function getWorkPriorityStatus() {
  return {
    activeInteractiveWork,
    backgroundSheetProgressRequired: backgroundSheetProgressRequirements > 0,
    interactiveQuietUntil,
    interactiveGeneration,
    priority: getCurrentWorkPriority()
  };
}

export const __testing = {
  reset() {
    activeInteractiveWork = 0;
    interactiveQuietUntil = 0;
    backgroundSheetProgressRequirements = 0;
    interactiveGeneration = 0;
    quietPeriodMs = 500;
    notifyStateChange();
  },
  setQuietPeriodMs(value) {
    quietPeriodMs = Math.max(0, Number(value) || 0);
  }
};
