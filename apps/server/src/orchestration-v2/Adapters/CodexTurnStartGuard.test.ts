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

const guardFor = (active: Map<string, Turn>, statuses = makeCodexThreadStatuses()) =>
  makeCodexTurnStartGuard<Turn, string>({
    // Any request to Codex fails the test: these starts must be refused before sending.
    client: {} as never,
    statuses,
    activeTurns: Effect.sync(() => active),
    stopped: () => false,
    abandoned: () => false,
    settle: () => Effect.void,
    fail: (detail) => Effect.fail(detail),
  });
const root = (nativeTurnId: string) =>
  Effect.map(Deferred.make<void>(), (nativeStartReady) => ({
    nativeTurnId,
    nativeStartReady,
    subagent: null,
    input: { attemptId: "earlier" },
    providerThread: { nativeThreadRef: { nativeId: "thread" } },
  }));

describe("CodexTurnStartGuard admission", () => {
  it.effect("a tracked root does not hide a turn Codex runs that no run owns", () =>
    Effect.gen(function* () {
      const statuses = makeCodexThreadStatuses();
      // A failed turn waits for its retry while Codex starts a turn of its own.
      statuses.turnStarted("thread", "failed-turn");
      statuses.turnCompleted("thread", "failed-turn");
      statuses.record("thread", "active");
      statuses.turnStarted("thread", "codex-turn");
      const failed = yield* root("failed-turn");
      const guard = guardFor(new Map([[failed.nativeTurnId, failed]]), statuses);
      const error = yield* guard.prepare("thread", false).pipe(Effect.flip);
      assert.include(error, "GOAT did not start");
      // The same holds before Codex names its turn.
      const unnamed = makeCodexThreadStatuses();
      unnamed.turnStarted("thread", "failed-turn");
      unnamed.turnCompleted("thread", "failed-turn");
      unnamed.record("thread", "idle");
      unnamed.record("thread", "active");
      const retry = guardFor(new Map([[failed.nativeTurnId, failed]]), unnamed);
      assert.include(yield* retry.prepare("thread", false).pipe(Effect.flip), "GOAT did not start");
    }),
  );

  it.effect.each([
    { case: "no turn seen before", seen: false },
    { case: "GOAT saw a turn end before it unloaded the thread", seen: true },
  ])("refuses a thread a resume reports active when GOAT saw no turn start ($case)", ({ seen }) =>
    Effect.gen(function* () {
      const statuses = makeCodexThreadStatuses();
      if (seen) {
        statuses.turnStarted("thread", "old-turn");
        statuses.turnCompleted("thread", "old-turn");
        statuses.record("thread", "idle");
        statuses.forget("thread");
      }
      statuses.record("thread", "active");
      const error = yield* guardFor(new Map(), statuses).prepare("thread", true).pipe(Effect.flip);
      assert.include(error, "GOAT did not start");
    }),
  );

  it.effect("refuses while Codex is busy again with a turn it has not reported starting", () =>
    Effect.gen(function* () {
      const statuses = makeCodexThreadStatuses();
      const guard = guardFor(new Map(), statuses);
      statuses.record("thread", "active");
      statuses.turnStarted("thread", "turn-a");
      statuses.turnCompleted("thread", "turn-a");
      statuses.record("thread", "idle");
      statuses.record("thread", "active");
      assert.include(yield* guard.prepare("thread", true).pipe(Effect.flip), "GOAT did not start");
      // Once Codex names the turn, an ordinary start may steer into it.
      statuses.turnStarted("thread", "turn-b");
      yield* guard.prepare("thread", true);
    }),
  );
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
