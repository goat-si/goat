import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { CDPSession, Page } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import { testActionChannel } from "./actionChannel.testkit.ts";
import { makeActionChannel } from "./actionChannel.ts";
import { guardedHistoryNavigation } from "./ServerBrowserHistory.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("a fence during history admission prevents navigation dispatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const page = { waitForNavigation: async () => null } as unknown as Page;
      const send = vi.fn(async (method: string) =>
        method === "Page.getNavigationHistory"
          ? {
              currentIndex: 1,
              entries: [
                { id: 1, url: "https://allowed.test/" },
                { id: 2, url: "https://allowed.test/current" },
              ],
            }
          : {},
      );
      const cdp = { send } as unknown as CDPSession;
      const control = new SessionControl("agent");
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const action = control.agent("agent", (signal) =>
        guardedHistoryNavigation({
          tab: { page, cdp, control },
          operation: "back",
          agentSessionId: "agent",
          reload: {},
          timeoutMs: 5000,
          recordAction: (_tab, _action, run) => run(),
          status: async () => ({}),
          assertDestination: async () => {
            Deferred.doneUnsafe(entered, Effect.void);
            await latch.promise;
          },
          channelFor: () => testActionChannel(page, cdp, signal),
        }),
      );
      void action.catch(() => undefined);
      yield* Deferred.await(entered);
      control.cutBlockedUrl();
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Effect.promise(() =>
        action.then(
          () => null,
          (error: unknown) => error,
        ),
      );
      yield* Effect.promise(() => control.system(async () => {}));
      expect(result).toMatchObject({ reason: "blocked_url" });
      expect(
        send.mock.calls.filter(([method]) => method === "Page.navigateToHistoryEntry"),
      ).toEqual([]);
    }),
  ),
);

it.effect("a destination blocked during history admission receives no navigation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const page = { waitForNavigation: async () => null } as unknown as Page;
      const send = vi.fn(async (method: string) =>
        method === "Page.getNavigationHistory"
          ? {
              currentIndex: 1,
              entries: [
                { id: 1, url: "https://target.test/" },
                { id: 2, url: "https://allowed.test/current" },
              ],
            }
          : {},
      );
      const cdp = { send } as unknown as CDPSession;
      const control = new SessionControl("agent");
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      let blocked = false;
      const action = control.agent("agent", (signal) =>
        guardedHistoryNavigation({
          tab: { page, cdp, control },
          operation: "back",
          agentSessionId: "agent",
          reload: {},
          timeoutMs: 5000,
          recordAction: (_tab, _action, run) => run(),
          status: async () => ({}),
          assertDestination: async () => {
            Deferred.doneUnsafe(entered, Effect.void);
            await latch.promise;
          },
          channelFor: () =>
            makeActionChannel({
              page,
              cdp,
              signal,
              controlGeneration: () => {},
              isFenced: () => false,
              blockedFrame: () => blocked,
            }),
        }),
      );
      void action.catch(() => undefined);
      yield* Deferred.await(entered);
      blocked = true;
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Effect.promise(() =>
        action.then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(result).toMatchObject({ reason: "blocked_url" });
      expect(
        send.mock.calls.filter(([method]) => method === "Page.navigateToHistoryEntry"),
      ).toEqual([]);
    }),
  ),
);
