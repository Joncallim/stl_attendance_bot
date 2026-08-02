import test from "node:test";
import assert from "node:assert/strict";
import {
  __testing,
  getCurrentWorkPriority,
  runWithBackgroundPriority,
  runWithInteractivePriority,
  waitForInteractiveIdle
} from "../src/workPriority.js";

test.beforeEach(() => {
  __testing.reset();
  __testing.setQuietPeriodMs(0);
});

test("background work waits until active Telegram input completes", async () => {
  let releaseInteractive;
  const interactive = runWithInteractivePriority(() => new Promise((resolve) => {
    releaseInteractive = resolve;
  }));
  let backgroundStarted = false;
  const background = runWithBackgroundPriority(async () => {
    await waitForInteractiveIdle();
    backgroundStarted = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(backgroundStarted, false);

  releaseInteractive();
  await Promise.all([interactive, background]);
  assert.equal(backgroundStarted, true);
});

test("interactive work never waits on its own priority gate", async () => {
  await runWithInteractivePriority(async () => {
    assert.equal(getCurrentWorkPriority(), "interactive");
    await waitForInteractiveIdle();
  });
});

test("background work observes the post-input quiet period", async () => {
  __testing.setQuietPeriodMs(30);
  const startedAt = Date.now();
  await runWithInteractivePriority(async () => {});
  await runWithBackgroundPriority(() => waitForInteractiveIdle());
  assert.ok(Date.now() - startedAt >= 25);
});
