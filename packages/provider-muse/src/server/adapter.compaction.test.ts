import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";

import {
  testLayer,
  INSTANCE_ID,
  runtimePolicy,
  makeFakeMuse,
  makeHarness,
  turnInput,
  captureWakeOffer,
  startConversation,
} from "./test/adapterHelpers.ts";

describe("MuseAdapterV2 compaction and stop recovery", () => {
  it.effect("reports a compaction rejected at admission on its own terminal", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      fake.queueResponse("session/compact", new Error("command rejected: run_active"));
      yield* harness.runtime.compactThread!(yield* turnInput(harness.providerThread));
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "reusable");
      assert.include(terminal.failure?.message, "run_active");
      yield* startConversation(harness, fake, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("treats recovering an already ended turn as done", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const turn = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", { turnId: turn.nativeId, terminal: "completed" });
      assert.strictEqual((yield* harness.takeEvent("turn.terminal")).status, "completed");
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: turn.providerTurn.id,
        requestRuntimeRestart: true,
      });
      yield* startConversation(harness, fake, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not acknowledge Stop on an ended turn while a background subagent runs", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const turn = yield* startConversation(harness, fake);
      yield* fake.emit("item/started", {
        turnId: turn.nativeId,
        item: {
          itemId: "background-child",
          kind: "subagent",
          revision: 1,
          status: "inProgress",
          turnId: turn.nativeId,
          subagentId: "subagent-1",
          controlStatus: "running",
          childSessionId: "child-session-1",
          objective: "Finish in the background",
        },
      });
      yield* harness.takeEvent("app_thread.created");
      yield* fake.emit("turn/completed", { turnId: turn.nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      const stopped = yield* harness.runtime
        .interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: turn.providerTurn.id,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.exit);
      assert.strictEqual(stopped._tag, "Failure");
      assert.isTrue(yield* harness.runtime.hasPendingBackgroundWork!);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(["offer", "disconnect"] as const)(
    "drains the inbox while a wake retry waits for space, then handles %s",
    (outcome) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const waiting = yield* Deferred.make<void>();
        const space = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const offered =
          yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
        let offers = 0;
        const harness = yield* makeHarness(
          fake,
          INSTANCE_ID,
          undefined,
          undefined,
          undefined,
          runtimePolicy,
          {
            continuationRequests: {
              offer: (request) =>
                Effect.suspend(() =>
                  ++offers === 1
                    ? Effect.succeed("overflow" as const)
                    : Deferred.succeed(offered, request).pipe(Effect.asVoid),
                ),
              awaitSpace: () =>
                Deferred.succeed(waiting, undefined).pipe(
                  Effect.andThen(Deferred.await(space)),
                  Effect.ensuring(Deferred.succeed(finished, undefined)),
                ),
            },
          },
        );
        yield* Effect.addFinalizer(() => Deferred.succeed(space, undefined).pipe(Effect.asVoid));
        const previous = yield* startConversation(harness, fake);
        yield* fake.emit("turn/completed", { turnId: previous.nativeId, terminal: "completed" });
        yield* harness.takeEvent("turn.terminal");
        yield* fake.emit("turn/started", { turnId: "delayed-wake" });
        yield* Deferred.await(waiting);
        yield* fake.emit("session/contextUsage", { usedTokens: 613, windowTokens: 1000 });
        yield* harness.takeEvent(
          "provider_thread.updated",
          (event) => event.providerThread.contextUsage?.usedTokens === 613,
        );
        assert.equal(offers, 1);
        if (outcome === "disconnect") {
          yield* fake.disconnect();
          yield* harness.takeEvent(
            "provider_session.updated",
            (event) => event.providerSession.status === "error",
          );
          yield* Deferred.await(finished);
          yield* Deferred.succeed(space, undefined);
          assert.isFalse(yield* Deferred.isDone(offered));
        } else {
          yield* Deferred.succeed(space, undefined);
          const result = yield* Deferred.await(offered);
          assert.equal(offers, 2);
          assert.equal(result.providerThreadId, harness.providerThread.id);
        }
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("ends a compaction whose item names the held wake as its run", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const offered =
        yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        runtimePolicy,
        { continuationRequests: captureWakeOffer(offered) },
      );
      const previous = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", { turnId: previous.nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      yield* fake.emit("turn/started", { turnId: "background-wake" });
      yield* Deferred.await(offered);
      yield* fake.emit("turn/completed", { turnId: "background-wake", terminal: "completed" });
      yield* harness.runtime.compactThread!(yield* turnInput(harness.providerThread, 2));
      yield* fake.emit("item/completed", {
        item: {
          itemId: "manual-compact",
          kind: "compaction",
          revision: 1,
          status: "completed",
          turnId: "background-wake",
          outcome: "compacted",
        },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.runOrdinal, 2);
      assert.strictEqual(terminal.status, "completed");
      assert.isTrue(yield* harness.runtime.hasPendingBackgroundWork!);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("drops a held wake when Stop closes the compacting host", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const offered =
        yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        runtimePolicy,
        { continuationRequests: captureWakeOffer(offered) },
      );
      const previous = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", { turnId: previous.nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      yield* fake.emit("turn/started", { turnId: "background-wake" });
      const continuation = yield* Deferred.await(offered);
      yield* harness.runtime.compactThread!(yield* turnInput(harness.providerThread, 2));
      const running = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.status === "running",
      );
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: running.providerTurn.id,
        requestRuntimeRestart: true,
      });
      assert.isFalse(yield* harness.runtime.hasPendingBackgroundWork!);
      const dispatched = yield* continuation.dispatchIfCurrent!(Effect.void);
      assert.isTrue(Option.isNone(dispatched));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a running wake held when Muse declines compaction", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const offered =
        yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        runtimePolicy,
        { continuationRequests: captureWakeOffer(offered) },
      );
      const previous = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", { turnId: previous.nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      yield* fake.emit("turn/started", { turnId: "background-wake" });
      yield* Deferred.await(offered);
      fake.queueResponse("session/compact", new Error("command rejected: run_active"));
      yield* harness.runtime.compactThread!(yield* turnInput(harness.providerThread, 2));
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.isTrue(yield* harness.runtime.hasPendingBackgroundWork!);
      const stopped = yield* harness.runtime
        .interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: terminal.providerTurnId,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.exit);
      assert.strictEqual(stopped._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
