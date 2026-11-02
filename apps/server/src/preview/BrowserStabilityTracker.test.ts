import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  attachStabilityTracker,
  type BrowserStabilityTracker,
  isStabilityNoise,
  makeBrowserStabilityTracker,
  readCleanMarkdownWhenStable,
  type StabilityCdpSession,
  type StabilityWait,
} from "./BrowserStabilityTracker.ts";

const settled = { settled: true, pendingCount: 0 } as const;
const xhr = (requestId: string, url = "https://example.com/api") => ({
  requestId,
  url,
  resourceType: "XHR",
});
const waiter = (tracker: BrowserStabilityTracker, wait: StabilityWait) =>
  tracker.waitForStability(wait).pipe(Effect.forkChild({ startImmediately: true }));
const quiet = { quietMs: 500, timeoutMs: 10_000 };

describe("BrowserStabilityTracker", () => {
  it.effect("settles only once nothing happened for the quiet window", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      const fiber = yield* waiter(tracker, quiet);
      yield* TestClock.adjust("499 millis");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(yield* Fiber.join(fiber), settled);
    }),
  );

  it.effect("a request in flight holds the page until it finishes and the window passes", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      yield* tracker.onRequestStarted(xhr("1"));
      const fiber = yield* waiter(tracker, quiet);
      yield* TestClock.adjust("3 seconds");
      assert.isUndefined(fiber.pollUnsafe());
      assert.strictEqual(yield* tracker.pendingCount, 1);
      yield* tracker.onRequestFinished("1");
      yield* TestClock.adjust("499 millis");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(yield* Fiber.join(fiber), settled);
    }),
  );

  it.effect("a failed request releases the page like a finished one", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      yield* tracker.onRequestStarted(xhr("1"));
      const fiber = yield* waiter(tracker, quiet);
      yield* tracker.onRequestFailed("1");
      yield* TestClock.adjust("500 millis");
      assert.deepStrictEqual(yield* Fiber.join(fiber), settled);
    }),
  );

  it.effect("a DOM mutation just before the quiet boundary restarts the window", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      const fiber = yield* waiter(tracker, quiet);
      yield* TestClock.adjust("499 millis");
      yield* tracker.onDomMutation();
      yield* TestClock.adjust("499 millis");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(yield* Fiber.join(fiber), settled);
    }),
  );

  it.effect("streams, inline URLs and ad or analytics hosts never hold the page", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      yield* tracker.onRequestStarted({
        requestId: "ws",
        url: "wss://example.com/live",
        resourceType: "WebSocket",
      });
      yield* tracker.onRequestStarted({
        requestId: "sse",
        url: "https://example.com/events",
        resourceType: "EventSource",
      });
      yield* tracker.onRequestStarted(xhr("data", "data:image/png;base64,AAAA"));
      yield* tracker.onRequestStarted(xhr("blob", "blob:https://example.com/0f1e"));
      yield* tracker.onRequestStarted(
        xhr("ad", "https://securepubads.g.doubleclick.net/gampad/ads"),
      );
      yield* tracker.onRequestStarted(xhr("ga", "https://www.google-analytics.com/g/collect"));
      assert.strictEqual(yield* tracker.pendingCount, 0);
      const fiber = yield* waiter(tracker, quiet);
      yield* TestClock.adjust("500 millis");
      assert.deepStrictEqual(yield* Fiber.join(fiber), settled);
    }),
  );

  it("classifies only real noise, not look-alike hosts or unparsable URLs", () => {
    assert.isTrue(isStabilityNoise({ url: "https://www.googletagmanager.com/gtm.js" }));
    assert.isTrue(isStabilityNoise({ url: "https://example.com/beacon", resourceType: "Ping" }));
    assert.isTrue(isStabilityNoise({ url: "https://example.com/s", resourceType: "eventsource" }));
    assert.isFalse(isStabilityNoise({ url: "https://notdoubleclick.net/app.js" }));
    assert.isFalse(isStabilityNoise({ url: "https://doubleclick.net.example.com/app.js" }));
    assert.isFalse(isStabilityNoise({ url: "https://example.com/", resourceType: "Document" }));
    assert.isFalse(isStabilityNoise({ url: "not a url" }));
  });

  it.effect("a redirect that reuses its request id needs one finish", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      yield* tracker.onRequestStarted(xhr("1", "http://example.com/"));
      yield* tracker.onRequestStarted(xhr("1", "https://example.com/"));
      assert.strictEqual(yield* tracker.pendingCount, 1);
      yield* tracker.onRequestFinished("1");
      yield* tracker.onRequestFinished("unknown");
      assert.strictEqual(yield* tracker.pendingCount, 0);
    }),
  );

  it.effect("reports a timeout with the requests still in flight", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      yield* tracker.onRequestStarted(xhr("1"));
      yield* tracker.onRequestStarted(xhr("2"));
      const fiber = yield* waiter(tracker, { quietMs: 500, timeoutMs: 1_000 });
      yield* TestClock.adjust("999 millis");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(yield* Fiber.join(fiber), {
        settled: false,
        reason: "timeout",
        pendingCount: 2,
      });
    }),
  );

  it.effect("detaching the target ends a wait at once, and later waits and events", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      yield* tracker.onRequestStarted(xhr("1"));
      const fiber = yield* waiter(tracker, quiet);
      yield* tracker.onTargetDetached();
      const detached = { settled: false, reason: "detached", pendingCount: 1 } as const;
      assert.deepStrictEqual(yield* Fiber.join(fiber), detached);
      yield* tracker.onRequestStarted(xhr("2"));
      yield* tracker.onRequestFinished("1");
      assert.deepStrictEqual(yield* tracker.waitForStability(quiet), detached);
    }),
  );

  it.effect("concurrent waiters settle together and one interrupted waiter leaves the other", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      yield* tracker.onRequestStarted(xhr("1"));
      const first = yield* waiter(tracker, quiet);
      const second = yield* waiter(tracker, quiet);
      const third = yield* waiter(tracker, quiet);
      yield* Fiber.interrupt(first);
      yield* tracker.onRequestFinished("1");
      yield* TestClock.adjust("500 millis");
      assert.deepStrictEqual(yield* Fiber.join(second), settled);
      assert.deepStrictEqual(yield* Fiber.join(third), settled);
      assert.strictEqual(first.pollUnsafe()?._tag, "Failure");
    }),
  );

  it.effect("zero windows answer from the current state without waiting", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      assert.deepStrictEqual(
        yield* tracker.waitForStability({ quietMs: 0, timeoutMs: 1_000 }),
        settled,
      );
      assert.deepStrictEqual(
        yield* tracker.waitForStability({ quietMs: 0, timeoutMs: 0 }),
        settled,
      );
      assert.deepStrictEqual(yield* tracker.waitForStability({ quietMs: 500, timeoutMs: 0 }), {
        settled: false,
        reason: "timeout",
        pendingCount: 0,
      });
      yield* TestClock.adjust("500 millis");
      assert.deepStrictEqual(
        yield* tracker.waitForStability({ quietMs: 500, timeoutMs: 0 }),
        settled,
      );
      yield* tracker.onTargetDetached();
      assert.deepStrictEqual(yield* tracker.waitForStability({ quietMs: 0, timeoutMs: 0 }), {
        settled: false,
        reason: "detached",
        pendingCount: 0,
      });
    }),
  );
});

interface HeldReply {
  readonly promise: Promise<unknown>;
  readonly resolve: () => void;
  readonly reject: () => void;
}

const heldReply = (): HeldReply => {
  let resolve = () => {};
  let reject = () => {};
  const promise = new Promise<unknown>((done, fail) => {
    resolve = () => done({});
    reject = () => fail(new Error("Target closed"));
  });
  return { promise, resolve, reject };
};

/** A CDP session double: events are emitted by hand, DOM.getDocument replies can be held. */
const fakeSession = (options: { holdDocuments?: boolean; reject?: string } = {}) => {
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  const documents: Array<HeldReply> = [];
  const session: StabilityCdpSession = {
    on: (event, listener) => {
      const registered = listeners.get(event) ?? new Set();
      registered.add(listener);
      listeners.set(event, registered);
    },
    off: (event, listener) => listeners.get(event)?.delete(listener),
    send: (method) => {
      if (method === options.reject) return Promise.reject(new Error("Target closed"));
      if (method !== "DOM.getDocument") return Promise.resolve({});
      const reply = heldReply();
      if (!options.holdDocuments) reply.resolve();
      documents.push(reply);
      return reply.promise;
    },
  };
  const emit = (event: string, params?: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(params);
  };
  /** Resolves after the bridge's own handler for that reply has run. */
  const replied = (index: number) =>
    Effect.promise(() => documents[index]?.promise.catch(() => undefined) ?? Promise.resolve());
  return { session, emit, documents, replied };
};

const requestWillBeSent = (requestId: string, url: string, type = "XHR") => ({
  requestId,
  request: { url },
  type,
});

describe("attachStabilityTracker", () => {
  it.effect("CDP requests hold the page until they finish; streams never do", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tracker = yield* makeBrowserStabilityTracker;
        const cdp = fakeSession();
        yield* attachStabilityTracker(cdp.session, tracker);
        yield* cdp.replied(0);
        cdp.emit("Network.requestWillBeSent", requestWillBeSent("1", "https://example.com/api"));
        cdp.emit(
          "Network.requestWillBeSent",
          requestWillBeSent("ws", "https://example.com/live", "WebSocket"),
        );
        const fiber = yield* waiter(tracker, quiet);
        yield* TestClock.adjust("3 seconds");
        assert.isUndefined(fiber.pollUnsafe());
        assert.strictEqual(yield* tracker.pendingCount, 1);
        cdp.emit("Network.loadingFinished", { requestId: "1" });
        yield* TestClock.adjust("499 millis");
        assert.isUndefined(fiber.pollUnsafe());
        yield* TestClock.adjust("1 millis");
        assert.deepStrictEqual(yield* Fiber.join(fiber), settled);
      }),
    ),
  );

  it.effect("a DOM mutation event restarts the quiet window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tracker = yield* makeBrowserStabilityTracker;
        const cdp = fakeSession();
        yield* attachStabilityTracker(cdp.session, tracker);
        yield* cdp.replied(0);
        const fiber = yield* waiter(tracker, quiet);
        yield* TestClock.adjust("499 millis");
        cdp.emit("DOM.childNodeInserted", { parentNodeId: 1, previousNodeId: 0, node: {} });
        yield* TestClock.adjust("499 millis");
        assert.isUndefined(fiber.pollUnsafe());
        yield* TestClock.adjust("1 millis");
        assert.deepStrictEqual(yield* Fiber.join(fiber), settled);
      }),
    ),
  );

  it.effect("the page does not settle while a new document is still being fetched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tracker = yield* makeBrowserStabilityTracker;
        const cdp = fakeSession({ holdDocuments: true });
        yield* attachStabilityTracker(cdp.session, tracker);
        cdp.documents[0]?.resolve();
        yield* cdp.replied(0);
        cdp.emit("DOM.documentUpdated");
        const fiber = yield* waiter(tracker, quiet);
        yield* TestClock.adjust("2 seconds");
        assert.isUndefined(fiber.pollUnsafe());
        assert.strictEqual(yield* tracker.pendingCount, 1);
        cdp.documents[1]?.resolve();
        yield* cdp.replied(1);
        yield* TestClock.adjust("499 millis");
        assert.isUndefined(fiber.pollUnsafe());
        yield* TestClock.adjust("1 millis");
        assert.deepStrictEqual(yield* Fiber.join(fiber), settled);
      }),
    ),
  );

  it.effect("Inspector.detached and a rejected command both report the target detached", () =>
    Effect.gen(function* () {
      const detached = { settled: false, reason: "detached", pendingCount: 0 } as const;
      const viaEvent = yield* makeBrowserStabilityTracker;
      const cdp = fakeSession();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* attachStabilityTracker(cdp.session, viaEvent);
          yield* cdp.replied(0);
          cdp.emit("Inspector.detached", { reason: "target_closed" });
        }),
      );
      assert.deepStrictEqual(yield* viaEvent.waitForStability(quiet), detached);

      const viaCommand = yield* makeBrowserStabilityTracker;
      yield* Effect.scoped(
        attachStabilityTracker(fakeSession({ reject: "Network.enable" }).session, viaCommand),
      );
      const outcome = yield* viaCommand.waitForStability(quiet);
      assert.strictEqual(outcome.settled ? "settled" : outcome.reason, "detached");
    }),
  );

  it.effect("after the scope closes, events and late replies leave the tracker alone", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      const cdp = fakeSession({ holdDocuments: true });
      yield* Effect.scoped(attachStabilityTracker(cdp.session, tracker));
      cdp.emit("Network.requestWillBeSent", requestWillBeSent("late", "https://example.com/api"));
      cdp.documents[0]?.reject();
      yield* cdp.replied(0);
      assert.strictEqual(yield* tracker.pendingCount, 1);
      const fiber = yield* waiter(tracker, { quietMs: 500, timeoutMs: 1_000 });
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* Fiber.join(fiber), {
        settled: false,
        reason: "timeout",
        pendingCount: 1,
      });
    }),
  );
});

describe("readCleanMarkdownWhenStable", () => {
  const page = (reads: { count: number }) =>
    Effect.sync(() => {
      reads.count += 1;
      return "<h1>Done</h1><script>tracking()</script>";
    });

  it.effect("reads the page only after it settles and returns clean markdown", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      const reads = { count: 0 };
      yield* tracker.onRequestStarted(xhr("1"));
      const fiber = yield* readCleanMarkdownWhenStable(tracker, {
        wait: quiet,
        html: page(reads),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("3 seconds");
      assert.strictEqual(reads.count, 0);
      yield* tracker.onRequestFinished("1");
      yield* TestClock.adjust("500 millis");
      const result = yield* Fiber.join(fiber);
      assert.deepStrictEqual(result.stability, settled);
      assert.strictEqual(result.content?.markdown, "# Done");
      assert.strictEqual(reads.count, 1);
    }),
  );

  it.effect("a timeout still reads and says so; a detached target is never read", () =>
    Effect.gen(function* () {
      const tracker = yield* makeBrowserStabilityTracker;
      const reads = { count: 0 };
      yield* tracker.onRequestStarted(xhr("1"));
      const fiber = yield* readCleanMarkdownWhenStable(tracker, {
        wait: { quietMs: 500, timeoutMs: 1_000 },
        html: page(reads),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("1 second");
      const timedOut = yield* Fiber.join(fiber);
      assert.deepStrictEqual(timedOut.stability, {
        settled: false,
        reason: "timeout",
        pendingCount: 1,
      });
      assert.strictEqual(timedOut.content?.markdown, "# Done");

      yield* tracker.onTargetDetached();
      const detached = yield* readCleanMarkdownWhenStable(tracker, {
        wait: quiet,
        html: page(reads),
      });
      assert.isUndefined(detached.content);
      assert.strictEqual(reads.count, 1);
    }),
  );
});
