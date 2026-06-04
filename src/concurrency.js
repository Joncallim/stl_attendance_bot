export const TELEGRAM_SEND_CONCURRENCY = 25;
// Minimum gap between successive send starts: 1000ms / 25 sends = 40ms.
// Caps throughput at ~25 sends/sec regardless of individual RTTs.
export const TELEGRAM_SEND_INTERVAL_MS = 40;

/**
 * Runs async factory functions with at most `concurrency` in-flight at once,
 * staggering each send start by TELEGRAM_SEND_INTERVAL_MS to enforce a
 * per-second rate cap. Returns a Promise.allSettled-compatible result array.
 */
export async function allSettledConcurrent(fns, concurrency) {
  if (fns.length === 0) return [];
  const results = new Array(fns.length);
  let next = 0;
  let nextAllowedAt = 0;
  const workers = Array.from({ length: Math.min(concurrency, fns.length) }, async () => {
    while (next < fns.length) {
      const i = next++;
      // Synchronously compute and reserve this send's time slot before any await.
      // JS is single-threaded so no other worker runs between these two lines.
      const now = Date.now();
      const delay = Math.max(0, nextAllowedAt - now);
      nextAllowedAt = Math.max(now, nextAllowedAt) + TELEGRAM_SEND_INTERVAL_MS;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      results[i] = await Promise.allSettled([fns[i]()]).then(([r]) => r);
    }
  });
  await Promise.allSettled(workers);
  return results;
}
