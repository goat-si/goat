// @effect-diagnostics globalTimers:off - event-driven tracking belongs to the browser connection.
import type { Page, Request } from "playwright-core";

const trackers = new WeakMap<Page, ReturnType<typeof makeTracker>>();

const makeTracker = (page: Page) => {
  const requests = new Set<Request>();
  const listeners = new Set<() => void>();
  let complete = false;
  let documentId = 0;
  let navigation: Request | undefined;
  let previousRequests = new Set<Request>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const onRequest = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      previousRequests = new Set(requests);
      navigation = request;
    }
    requests.add(request);
    notify();
  };
  const finished = (request: Request) => {
    requests.delete(request);
    notify();
  };
  const failed = (request: Request) => {
    if (request === navigation) navigation = undefined;
    finished(request);
  };
  const navigated = (frame: ReturnType<Page["mainFrame"]>) => {
    if (frame !== page.mainFrame() || !navigation) return;
    navigation = undefined;
    for (const request of previousRequests) requests.delete(request);
    previousRequests.clear();
    documentId++;
    complete = true;
    notify();
  };
  page.on("request", onRequest);
  page.on("requestfinished", finished);
  page.on("requestfailed", failed);
  page.on("framenavigated", navigated);
  const dispose = () => {
    page.off("request", onRequest);
    page.off("requestfinished", finished);
    page.off("requestfailed", failed);
    page.off("framenavigated", navigated);
    listeners.clear();
  };
  page.once("close", dispose);
  return {
    state: () => ({
      documentId,
      pendingRequests: requests.size,
      network:
        requests.size > 0 ? ("busy" as const) : complete ? ("idle" as const) : ("unknown" as const),
    }),
    changed: (timeoutMs: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          listeners.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        listeners.add(done);
      }),
  };
};

export const attachNetworkTracker = (page: Page) => {
  let tracker = trackers.get(page);
  if (!tracker) {
    tracker = makeTracker(page);
    trackers.set(page, tracker);
  }
  return tracker;
};
