export function createBoundedScheduler(limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Scheduler limit must be a positive integer.");
  }

  const queue = [];
  let activeCount = 0;

  function drain() {
    while (activeCount < limit && queue.length > 0) {
      const item = queue.shift();
      activeCount += 1;
      item.onStart?.();
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          activeCount -= 1;
          drain();
        });
    }
  }

  return {
    limit,
    get activeCount() {
      return activeCount;
    },
    get queuedCount() {
      return queue.length;
    },
    schedule(task, onStart) {
      return new Promise((resolve, reject) => {
        queue.push({ task, onStart, resolve, reject });
        drain();
      });
    },
  };
}
