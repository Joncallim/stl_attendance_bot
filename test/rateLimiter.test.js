import test from "node:test";
import assert from "node:assert/strict";

import {
  __testing,
  allSettledConcurrent,
  TELEGRAM_SEND_INTERVAL_MS,
  TELEGRAM_SEND_CONCURRENCY
} from "../src/concurrency.js";

test.beforeEach(() => {
  __testing.resetTelegramSendLimiter();
});

// ── Correctness ───────────────────────────────────────────────────────────────

test("allSettledConcurrent resolves all tasks and preserves index order", async () => {
  const input = [10, 30, 5, 20];
  const results = await allSettledConcurrent(
    input.map((v, i) => async () => `result-${i}`),
    4
  );

  assert.equal(results.length, 4);
  for (let i = 0; i < results.length; i++) {
    assert.equal(results[i].status, "fulfilled");
    assert.equal(results[i].value, `result-${i}`);
  }
});

test("allSettledConcurrent captures rejections without throwing", async () => {
  const results = await allSettledConcurrent(
    [
      async () => "ok",
      async () => { throw new Error("fail"); },
      async () => "also-ok"
    ],
    3
  );

  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[0].value, "ok");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /fail/);
  assert.equal(results[2].status, "fulfilled");
  assert.equal(results[2].value, "also-ok");
});

test("allSettledConcurrent returns empty array for empty input", async () => {
  const results = await allSettledConcurrent([], 10);
  assert.deepEqual(results, []);
});

test("allSettledConcurrent handles single-element array", async () => {
  const results = await allSettledConcurrent([async () => 42], 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].value, 42);
});

// ── Concurrency cap ───────────────────────────────────────────────────────────

test("allSettledConcurrent never exceeds the concurrency cap", async () => {
  const maxInFlight = { current: 0, peak: 0 };

  const tasks = Array.from({ length: 30 }, () => async () => {
    maxInFlight.current++;
    maxInFlight.peak = Math.max(maxInFlight.peak, maxInFlight.current);
    await new Promise((r) => setTimeout(r, 10));
    maxInFlight.current--;
  });

  await allSettledConcurrent(tasks, 5);

  assert.ok(
    maxInFlight.peak <= 5,
    `Peak in-flight ${maxInFlight.peak} should not exceed concurrency cap of 5`
  );
});

test("allSettledConcurrent uses all slots up to the cap", async () => {
  const maxInFlight = { current: 0, peak: 0 };

  // Tasks must run longer than the stagger interval so they accumulate in-flight.
  // With 40ms stagger and 5x duration, tasks start at t=0,40,80,120,160ms and
  // all remain in-flight at t=160ms, giving peak >= 5.
  const taskDuration = TELEGRAM_SEND_INTERVAL_MS * 5;

  const tasks = Array.from({ length: 20 }, () => async () => {
    maxInFlight.current++;
    maxInFlight.peak = Math.max(maxInFlight.peak, maxInFlight.current);
    await new Promise((r) => setTimeout(r, taskDuration));
    maxInFlight.current--;
  });

  await allSettledConcurrent(tasks, 10);

  assert.ok(
    maxInFlight.peak >= 5,
    `Peak in-flight ${maxInFlight.peak} should use multiple slots (got ${maxInFlight.peak})`
  );
});

// ── Rate stagger ──────────────────────────────────────────────────────────────

test("successive send starts are spaced by at least TELEGRAM_SEND_INTERVAL_MS", async () => {
  const startTimes = [];
  const taskCount = 10;

  const tasks = Array.from({ length: taskCount }, (_, i) => async () => {
    startTimes[i] = Date.now();
    // Fast-completing tasks — if only concurrency was enforced, all would
    // start simultaneously and breach the rate limit.
    return i;
  });

  await allSettledConcurrent(tasks, taskCount);

  assert.equal(startTimes.length, taskCount, "all tasks should have recorded a start time");

  const sorted = [...startTimes].sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap < minGap) minGap = gap;
  }

  // Allow a 5ms tolerance for timer imprecision on busy CI machines
  const tolerance = 5;
  assert.ok(
    minGap >= TELEGRAM_SEND_INTERVAL_MS - tolerance,
    `Minimum gap between send starts was ${minGap}ms, expected >= ${TELEGRAM_SEND_INTERVAL_MS - tolerance}ms`
  );
});

test("rate stagger ensures 30 fast tasks take at least (count-1) * INTERVAL ms total", async () => {
  const count = 30;
  const tasks = Array.from({ length: count }, (_, i) => async () => i);

  const before = Date.now();
  await allSettledConcurrent(tasks, TELEGRAM_SEND_CONCURRENCY);
  const elapsed = Date.now() - before;

  const minExpectedMs = (count - 1) * TELEGRAM_SEND_INTERVAL_MS;
  assert.ok(
    elapsed >= minExpectedMs - 10, // 10ms tolerance
    `${count} tasks should take at least ${minExpectedMs}ms due to rate stagger, took ${elapsed}ms`
  );
});

test("overlapping broadcasts share one process-wide send rate", async () => {
  const startTimes = [];
  const makeBatch = (batch) =>
    allSettledConcurrent(
      Array.from({ length: 8 }, (_, index) => async () => {
        startTimes.push({ batch, index, startedAt: Date.now() });
      }),
      TELEGRAM_SEND_CONCURRENCY
    );

  await Promise.all([makeBatch("manual"), makeBatch("scheduled")]);

  const sortedStarts = startTimes
    .map((entry) => entry.startedAt)
    .sort((left, right) => left - right);
  const tolerance = 5;

  for (let index = 1; index < sortedStarts.length; index += 1) {
    assert.ok(
      sortedStarts[index] - sortedStarts[index - 1] >=
        TELEGRAM_SEND_INTERVAL_MS - tolerance,
      "overlapping batches must not reserve independent send slots"
    );
  }
});

test("Telegram 429 responses retry after the requested global pause", async () => {
  let attempts = 0;
  const startedAt = Date.now();
  const [result] = await allSettledConcurrent(
    [async () => {
      attempts += 1;

      if (attempts === 1) {
        const error = new Error("Too Many Requests");
        error.code = 429;
        error.parameters = { retry_after: 0.02 };
        throw error;
      }

      return "sent";
    }],
    TELEGRAM_SEND_CONCURRENCY
  );

  assert.equal(result.status, "fulfilled");
  assert.equal(result.value, "sent");
  assert.equal(attempts, 2);
  assert.ok(
    Date.now() - startedAt >= TELEGRAM_SEND_INTERVAL_MS - 5,
    "retry must pass through the shared rate limiter"
  );
});

test("TELEGRAM_SEND_INTERVAL_MS constant enforces < 30 msgs/sec throughput", () => {
  const maxPerSecond = 1000 / TELEGRAM_SEND_INTERVAL_MS;
  assert.ok(
    maxPerSecond <= 30,
    `Rate cap ${maxPerSecond.toFixed(1)} sends/sec should be at most 30; interval=${TELEGRAM_SEND_INTERVAL_MS}ms`
  );
});

test("in-flight capacity exceeds the launch rate for slow Telegram responses", () => {
  const launchesPerSecond = 1000 / TELEGRAM_SEND_INTERVAL_MS;
  assert.ok(TELEGRAM_SEND_CONCURRENCY > launchesPerSecond);
});
