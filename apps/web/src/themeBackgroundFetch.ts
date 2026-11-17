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

export async function retryBackgroundMint<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = waitForRetry,
): Promise<T> {
  for (let attempt = 1; attempt < MAX_BACKGROUND_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (cause) {
      const tag =
        typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : null;
      if (
        signal.aborted ||
        (tag !== "EnvironmentRpcUnavailableError" && tag !== "ThemeBackgroundUrlError")
      )
        throw cause;
      await wait(BACKOFF_MS * attempt, signal);
    }
  }
  return operation();
}

export async function fetchThemeBackground(
  url: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = waitForRetry,
): Promise<Response> {
  for (let attempt = 1; attempt < MAX_BACKGROUND_ATTEMPTS; attempt++) {
    try {
      const response = await request(url, {
        signal,
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      if (![502, 503, 504].includes(response.status)) return response;
      await response.body?.cancel();
    } catch (cause) {
      if (signal.aborted || !(cause instanceof TypeError)) throw cause;
    }
    await wait(BACKOFF_MS * attempt, signal);
  }
  return request(url, { signal, redirect: "error", referrerPolicy: "no-referrer" });
}
