import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { makeCodexTurnStartGuard } from "./CodexTurnStartGuard.ts";
import { makeCodexThreadStatuses } from "./codexThreadStatuses.ts";

interface Turn {
  readonly nativeTurnId: string;
  readonly nativeStartReady: Deferred.Deferred<void>;
  readonly subagent: null;
  readonly input: { readonly attemptId: string };
  readonly providerThread: { readonly nativeThreadRef: { readonly nativeId: string } };
}

const guardFor = (active: Map<string, Turn>) =>
  makeCodexTurnStartGuard<Turn, string>({
    client: {} as never,
    statuses: makeCodexThreadStatuses(),
    activeTurns: Effect.sync(() => active),
    stopped: () => false,
    abandoned: () => false,
    settle: () => Effect.void,
    fail: (detail) => Effect.fail(detail),
  });

describe("CodexTurnStartGuard steer target", () => {
  it.effect(
    "fails clearly when the turn a steer waited for was settled without starting (H3)",
    () =>
      Effect.gen(function* () {
        const context = {
          nativeTurnId: "queued-turn",
          nativeStartReady: yield* Deferred.make<void>(),
          subagent: null,
          input: { attemptId: "attempt" },
          providerThread: { nativeThreadRef: { nativeId: "thread" } },
        };
        const active = new Map([[context.nativeTurnId, context]]);
        const waiting = yield* guardFor(active)
          .awaitSteerable(context)
          .pipe(Effect.flip, Effect.forkScoped);
        // A Stop settles the queued turn locally: it leaves the active turns and its start resolves.
        active.delete(context.nativeTurnId);
        yield* Deferred.succeed(context.nativeStartReady, undefined);
        assert.equal(
          yield* Fiber.join(waiting),
          "This turn has already ended, so the message could not be steered.",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("names a turn only once Codex started it and still runs it", () =>
    Effect.gen(function* () {
      const context: Turn = {
        nativeTurnId: "turn",
        nativeStartReady: yield* Deferred.make<void>(),
        subagent: null,
        input: { attemptId: "attempt" },
        providerThread: { nativeThreadRef: { nativeId: "thread" } },
      };
      const steerable = yield* guardFor(new Map([[context.nativeTurnId, context]]))
        .awaitSteerable(context)
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.succeed(context.nativeStartReady, undefined);
      yield* Fiber.join(steerable);
    }).pipe(Effect.scoped),
  );
});
