import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  __testing,
  getBroadcastActivityStatus,
  isNonessentialSnapshotRefresh,
  runAsNonessentialSnapshotRefresh,
  runWithBroadcastActivity,
  shouldDeferSnapshotRefresh,
  SNAPSHOT_REFRESH_POST_BROADCAST_DELAY_MS
} from "../src/broadcastActivity.js";

test.beforeEach(() => {
  __testing.reset();
});

test("snapshot refreshes defer during broadcasts and through the cooldown", async () => {
  __testing.setPostBroadcastDelayMs(30);
  let releaseBroadcast;
  const broadcast = runWithBroadcastActivity(() => new Promise((resolve) => {
    releaseBroadcast = resolve;
  }));

  assert.equal(shouldDeferSnapshotRefresh(), true);
  assert.equal(getBroadcastActivityStatus().activeBroadcasts, 1);

  releaseBroadcast();
  await broadcast;
  assert.equal(shouldDeferSnapshotRefresh(), true);
  assert.equal(getBroadcastActivityStatus().activeBroadcasts, 0);

  await delay(40);
  assert.equal(shouldDeferSnapshotRefresh(), false);
});

test("overlapping broadcasts keep refreshes deferred until the last one ends", async () => {
  __testing.setPostBroadcastDelayMs(0);
  let releaseFirst;
  let releaseSecond;
  const first = runWithBroadcastActivity(() => new Promise((resolve) => {
    releaseFirst = resolve;
  }));
  const second = runWithBroadcastActivity(() => new Promise((resolve) => {
    releaseSecond = resolve;
  }));

  releaseFirst();
  await first;
  assert.equal(shouldDeferSnapshotRefresh(), true);
  assert.equal(getBroadcastActivityStatus().activeBroadcasts, 1);

  releaseSecond();
  await second;
  assert.equal(shouldDeferSnapshotRefresh(), false);
});

test("snapshot cooldown defaults to 30 seconds", () => {
  assert.equal(SNAPSHOT_REFRESH_POST_BROADCAST_DELAY_MS, 30_000);
});

test("nonessential snapshot context is scoped to the wrapped operation", async () => {
  assert.equal(isNonessentialSnapshotRefresh(), false);
  await runAsNonessentialSnapshotRefresh(async () => {
    assert.equal(isNonessentialSnapshotRefresh(), true);
    await Promise.resolve();
    assert.equal(isNonessentialSnapshotRefresh(), true);
  });
  assert.equal(isNonessentialSnapshotRefresh(), false);
});
