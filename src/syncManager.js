export function createSyncManager({
  flushQueue,
  refreshOnboarding,
  refreshMonthSlices,
  refreshAdminCache
}) {
  const state = {
    cyclePromise: null,
    lastQueueFlushAt: 0,
    lastOnboardingRefreshAt: 0,
    lastMonthRefreshAt: 0
  };

  async function runCycle(options = {}) {
    if (state.cyclePromise) {
      return state.cyclePromise;
    }

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
    })().finally(() => {
      state.cyclePromise = null;
    });

    return state.cyclePromise;
  }

  return {
    runCycle,
    getStatus() {
      return {
        cycleInProgress: Boolean(state.cyclePromise),
        lastQueueFlushAt: state.lastQueueFlushAt,
        lastOnboardingRefreshAt: state.lastOnboardingRefreshAt,
        lastMonthRefreshAt: state.lastMonthRefreshAt
      };
    }
  };
}
