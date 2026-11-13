const MAX_IN_FLIGHT = 4;
type Job = {
  current: () => boolean;
  run: () => Promise<void>;
  fail: (error: unknown) => void;
  done: () => void;
};
const queued: Job[] = [];
let active = 0;

export function pruneBotTaskSearch() {
  for (let index = queued.length - 1; index >= 0; index--) {
    const job = queued[index];
    if (job && !job.current()) {
      queued.splice(index, 1);
      job.done();
    }
  }
}

function drain() {
  pruneBotTaskSearch();
  while (active < MAX_IN_FLIGHT && queued.length) {
    const job = queued.shift();
    if (!job) break;
    active++;
    void Promise.resolve()
      .then(() => job.run())
      .catch((error: unknown) => {
        if (job.current()) job.fail(error);
      })
      .finally(() => {
        active--;
        job.done();
        drain();
      });
  }
}

export function scheduleBotTaskSearch(
  current: () => boolean,
  run: () => Promise<void>,
  fail: (error: unknown) => void,
) {
  return new Promise<void>((done) => {
    queued.push({ current, run, fail, done });
    drain();
  });
}
