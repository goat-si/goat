import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ThreadId } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  backgroundScenarioIds,
  captureRootRunTermination,
  driver,
  rootTerminalEvent,
} from "./RunExecutionService.testkit.ts";

it.effect("interrupts a provider turn that starts after Stop settled its attempt", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const ids = backgroundScenarioIds("turn-after-stop");
    const stopped = yield* Ref.make(false);
    const accepted = yield* Deferred.make<void>();
    const interrupted = yield* Ref.make<ProviderAdapter.ProviderAdapterV2InterruptInput | null>(
      null,
    );
    yield* captureRootRunTermination({
      key: "turn-after-stop",
      initialProviderTurnId: null,
      shouldFinalizeRun: () => Ref.get(stopped).pipe(Effect.map((value) => !value)),
      shouldStartProviderTurn: () => Ref.get(stopped).pipe(Effect.map((value) => !value)),
      startTurn: () =>
        Ref.set(stopped, true).pipe(Effect.andThen(Deferred.succeed(accepted, undefined))),
      events: () =>
        Stream.unwrap(
          Deferred.await(accepted).pipe(
            Effect.as(
              Stream.fromIterable([
                {
                  type: "provider_turn.updated" as const,
                  driver,
                  providerTurn: {
                    id: ids.rootProviderTurnId,
                    providerThreadId: ids.providerThreadId,
                    nodeId: ids.rootNodeId,
                    runAttemptId: ids.attemptId,
                    nativeTurnRef: null,
                    ordinal: 1,
                    status: "running" as const,
                    startedAt: now,
                    completedAt: null,
                  },
                },
                rootTerminalEvent(ids, "interrupted"),
              ]),
            ),
          ),
        ),
      interruptTurn: (input) => Ref.set(interrupted, input),
    });
    const call = yield* Ref.get(interrupted);
    assert.equal(call?.providerTurnId, ids.rootProviderTurnId);
    assert.equal(call?.providerThread.id, ids.providerThreadId);
  }),
);

it.effect("interrupts the turn and fails visibly when ownership cannot be read", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const ids = backgroundScenarioIds("turn-ownership-unreadable");
    const accepted = yield* Ref.make(false);
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Ref.make(false);
    const { observed } = yield* captureRootRunTermination({
      key: "turn-ownership-unreadable",
      initialProviderTurnId: null,
      shouldFinalizeRun: () => Effect.succeed(true),
      shouldStartProviderTurn: () =>
        Ref.get(accepted).pipe(
          Effect.flatMap((value) =>
            value
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId: ThreadId.make("thread:turn-ownership-unreadable"),
                    cause: "database unavailable",
                  }),
                )
              : Effect.succeed(true),
          ),
        ),
      startTurn: () =>
        Ref.set(accepted, true).pipe(Effect.andThen(Deferred.succeed(started, undefined))),
      events: () =>
        Stream.unwrap(
          Deferred.await(started).pipe(
            Effect.as(
              Stream.fromIterable([
                {
                  type: "provider_turn.updated" as const,
                  driver,
                  providerTurn: {
                    id: ids.rootProviderTurnId,
                    providerThreadId: ids.providerThreadId,
                    nodeId: ids.rootNodeId,
                    runAttemptId: ids.attemptId,
                    nativeTurnRef: null,
                    ordinal: 1,
                    status: "running" as const,
                    startedAt: now,
                    completedAt: null,
                  },
                },
                rootTerminalEvent(ids, "interrupted"),
              ]),
            ),
          ),
        ),
      interruptTurn: () => Ref.set(interrupted, true),
    });
    assert.isTrue(yield* Ref.get(interrupted));
    assert.include(observed, "run:failed");
  }),
);
