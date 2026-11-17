/* A tiny in-process job queue for slow work (Haiku calls, website fetches), two at a time. */
function createJobs(log = console) {
  const q = []; let running = 0; const waiters = []; const errors = [];
  const pump = () => {
    while (running < 2 && q.length) {
      const { fn, label } = q.shift(); running++;
      Promise.resolve().then(fn).catch((e) => { errors.unshift(`${label}: ${e.message}`); errors.length = Math.min(errors.length, 20); log.error?.(`job ${label} failed: ${e.message}`); })
        .finally(() => { running--; pump(); if (!running && !q.length) while (waiters.length) waiters.shift()(); });
    }
  };
  return {
    add(fn, label = "job") { q.push({ fn, label }); pump(); },
    drain() { return running || q.length ? new Promise((r) => waiters.push(r)) : Promise.resolve(); },
    size: () => q.length + running, errors
  };
}
module.exports = { createJobs };
