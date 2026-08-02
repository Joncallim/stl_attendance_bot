export function createSyncManager({
  flushQueue,
  flushQueueIntervalMs = 0,
  shouldFlushQueue,
  refreshOnboarding,
  refreshMonthSlices,
  refreshAdminCache,
  nowFn = Date.now
}) {
  const state = {
    cyclePromise: null,
    cycleIsForced: false,
    cycleHasEssentialSnapshot: false,
    pendingFollowupOptions: null,
    pendingAfterMaintenanceOptions: null,
    maintenanceRunning: false,
    lastQueueFlushAttemptAt: 0,
    lastQueueFlushAt: 0,
    lastOnboardingRefreshAt: 0,
    lastMonthRefreshAt: 0,
    lastFiveMinuteReconcileAt: 0
  };

  function isEssentialSnapshotRefresh(options) {
    return options.essentialSnapshotRefresh === true || options.reason === "foreground";
  }

  function mergeCycleOptions(current, next) {
    return {
      ...current,
      ...next,
      force: Boolean(current?.force || next?.force),
      flushQueue: Boolean(current?.flushQueue || next?.flushQueue),
      essentialSnapshotRefresh: Boolean(
        current?.essentialSnapshotRefresh || next?.essentialSnapshotRefresh
      )
    };
  }

  function queueFollowup(options) {
    state.pendingFollowupOptions = mergeCycleOptions(
      state.pendingFollowupOptions,
      options
    );
    const currentCycle = state.cyclePromise;
    return currentCycle
      .catch(() => undefined)
      .then(() => {
        const pending = state.pendingFollowupOptions;
        state.pendingFollowupOptions = null;
        return pending ? runCycle(pending) : undefined;
      });
  }

  async function runCycle(options = {}) {
    if (state.maintenanceRunning && !state.cyclePromise) {
      // Do not drop attendance threshold flushes or foreground reads merely
      // because roster maintenance owns the current window.
      state.pendingAfterMaintenanceOptions = mergeCycleOptions(
        state.pendingAfterMaintenanceOptions,
        options
      );
      return null;
    }

    if (state.cyclePromise) {
      const needsForcedFollowup = options.force && !state.cycleIsForced;
      const needsExplicitFlushFollowup = options.flushQueue === true;
      const needsEssentialSnapshotFollowup =
        isEssentialSnapshotRefresh(options) && !state.cycleHasEssentialSnapshot;
      if (needsForcedFollowup || needsExplicitFlushFollowup || needsEssentialSnapshotFollowup) {
        return queueFollowup(options);
      }
      return state.cyclePromise;
    }

    state.cycleIsForced = options.force === true;
    state.cycleHasEssentialSnapshot = isEssentialSnapshotRefresh(options);
    state.cyclePromise = (async () => {
      let queueFlushed = false;
      if (flushQueue) {
        const now = nowFn();
        const intervalDue =
          flushQueueIntervalMs <= 0 ||
          state.lastQueueFlushAttemptAt === 0 ||
          now - state.lastQueueFlushAttemptAt >= flushQueueIntervalMs;
        const thresholdReached = shouldFlushQueue
          ? await shouldFlushQueue(options)
          : false;

        if (options.flushQueue === true || intervalDue || thresholdReached) {
          // Record the attempt before awaiting the remote write. During an
          // outage, repeated menu taps must not create a retry storm.
          state.lastQueueFlushAttemptAt = now;
          await flushQueue(options);
          state.lastQueueFlushAt = nowFn();
          queueFlushed = true;
        }
      }

      if (refreshOnboarding) {
        const refreshed = await refreshOnboarding(options);

        if (refreshed !== false) {
          state.lastOnboardingRefreshAt = nowFn();
        }
      }

      if (refreshAdminCache) {
        await refreshAdminCache();
      }

      let monthSlicesRefreshed = true;
      if (refreshMonthSlices) {
        const refreshed = await refreshMonthSlices(options);
        monthSlicesRefreshed = refreshed !== false;

        if (monthSlicesRefreshed) {
          state.lastMonthRefreshAt = nowFn();
        }
      }

      if (options.reason === "five-minute" && monthSlicesRefreshed) {
        state.lastFiveMinuteReconcileAt = nowFn();
      }

      return { queueFlushed, monthSlicesRefreshed };
    })().finally(() => {
      state.cyclePromise = null;
      state.cycleIsForced = false;
      state.cycleHasEssentialSnapshot = false;
    });

    return state.cyclePromise;
  }

  return {
    runCycle,
    setMaintenanceRunning(value) {
      const wasRunning = state.maintenanceRunning;
      state.maintenanceRunning = Boolean(value);
      if (wasRunning && !state.maintenanceRunning && state.pendingAfterMaintenanceOptions) {
        const pending = state.pendingAfterMaintenanceOptions;
        state.pendingAfterMaintenanceOptions = null;
        void runCycle(pending).catch(() => undefined);
      }
    },
    getStatus() {
      return {
        cycleInProgress: Boolean(state.cyclePromise),
        maintenanceRunning: state.maintenanceRunning,
        pendingAfterMaintenance: Boolean(state.pendingAfterMaintenanceOptions),
        lastQueueFlushAttemptAt: state.lastQueueFlushAttemptAt,
        lastQueueFlushAt: state.lastQueueFlushAt,
        lastOnboardingRefreshAt: state.lastOnboardingRefreshAt,
        lastMonthRefreshAt: state.lastMonthRefreshAt,
        lastFiveMinuteReconcileAt: state.lastFiveMinuteReconcileAt
      };
    }
  };
}
