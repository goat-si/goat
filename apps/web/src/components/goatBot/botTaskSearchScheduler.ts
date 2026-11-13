const MAX_IN_FLIGHT = 4;
type Job = { current: () => boolean; run: () => Promise<void>; done: () => void };
const queued: Job[] = [];
let active = 0;

function drain() {
  for (let index = queued.length - 1; index >= 0; index--) {
    const job = queued[index];
    if (job && !job.current()) {
      queued.splice(index, 1);
      job.done();
    }
  }
  while (active < MAX_IN_FLIGHT && queued.length) {
    const job = queued.shift();
    if (!job) break;
    active++;
    void job.run().finally(() => {
      active--;
      job.done();
      drain();
    });
  }
}

export function scheduleBotTaskSearch(current: () => boolean, run: () => Promise<void>) {
  return new Promise<void>((done) => {
    queued.push({ current, run, done });
    drain();
  });
}
