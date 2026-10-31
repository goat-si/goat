import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { makeComputerUseHistory } from "../cua/ComputerUseHistory.ts";
import { makeBrowserHistoryRecordAction } from "./BrowserHistoryRecordAction.ts";

it.effect.each(["scope", "timeout"] as const)(
  "does not write after %s ends the owner work",
  (ending) =>
    Effect.scoped(
      Effect.gen(function* () {
        const history = yield* makeComputerUseHistory;
        const owner = yield* Scope.make();
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<"written" | "interrupted">();
        const guarded = {
          ...history,
          record: (_input: Parameters<typeof history.record>[0]) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.onInterrupt(() => Deferred.succeed(finished, "interrupted")),
              Effect.tap(() => Deferred.succeed(finished, "written")),
              Effect.asVoid,
            ),
        };
        const queue = yield* Queue.unbounded<Effect.Effect<void>>();
        yield* Queue.take(queue).pipe(
          Effect.flatMap((effect) => effect),
          Effect.forever,
          Effect.forkScoped,
        );
        const fork = (effect: Effect.Effect<void>) => {
          Queue.offerUnsafe(queue, effect);
        };
        const record = makeBrowserHistoryRecordAction(guarded, fork, owner);
        const tab = {
          threadId: `thread:scope:${ending}`,
          page: { url: () => "https://example.test" },
          actionTimeline: [],
          diagnostics: { firstLine: (cause: unknown) => String(cause) },
        };
        assert.equal(
          yield* Effect.promise(() => record(tab, "click", async () => "clicked")),
          "clicked",
        );
        yield* Deferred.await(started);
        if (ending === "scope") yield* Scope.close(owner, Exit.void);
        else yield* TestClock.adjust("6 seconds");
        yield* Deferred.succeed(gate, undefined);
        assert.equal(yield* Deferred.await(finished), "interrupted");
        if (ending === "timeout") yield* Scope.close(owner, Exit.void);
      }),
    ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
