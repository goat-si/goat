import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  type BrowserStabilityTracker,
  isStabilityNoise,
  makeBrowserStabilityTracker,
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
