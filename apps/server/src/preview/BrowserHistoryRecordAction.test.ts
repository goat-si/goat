import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { makeComputerUseHistory } from "../cua/ComputerUseHistory.ts";
import { makeBrowserHistoryRecordAction } from "./BrowserHistoryRecordAction.ts";

it.effect("returns a successful click when history fails or never completes", () =>
  Effect.gen(function* () {
    const history = yield* makeComputerUseHistory;
    const writes = yield* Queue.unbounded<void>();
    const never = Promise.withResolvers<void>();
    const gate = yield* Deferred.make<void>();
    yield* Deferred.await(gate).pipe(
      Effect.tap(() => Effect.sync(() => never.resolve())),
      Effect.forkChild,
    );
    const tab = {
      threadId: "thread:test",
      page: { url: () => "https://example.test" },
      actionTimeline: [],
      diagnostics: { firstLine: (cause: unknown) => String(cause) },
    };
    const failed = makeBrowserHistoryRecordAction(history, () =>
      Promise.reject(new Error("write failed")),
    );
    const result = yield* Effect.tryPromise(() => failed(tab, "click", async () => "clicked")).pipe(
      Effect.result,
    );
    assert.equal(result._tag, "Success");
    const blocked = makeBrowserHistoryRecordAction(history, () => {
      Queue.offerUnsafe(writes, undefined);
      return never.promise;
    });
    const action = yield* Effect.promise(() => blocked(tab, "click", async () => "clicked")).pipe(
      Effect.timeoutOption("2 seconds"),
      Effect.forkChild,
    );
    yield* Queue.take(writes);
    yield* TestClock.adjust("3 seconds");
    const value = yield* Fiber.join(action);
    assert.isTrue(Option.isSome(value));
    if (Option.isSome(value)) assert.equal(value.value, "clicked");
    yield* Deferred.succeed(gate, undefined);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
