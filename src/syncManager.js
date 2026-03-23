export function createSyncManager({
  flushQueue,
  syncRoster,
  refreshAdminCache,
  preloadSnapshots
}) {
  const state = {
    cyclePromise: null,
    lastQueueFlushAt: 0,
    lastRosterSyncAt: 0,
    lastSnapshotSyncAt: 0
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

      if (syncRoster) {
        await syncRoster();
        state.lastRosterSyncAt = Date.now();
      }

      if (refreshAdminCache) {
        await refreshAdminCache();
      }

      if (preloadSnapshots) {
        await preloadSnapshots(options);
        state.lastSnapshotSyncAt = Date.now();
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
        lastRosterSyncAt: state.lastRosterSyncAt,
        lastSnapshotSyncAt: state.lastSnapshotSyncAt
      };
    }
  };
}
