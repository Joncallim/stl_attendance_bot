/*
 * Sync orchestration for queue flushes and cached sheet refreshes.
 *
 * Several callers can request work at once: foreground Telegram handlers,
 * routine background refreshes, attendance queue thresholds, reminders and the
 * forced five-minute reconciliation. Running each request independently would
 * duplicate Sheets traffic and create races, so this module allows only one
 * cycle at a time and coalesces stronger requests into a follow-up cycle.
 *
 * The important rule is that coalescing may remove duplicate work, but it must
 * not erase intent. A forced refresh, explicit queue flush or foreground
 * snapshot request arriving during a weaker cycle is remembered and run after
 * the current cycle. The same applies while structural maintenance is active.
 */

/**
 * Build a sync manager from injected operations. The operations are injected so
 * scheduling/coalescing can be tested independently of Telegram and Sheets.
 */
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

  // Merge requests by keeping the strongest form of each boolean requirement.
  // Later metadata may replace earlier metadata, but force/flush/essential flags
  // are monotonic: once requested they stay requested for that coalesced cycle.
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

  // Attach the stronger request to the current cycle rather than launching a
  // competing cycle. Multiple callers may add requirements before the current
  // promise settles; they are merged into one follow-up.
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

  /**
   * Run, join or queue a sync cycle.
   *
   * Normal order is queue -> onboarding -> admin cache -> month slices. Queue
   * flushing comes first so a later snapshot is less likely to report a stale
   * value that has already been accepted locally but not yet reached Sheets.
   */
  async function runCycle(options = {}) {
    if (state.maintenanceRunning && !state.cyclePromise) {
      // Structural maintenance owns the sheet mutation window. Keep the request
      // for later instead of dropping foreground or threshold-triggered work.
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

      // The current cycle already satisfies this request, so share its promise.
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
          // Record the attempt before awaiting the remote write. During a
          // Sheets outage, repeated menu taps must not create a retry storm.
          state.lastQueueFlushAttemptAt = now;
          await flushQueue(options);
          state.lastQueueFlushAt = nowFn();
          queueFlushed = true;
        }
      }

      if (refreshOnboarding) {
        const refreshed = await refreshOnboarding(options);

        // A callback may intentionally return false when work was deferred. Do
        // not report that as a successful refresh in status/diagnostics.
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

      // The admin-facing reconciliation timestamp means the five-minute pass
      // actually obtained the month state; a deferred pass should not advance it.
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

    /**
     * Mark the structural-maintenance window. When the window closes, replay the
     * strongest request that accumulated while maintenance held the sheet.
     */
    setMaintenanceRunning(value) {
      const wasRunning = state.maintenanceRunning;
      state.maintenanceRunning = Boolean(value);
      if (wasRunning && !state.maintenanceRunning && state.pendingAfterMaintenanceOptions) {
        const pending = state.pendingAfterMaintenanceOptions;
        state.pendingAfterMaintenanceOptions = null;
        void runCycle(pending).catch(() => undefined);
      }
    },

    /** Return timestamps and coarse state for `/lastupdate` and diagnostics. */
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
