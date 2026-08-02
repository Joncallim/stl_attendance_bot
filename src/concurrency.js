import {
  getWorkPriorityStatus,
  waitForInteractiveIdle
} from "./workPriority.js";

function boundedIntegerEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isInteger(value)
    ? Math.min(Math.max(value, min), max)
    : fallback;
}

// Keep broadcasts deliberately below Telegram's bot-wide throughput so direct
// replies and message edits have ample headroom. Both values are tunable
// without a deployment-time code edit.
export const TELEGRAM_SEND_INTERVAL_MS = boundedIntegerEnv(
  "TELEGRAM_BROADCAST_INTERVAL_MS",
  100,
  50,
  1000
);
export const TELEGRAM_SEND_CONCURRENCY = boundedIntegerEnv(
  "TELEGRAM_BROADCAST_CONCURRENCY",
  12,
  1,
  15
);
export const TELEGRAM_SEND_MAX_ATTEMPTS = 3;
export const TELEGRAM_SEND_TIMEOUT_MS = 15_000;

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function getTelegramRetryAfterMs(error) {
  const code = Number(
    error?.code ??
    error?.response?.error_code ??
    error?.response?.status ??
    error?.status
  );

  if (code !== 429) {
    return code >= 500 && code <= 599 ? 500 : null;
  }

  const retryAfterSeconds = Number(
    error?.parameters?.retry_after ??
    error?.response?.parameters?.retry_after ??
    error?.response?.data?.parameters?.retry_after
  );

  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? Math.ceil(retryAfterSeconds * 1000)
    : 1000;
}

function createTelegramSendDispatcher(options = {}) {
  const intervalMs = options.intervalMs ?? TELEGRAM_SEND_INTERVAL_MS;
  const maxConcurrent = options.maxConcurrent ?? TELEGRAM_SEND_CONCURRENCY;
  const nowFn = options.nowFn ?? Date.now;
  const sleepFn = options.sleepFn ?? sleep;
  let nextAllowedAt = 0;
  let blockedUntil = 0;
  let active = 0;
  let peakActive = 0;
  let draining = false;
  const queue = [];

  async function execute(task) {
    try {
      task.resolve(await task.fn());
    } catch (error) {
      task.reject(error);
    } finally {
      active = Math.max(0, active - 1);
      void drain();
    }
  }

  async function drain() {
    if (draining) {
      return;
    }

    draining = true;
    try {
      while (queue.length > 0 && active < maxConcurrent) {
        // Check the interactive gate before every launch. The launch slot is
        // not reserved until after this await, so an incoming update cannot
        // accumulate a burst of already-reserved broadcast sends.
        await waitForInteractiveIdle();

        const priority = getWorkPriorityStatus();
        if (priority.activeInteractiveWork > 0) {
          continue;
        }

        const now = nowFn();
        const target = Math.max(nextAllowedAt, blockedUntil);
        if (target > now) {
          await sleepFn(target - now);
          continue;
        }

        // The final generation check catches an update that began while the
        // dispatcher was waiting for rate capacity. Do not consume a slot in
        // that case; loop back through the quiet-period gate instead.
        const beforeLaunch = getWorkPriorityStatus();
        if (
          beforeLaunch.activeInteractiveWork > 0 ||
          beforeLaunch.interactiveGeneration !== priority.interactiveGeneration
        ) {
          continue;
        }

        const task = queue.shift();
        nextAllowedAt = nowFn() + intervalMs;
        active += 1;
        peakActive = Math.max(peakActive, active);
        void execute(task);
      }
    } finally {
      draining = false;
      if (queue.length > 0 && active < maxConcurrent) {
        void drain();
      }
    }
  }

  function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      void drain();
    });
  }

  function pause(delayMs) {
    blockedUntil = Math.max(blockedUntil, nowFn() + Math.max(0, delayMs));
  }

  function reset() {
    nextAllowedAt = 0;
    blockedUntil = 0;
    active = 0;
    peakActive = 0;
    queue.length = 0;
    draining = false;
  }

  function getStatus() {
    return {
      active,
      peakActive,
      queued: queue.length,
      nextAllowedAt,
      blockedUntil
    };
  }

  return { run, pause, reset, getStatus };
}

// This singleton is intentionally shared by every allSettledConcurrent call.
// Separate manual and scheduled broadcasts must contribute to one Telegram
// launch rate instead of each independently sending 25 messages/second.
const telegramSendDispatcher = createTelegramSendDispatcher();

async function runTelegramSend(fn) {
  let attempt = 0;

  while (attempt < TELEGRAM_SEND_MAX_ATTEMPTS) {
    attempt += 1;
    try {
      return await telegramSendDispatcher.run(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(new Error("Telegram send timed out.")),
          TELEGRAM_SEND_TIMEOUT_MS
        );
        timeout.unref?.();

        try {
          return await fn(controller.signal);
        } finally {
          clearTimeout(timeout);
        }
      });
    } catch (error) {
      const retryAfterMs = getTelegramRetryAfterMs(error);

      if (retryAfterMs === null || attempt >= TELEGRAM_SEND_MAX_ATTEMPTS) {
        throw error;
      }

      telegramSendDispatcher.pause(retryAfterMs);
    }
  }

  return null;
}

/**
 * Runs async Telegram send factories with bounded in-flight work and one
 * process-wide launch rate. Results preserve input order and use the
 * Promise.allSettled shape.
 */
export async function allSettledConcurrent(fns, concurrency) {
  if (fns.length === 0) return [];
  const results = new Array(fns.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, fns.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < fns.length) {
      const i = next++;

      try {
        results[i] = {
          status: "fulfilled",
          value: await runTelegramSend(fns[i])
        };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

export const __testing = {
  createTelegramSendDispatcher,
  getTelegramRetryAfterMs,
  resetTelegramSendLimiter() {
    telegramSendDispatcher.reset();
  },
  getTelegramSendDispatcherStatus() {
    return telegramSendDispatcher.getStatus();
  }
};
