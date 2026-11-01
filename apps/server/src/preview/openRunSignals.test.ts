import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import type { CDPSession } from "playwright-core";
import { recordCopies } from "./ServerBrowserClipboard.ts";
import { expect } from "vite-plus/test";
import { makeOpenRunSignals } from "./openRunSignals.ts";

it.effect("ending one concurrent open retains the other's run cancellation", () =>
  Effect.gen(function* () {
    const registry = makeOpenRunSignals();
    const controller = yield* Effect.sync(() => new AbortController());
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const a = registry.track("thread", "agent", controller.signal, () => first.promise);
    const b = registry.track("thread", "agent", controller.signal, () => second.promise);
    first.resolve();
    yield* Effect.promise(() => a);
    controller.abort();
    expect(registry.signal("thread", "agent")?.aborted).toBe(true);
    second.resolve();
    yield* Effect.promise(() => b);
    expect(registry.signal("thread", "agent")).toBeUndefined();
  }),
);

it.effect("run end during new-tab setup prevents later page script installation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* Effect.sync(() => new AbortController());
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(release).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const sent: string[] = [];
      const session = {
        send: async (method: string) => {
          sent.push(method);
          if (method === "Page.enable") {
            Deferred.doneUnsafe(entered, Effect.void);
            await latch.promise;
          }
          return {};
        },
      } as unknown as CDPSession;
      const work = recordCopies(session, controller.signal);
      void work.catch(() => undefined);
      yield* Deferred.await(entered);
      controller.abort(new Error("run ended"));
      yield* Deferred.succeed(release, undefined);
      const result = yield* Effect.promise(() =>
        work.then(
          () => null,
          (cause: unknown) => cause,
        ),
      );
      expect(result).toBeInstanceOf(Error);
      expect(sent).toEqual(["Page.enable"]);
    }),
  ),
);

it.effect("a synchronous open failure releases its run registration", () =>
  Effect.sync(() => {
    const registry = makeOpenRunSignals();
    const controller = new AbortController();
    expect(() =>
      registry.track("thread", "agent", controller.signal, () => {
        throw new Error("open failed");
      }),
    ).toThrow("open failed");
    expect(registry.signal("thread", "agent")).toBeUndefined();
  }),
);
