const MAX_BACKGROUND_ATTEMPTS = 3;
const BACKOFF_MS = 1_000;

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchThemeBackground(
  url: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = waitForRetry,
): Promise<Response> {
  for (let attempt = 1; attempt < MAX_BACKGROUND_ATTEMPTS; attempt++) {
    const response = await request(url, {
      signal,
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (response.status !== 503) return response;
    await response.body?.cancel();
    await wait(BACKOFF_MS * attempt, signal);
  }
  return request(url, { signal, redirect: "error", referrerPolicy: "no-referrer" });
}
