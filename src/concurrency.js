// Keep launch rate below Telegram's approximate free broadcast limit of
// 30 messages/second, leaving headroom for interactive replies and edits.
export const TELEGRAM_SEND_INTERVAL_MS = 40;
// Launch rate and in-flight capacity are separate concerns. Fifty in-flight
// requests preserves 25 sends/second even when Telegram response latency rises
// above one second.
export const TELEGRAM_SEND_CONCURRENCY = 50;
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

function createTelegramSendLimiter(options = {}) {
  const intervalMs = options.intervalMs ?? TELEGRAM_SEND_INTERVAL_MS;
  const nowFn = options.nowFn ?? Date.now;
  const sleepFn = options.sleepFn ?? sleep;
  let nextAllowedAt = 0;
  let blockedUntil = 0;
  let slotTail = Promise.resolve();

  function waitForSlot() {
    const slot = slotTail.catch(() => {}).then(async () => {
      while (true) {
        const now = nowFn();
        const target = Math.max(nextAllowedAt, blockedUntil);
        const delayMs = target - now;

        if (delayMs <= 0) {
          nextAllowedAt = now + intervalMs;
          return;
        }

        await sleepFn(delayMs);
      }
    });

    slotTail = slot;
    return slot;
  }

  function pause(delayMs) {
    blockedUntil = Math.max(blockedUntil, nowFn() + Math.max(0, delayMs));
  }

  function reset() {
    nextAllowedAt = 0;
    blockedUntil = 0;
    slotTail = Promise.resolve();
  }

  return { waitForSlot, pause, reset };
}

// This singleton is intentionally shared by every allSettledConcurrent call.
// Separate manual and scheduled broadcasts must contribute to one Telegram
// launch rate instead of each independently sending 25 messages/second.
const telegramSendLimiter = createTelegramSendLimiter();

async function runTelegramSend(fn) {
  let attempt = 0;

  while (attempt < TELEGRAM_SEND_MAX_ATTEMPTS) {
    attempt += 1;
    await telegramSendLimiter.waitForSlot();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Telegram send timed out.")),
      TELEGRAM_SEND_TIMEOUT_MS
    );
    timeout.unref?.();

    try {
      return await fn(controller.signal);
    } catch (error) {
      const retryAfterMs = getTelegramRetryAfterMs(error);

      if (retryAfterMs === null || attempt >= TELEGRAM_SEND_MAX_ATTEMPTS) {
        throw error;
      }

      telegramSendLimiter.pause(retryAfterMs);
    } finally {
      clearTimeout(timeout);
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
  createTelegramSendLimiter,
  getTelegramRetryAfterMs,
  resetTelegramSendLimiter() {
    telegramSendLimiter.reset();
  }
};
