/**
 * Page stability from CDP network and DOM events: a page is settled once no relevant request is
 * in flight and nothing relevant happened for a quiet window. Noise filtering follows browser-use's
 * DOMWatchdog._get_pending_network_requests (browser_use/browser/watchdogs/dom_watchdog.py).
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  type CleanMarkdown,
  type CleanMarkdownOptions,
  extractCleanMarkdown,
} from "./BrowserCleanMarkdown.ts";

export interface StabilityRequest {
  readonly requestId: string;
  readonly url: string;
  /** CDP Network.ResourceType, such as "Document", "XHR", "WebSocket" or "EventSource". */
  readonly resourceType?: string | undefined;
}

export type StabilityOutcome =
  | { readonly settled: true; readonly pendingCount: 0 }
  | {
      readonly settled: false;
      readonly reason: "timeout" | "detached";
      readonly pendingCount: number;
    };

export interface StabilityWait {
  readonly quietMs: number;
  readonly timeoutMs: number;
}

export interface BrowserStabilityTracker {
  readonly onRequestStarted: (request: StabilityRequest) => Effect.Effect<void>;
  readonly onRequestFinished: (requestId: string) => Effect.Effect<void>;
  readonly onRequestFailed: (requestId: string) => Effect.Effect<void>;
  readonly onDomMutation: () => Effect.Effect<void>;
  readonly onTargetDetached: () => Effect.Effect<void>;
  readonly pendingCount: Effect.Effect<number>;
  readonly waitForStability: (wait: StabilityWait) => Effect.Effect<StabilityOutcome>;
}

const NOISE_RESOURCE_TYPES: ReadonlySet<string> = new Set(["websocket", "eventsource", "ping"]);
const NOISE_SCHEMES: ReadonlySet<string> = new Set([
  "data:",
  "blob:",
  "about:",
  "chrome-extension:",
  "moz-extension:",
  "ws:",
  "wss:",
]);
const NOISE_HOST_SUFFIXES: readonly string[] = [
  "doubleclick.net",
  "googlesyndication.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googleadservices.com",
  "adservice.google.com",
  "facebook.net",
  "hotjar.com",
  "segment.io",
  "mixpanel.com",
  "clarity.ms",
  "amazon-adsystem.com",
];

/** Requests that never finish (streams) or never change the page (ads, analytics, beacons). */
export const isStabilityNoise = (request: Omit<StabilityRequest, "requestId">): boolean => {
  if (
    request.resourceType !== undefined &&
    NOISE_RESOURCE_TYPES.has(request.resourceType.toLowerCase())
  )
    return true;
  const url = URL.parse(request.url);
  if (url === null) return false;
  if (NOISE_SCHEMES.has(url.protocol)) return true;
  const host = url.hostname.toLowerCase();
  return NOISE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

interface TrackerState {
  readonly pending: ReadonlySet<string>;
  readonly lastActivityMillis: number;
  readonly detached: boolean;
  /** Fired and replaced on every change, so a waiter holding an older one always wakes. */
  readonly wake: Deferred.Deferred<void>;
}

type StateChange = (state: TrackerState, now: number) => Omit<TrackerState, "wake"> | undefined;

export const makeBrowserStabilityTracker: Effect.Effect<BrowserStabilityTracker> = Effect.gen(
  function* () {
    const state = yield* Ref.make<TrackerState>({
      pending: new Set(),
      lastActivityMillis: yield* Clock.currentTimeMillis,
      detached: false,
      wake: yield* Deferred.make<void>(),
    });

    // Per-event callbacks run for every CDP event, so they carry no span of their own.
    // Swap and fire stay one uninterruptible step: an interrupted swap would strand waiters.
    const change = (apply: StateChange): Effect.Effect<void> =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.uninterruptible(
          Effect.flatMap(
            Ref.modify(
              state,
              (current): readonly [Deferred.Deferred<void> | undefined, TrackerState] => {
                const next = apply(current, now);
                if (next === undefined) return [undefined, current];
                return [current.wake, { ...next, wake: Deferred.makeUnsafe<void>() }];
              },
            ),
            (fired) => (fired === undefined ? Effect.void : Deferred.succeed(fired, undefined)),
          ),
        ),
      );

    const settle = (requestId: string) =>
      change((current, now) => {
        if (current.detached || !current.pending.has(requestId)) return undefined;
        const pending = new Set(current.pending);
        pending.delete(requestId);
        return {
          ...current,
          pending,
          lastActivityMillis: Math.max(current.lastActivityMillis, now),
        };
      });

    const outcomeOf = (
      current: TrackerState,
      reason: "timeout" | "detached",
    ): StabilityOutcome => ({
      settled: false,
      reason: current.detached ? "detached" : reason,
      pendingCount: current.pending.size,
    });

    // Runs only inside the waitForStability span, so it carries none of its own.
    const settleLoop = Effect.fnUntraced(function* (
      quietMs: number,
    ): Effect.fn.Return<StabilityOutcome> {
      while (true) {
        // The clock is read before the snapshot: a later event can only lengthen the wait.
        const now = yield* Clock.currentTimeMillis;
        const current = yield* Ref.get(state);
        if (current.detached) return outcomeOf(current, "detached");
        if (current.pending.size > 0) {
          yield* Deferred.await(current.wake);
          continue;
        }
        const remaining = current.lastActivityMillis + quietMs - now;
        if (remaining <= 0) return { settled: true, pendingCount: 0 };
        yield* Effect.raceFirst(
          Deferred.await(current.wake),
          Effect.sleep(Duration.millis(remaining)),
        );
      }
    });

    const waitForStability = Effect.fn("BrowserStabilityTracker.waitForStability")(function* (
      wait: StabilityWait,
    ) {
      const settled = yield* settleLoop(Math.max(0, wait.quietMs)).pipe(
        Effect.timeoutOption(Duration.millis(Math.max(0, wait.timeoutMs))),
      );
      if (Option.isSome(settled)) return settled.value;
      return outcomeOf(yield* Ref.get(state), "timeout");
    });

    return {
      onRequestStarted: (request) =>
        isStabilityNoise(request)
          ? Effect.void
          : change((current, now) =>
              current.detached
                ? undefined
                : {
                    ...current,
                    pending: new Set(current.pending).add(request.requestId),
                    lastActivityMillis: Math.max(current.lastActivityMillis, now),
                  },
            ),
      onRequestFinished: settle,
      onRequestFailed: settle,
      onDomMutation: () =>
        change((current, now) =>
          current.detached
            ? undefined
            : { ...current, lastActivityMillis: Math.max(current.lastActivityMillis, now) },
        ),
      onTargetDetached: () =>
        change((current) => (current.detached ? undefined : { ...current, detached: true })),
      pendingCount: Effect.map(Ref.get(state), (current) => current.pending.size),
      waitForStability,
    } satisfies BrowserStabilityTracker;
  },
);

const STABILITY_CDP_EVENTS = [
  "Network.requestWillBeSent",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Page.frameNavigated",
  "Page.lifecycleEvent",
  "DOM.documentUpdated",
  "DOM.setChildNodes",
  "DOM.childNodeInserted",
  "DOM.childNodeRemoved",
  "DOM.childNodeCountUpdated",
  "DOM.attributeModified",
  "DOM.attributeRemoved",
  "DOM.characterDataModified",
  "DOM.shadowRootPushed",
  "DOM.shadowRootPopped",
  "Inspector.detached",
  "Inspector.targetCrashed",
] as const;
type StabilityCdpEvent = (typeof STABILITY_CDP_EVENTS)[number];
type StabilityCdpCommand =
  | "Network.enable"
  | "Page.enable"
  | "Page.setLifecycleEventsEnabled"
  | "DOM.enable"
  | "DOM.getDocument"
  | "Inspector.enable";

/** The part of a CDP session the bridge uses; playwright's CDPSession satisfies it. */
export interface StabilityCdpSession {
  on(event: StabilityCdpEvent, listener: (params: unknown) => void): unknown;
  off(event: StabilityCdpEvent, listener: (params: unknown) => void): unknown;
  send(method: StabilityCdpCommand, params?: object): Promise<unknown>;
}

const DOM_ACTIVITY: ReadonlySet<string> = new Set(
  STABILITY_CDP_EVENTS.filter((event) => event.startsWith("DOM.") || event.startsWith("Page.")),
);

const stringField = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
};

const applyCdpEvent = (
  tracker: BrowserStabilityTracker,
  event: StabilityCdpEvent,
  params: unknown,
): Effect.Effect<void> => {
  // Inspector.targetCrashed carries no params, so it is matched before any field is read.
  if (event === "Inspector.detached" || event === "Inspector.targetCrashed")
    return tracker.onTargetDetached();
  if (DOM_ACTIVITY.has(event)) return tracker.onDomMutation();
  const requestId = stringField(params, "requestId");
  if (requestId === undefined) return Effect.void;
  if (event === "Network.loadingFinished") return tracker.onRequestFinished(requestId);
  if (event === "Network.loadingFailed") return tracker.onRequestFailed(requestId);
  const url =
    typeof params === "object" && params !== null && "request" in params
      ? stringField(params.request, "url")
      : undefined;
  return url === undefined
    ? Effect.void
    : tracker.onRequestStarted({ requestId, url, resourceType: stringField(params, "type") });
};

const DOM_DOCUMENT_URL = "goat:dom-document";

/**
 * Feeds a page's CDP events to the tracker for the scope's lifetime. DOM mutation events only
 * cover nodes the client has requested, so each document is fetched whole, and settling waits
 * for that fetch. A command the session rejects marks the target detached.
 */
export const attachStabilityTracker = Effect.fn("BrowserStabilityTracker.attach")(function* (
  cdp: StabilityCdpSession,
  tracker: BrowserStabilityTracker,
) {
  // Tracker changes are synchronous, so running them inline keeps the CDP event order.
  const runSync = Effect.runSyncWith(yield* Effect.context<never>());
  let closed = false;
  let documents = 0;
  const apply = (effect: Effect.Effect<void>) => {
    if (!closed) runSync(effect);
  };
  const detach = () => apply(tracker.onTargetDetached());
  const fetchDocument = () => {
    documents += 1;
    const requestId = DOM_DOCUMENT_URL + ":" + String(documents);
    apply(tracker.onRequestStarted({ requestId, url: DOM_DOCUMENT_URL }));
    void cdp
      .send("DOM.getDocument", { depth: -1, pierce: true })
      .then(() => apply(tracker.onRequestFinished(requestId)), detach);
  };
  const listeners = STABILITY_CDP_EVENTS.map((event) => {
    const listener = (params: unknown) => {
      apply(applyCdpEvent(tracker, event, params));
      if (event === "DOM.documentUpdated" && !closed) fetchDocument();
    };
    return [event, listener] as const;
  });
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      for (const [event, listener] of listeners) cdp.on(event, listener);
    }),
    () =>
      Effect.sync(() => {
        closed = true;
        for (const [event, listener] of listeners) cdp.off(event, listener);
      }),
  );
  yield* Effect.promise(() =>
    Promise.all(
      [
        cdp.send("Network.enable"),
        cdp.send("Page.enable"),
        cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }),
        cdp.send("DOM.enable"),
        cdp.send("Inspector.enable"),
      ].map((sent) => sent.then(undefined, detach)),
    ),
  );
  if (!closed) fetchDocument();
});

export interface StableMarkdownRead {
  readonly stability: StabilityOutcome;
  /** Undefined only when the target detached; after a timeout the page may still be partial. */
  readonly content: CleanMarkdown | undefined;
}

/** Waits for network and DOM quiet, then reads the page HTML and cleans it to markdown. */
export const readCleanMarkdownWhenStable = Effect.fn(
  "BrowserStabilityTracker.readCleanMarkdownWhenStable",
)(function* <E, R>(
  tracker: BrowserStabilityTracker,
  read: {
    readonly wait: StabilityWait;
    readonly html: Effect.Effect<string, E, R>;
    readonly options?: CleanMarkdownOptions;
  },
): Effect.fn.Return<StableMarkdownRead, E, R> {
  const stability = yield* tracker.waitForStability(read.wait);
  if (!stability.settled && stability.reason === "detached")
    return { stability, content: undefined };
  const html = yield* read.html;
  return { stability, content: extractCleanMarkdown(html, read.options) };
});
