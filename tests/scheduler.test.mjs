import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedScheduler } from "../src/scheduler.mjs";

test("scheduler honors its concurrency bound", async () => {
  const scheduler = createBoundedScheduler(2);
  const started = [];
  const releases = [];
  const jobs = [0, 1, 2].map((id) =>
    scheduler.schedule(
      () =>
        new Promise((resolve) => {
          releases[id] = () => resolve(id);
        }),
      () => started.push(id),
    ),
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]);
  assert.equal(scheduler.activeCount, 2);
  assert.equal(scheduler.queuedCount, 1);

  releases[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);

  releases[1]();
  releases[2]();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2]);
  assert.equal(scheduler.activeCount, 0);
});
