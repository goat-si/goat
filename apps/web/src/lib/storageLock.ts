/**
 * Runs a read-merge-write under a Web Lock shared by every tab of this origin, so two tabs
 * cannot interleave their read and write of one storage key. Without Web Locks, or when the
 * request fails before granting, `work` runs at once: a plain read-merge-write.
 */
export function runWithStorageLock<A>(key: string, work: () => A | Promise<A>): Promise<A> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  let started = false;
  const run = () => {
    started = true;
    return work();
  };
  if (!locks) return runNow(run);
  try {
    return locks
      .request(`goat:storage-lock:${key}`, run)
      .catch((error: unknown) => (started ? Promise.reject(error) : run()));
  } catch {
    return runNow(run);
  }
}

function runNow<A>(work: () => A | Promise<A>): Promise<A> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error);
  }
}
