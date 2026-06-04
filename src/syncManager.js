export function createSyncManager({
  flushQueue,
  refreshOnboarding,
  refreshMonthSlices,
  refreshAdminCache
}) {
  const state = {
    cyclePromise: null,
    cycleIsForced: false,
    pendingForcedOptions: null,
    maintenanceRunning: false,
    lastQueueFlushAt: 0,
    lastOnboardingRefreshAt: 0,
    lastMonthRefreshAt: 0,
    lastFiveMinuteReconcileAt: 0
  };

  async function runCycle(options = {}) {
    if (state.cyclePromise || state.maintenanceRunning) {
      // If the caller requests a forced cycle but the running one is not forced,
      // queue a single follow-up forced cycle so the forced params aren't lost.
      // Only chain when cyclePromise is set — maintenanceRunning can be true while
      // cyclePromise is null, and chaining on null would throw.
      if (options.force && !state.cycleIsForced && !state.pendingForcedOptions && state.cyclePromise) {
        state.pendingForcedOptions = options;
        return state.cyclePromise.then(() => {
          if (state.pendingForcedOptions) {
            const pending = state.pendingForcedOptions;
            state.pendingForcedOptions = null;
            return runCycle(pending);
          }
        });
      }

      return state.cyclePromise;
    }

    state.cycleIsForced = options.force === true;
    state.cyclePromise = (async () => {
      if (flushQueue) {
        await flushQueue();
        state.lastQueueFlushAt = Date.now();
      }

      if (refreshOnboarding) {
        const refreshed = await refreshOnboarding(options);

        if (refreshed !== false) {
          state.lastOnboardingRefreshAt = Date.now();
        }
      }

      if (refreshAdminCache) {
        await refreshAdminCache();
      }

      if (refreshMonthSlices) {
        const refreshed = await refreshMonthSlices(options);

        if (refreshed !== false) {
          state.lastMonthRefreshAt = Date.now();
        }
      }

      if (options.reason === "five-minute") {
        state.lastFiveMinuteReconcileAt = Date.now();
      }
    })().finally(() => {
      state.cyclePromise = null;
      state.cycleIsForced = false;
    });

    return state.cyclePromise;
  }

  return {
    runCycle,
    setMaintenanceRunning(value) {
      state.maintenanceRunning = Boolean(value);
    },
    getStatus() {
      return {
        cycleInProgress: Boolean(state.cyclePromise),
        maintenanceRunning: state.maintenanceRunning,
        lastQueueFlushAt: state.lastQueueFlushAt,
        lastOnboardingRefreshAt: state.lastOnboardingRefreshAt,
        lastMonthRefreshAt: state.lastMonthRefreshAt,
        lastFiveMinuteReconcileAt: state.lastFiveMinuteReconcileAt
      };
    }
  };
}
