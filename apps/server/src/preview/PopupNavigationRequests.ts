import type { BrowserContext, Page, Request } from "playwright-core";
import type { BlockedTabRun } from "./blockedTabFence.ts";

interface Visit {
  readonly url: string;
  readonly runs: ReadonlyMap<string, BlockedTabRun>;
}

/** Holds popup navigation requests until Playwright creates their page and exposes their frame. */
export class PopupNavigationRequests {
  private readonly contexts = new WeakSet<BrowserContext>();
  private readonly pages = new WeakMap<Page, Visit[]>();
  private readonly tracked = new WeakSet<Page>();
  private readonly currentRuns: (context: BrowserContext) => ReadonlyMap<string, BlockedTabRun>;
  private readonly onUntracked: (context: BrowserContext, visit: Visit) => void;

  constructor(
    currentRuns: (context: BrowserContext) => ReadonlyMap<string, BlockedTabRun>,
    onUntracked: (context: BrowserContext, visit: Visit) => void,
  ) {
    this.currentRuns = currentRuns;
    this.onUntracked = onUntracked;
  }

  watch(context: BrowserContext) {
    if (this.contexts.has(context)) return;
    this.contexts.add(context);
    const pending = new Map<Request, Visit>();
    context.on("request", (request) => {
      if (!request.isNavigationRequest()) return;
      try {
        const page = request.frame().page();
        if (!this.tracked.has(page)) {
          const visits = this.pages.get(page) ?? [];
          const visit = { url: request.url(), runs: this.currentRuns(context) };
          visits.push(visit);
          this.onUntracked(context, visit);
          this.pages.set(page, visits);
        }
      } catch {
        const visit = { url: request.url(), runs: this.currentRuns(context) };
        pending.set(request, visit);
        this.onUntracked(context, visit);
      }
    });
    context.on("requestfailed", (request) => {
      for (let hop: Request | null = request; hop; hop = hop.redirectedFrom()) pending.delete(hop);
    });
    context.on("page", (page) => {
      const visits: Visit[] = [];
      for (const [request, visit] of pending) {
        try {
          if (request.frame().page() !== page) continue;
          visits.push(visit);
          pending.delete(request);
        } catch {
          // Another popup has not exposed its frame yet.
        }
      }
      if (visits.length > 0) this.pages.set(page, [...(this.pages.get(page) ?? []), ...visits]);
    });
  }

  take(page: Page) {
    const visits = this.pages.get(page) ?? [];
    this.pages.delete(page);
    return visits;
  }

  track(page: Page) {
    this.tracked.add(page);
  }
}
