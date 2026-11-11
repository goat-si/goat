import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { CodexDetachedAppServerError } from "./CodexDetachedAppServer.ts";
import {
  holdLostConnectionTurn,
  LOST_CONNECTION_CHECK_INTERVAL,
} from "./CodexLostConnectionHold.ts";
import type { CodexSurvivors } from "./CodexSurvivors.ts";

const record = { instanceId: ProviderInstanceId.make("codex"), recordName: "codex-kept" };
const stop = { threadId: ThreadId.make("chase"), nativeThreadId: "native", nativeTurnId: "turn" };

const fixture = (initial: { gone: boolean; turn: "running" | "completed" | "unreadable" }) =>
  Effect.gen(function* () {
    const state = { ...initial, held: false };
    const released = yield* Deferred.make<void>();
    const survivors = {
      classifyRecord: () =>
        Effect.sync(() =>
          state.gone ? { type: "gone" as const } : { type: "verified" as const, pgid: 42 },
        ),
      recordStopObligation: () =>
        Effect.sync(() => {
          state.held = true;
        }),
      clearStopObligation: () =>
        Effect.sync(() => {
          state.held = false;
        }).pipe(Effect.andThen(Deferred.succeed(released, undefined)), Effect.asVoid),
      readExistingTurn: () =>
        Effect.suspend(() =>
          state.turn === "unreadable"
            ? Effect.fail(new CodexDetachedAppServerError({ detail: "socket closed" }))
            : Effect.succeed(state.turn),
        ),
    } as unknown as CodexSurvivors["Service"];
    const scope = yield* Scope.Scope;
    const hold = holdLostConnectionTurn({ survivors, record, stop, scope });
    return { state, released, hold };
  });

it.effect("a turn whose process is verified gone holds nothing", () =>
  Effect.gen(function* () {
    const { state, hold } = yield* fixture({ gone: true, turn: "running" });
    assert.isFalse(yield* hold);
    assert.isFalse(state.held);
  }).pipe(Effect.scoped),
);

it.effect("a running turn holds its thread until Codex reports it ended", () =>
  Effect.gen(function* () {
    const { state, released, hold } = yield* fixture({ gone: false, turn: "running" });
    assert.isTrue(yield* hold);
    assert.isTrue(state.held);
    yield* TestClock.adjust(LOST_CONNECTION_CHECK_INTERVAL);
    assert.isTrue(state.held, "a turn still running keeps the hold");
    state.turn = "completed";
    yield* TestClock.adjust(LOST_CONNECTION_CHECK_INTERVAL);
    yield* Deferred.await(released);
    assert.isFalse(state.held);
  }).pipe(Effect.scoped),
);

it.effect("an unreadable turn holds until its process is verified gone", () =>
  Effect.gen(function* () {
    const { state, released, hold } = yield* fixture({ gone: false, turn: "unreadable" });
    assert.isTrue(yield* hold);
    yield* TestClock.adjust(LOST_CONNECTION_CHECK_INTERVAL);
    assert.isTrue(state.held);
    state.gone = true;
    yield* TestClock.adjust(LOST_CONNECTION_CHECK_INTERVAL);
    yield* Deferred.await(released);
    assert.isFalse(state.held);
  }).pipe(Effect.scoped),
);
