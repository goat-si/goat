let pending = false;
let handler: (() => void) | null = null;

/** Starts a new thread now, or as soon as something that can start one is mounted. */
export function requestNewThread(): void {
  if (handler === null) {
    pending = true;
    return;
  }
  handler();
}

export function provideNewThread(start: () => void): () => void {
  handler = start;
  if (pending) {
    pending = false;
    start();
  }
  return () => {
    if (handler === start) handler = null;
  };
}
