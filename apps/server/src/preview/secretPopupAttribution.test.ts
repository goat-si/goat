import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect } from "vite-plus/test";
import {
  attributeSecretFill,
  PopupAttribution,
  targetIdOf,
  watchOpenings,
} from "./agentTabState.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("a person takeover while a secret reply is held cannot attribute a later popup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (b) => Effect.promise(() => b.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const control = new SessionControl("agent");
      const popups = new PopupAttribution();
      const tab = { control, popups, agentOperating: false };
      yield* Effect.promise(() => watchOpenings(cdp, tab, () => 1));
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(release).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const runSignal = (yield* Effect.sync(() => new AbortController())).signal;
      const fill = attributeSecretFill(
        tab,
        { agentId: "agent", runSignal },
        () => 1,
        async () => {
          await cdp.send("Runtime.evaluate", { expression: "1" });
          Deferred.doneUnsafe(entered, Effect.void);
          await latch.promise;
        },
      );
      yield* Deferred.await(entered);
      yield* Effect.promise(() => control.take("person"));
      yield* Effect.promise(() => control.release("person"));
      yield* Deferred.succeed(release, undefined);
      yield* Effect.promise(() => fill);
      const popupReady = page.waitForEvent("popup");
      yield* Effect.promise(() => page.evaluate("window.open('about:blank')"));
      const popup = yield* Effect.promise(() => popupReady);
      const id = yield* Effect.promise(() => targetIdOf(popup));
      expect(popups.opening(id)?.runSignal).toBeUndefined();
    }),
  ),
);

it.effect("a popup opened during a secret fill keeps the originating run signal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (b) => Effect.promise(() => b.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const control = new SessionControl("agent");
      const popups = new PopupAttribution();
      const tab = { control, popups, agentOperating: false };
      yield* Effect.promise(() => watchOpenings(cdp, tab, () => 1));
      const release = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(release).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const runSignal = (yield* Effect.sync(() => new AbortController())).signal;
      const popupReady = page.waitForEvent("popup");
      const fill = attributeSecretFill(
        tab,
        { agentId: "agent", runSignal },
        () => 1,
        async () => {
          await cdp.send("Runtime.evaluate", { expression: "window.open('about:blank')" });
          await latch.promise;
        },
      );
      const popup = yield* Effect.promise(() => popupReady);
      const id = yield* Effect.promise(() => targetIdOf(popup));
      expect(popups.opening(id)?.runSignal).toBe(runSignal);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.promise(() => fill);
    }),
  ),
);
