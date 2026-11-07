import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Outbox from "./EffectOutbox.ts";

it.effect("recovery sees pending and running interrupts for the matching native turn only", () =>
  Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread-a");
    const turnId = ProviderTurnId.make("turn-a");
    const interrupt = {
      type: "provider-turn.interrupt" as const,
      providerSessionId: ProviderSessionId.make("session"),
      providerThreadId: ProviderThreadId.make("provider-thread"),
      providerTurnId: turnId,
    };
    yield* outbox.enqueue([
      { id: "interrupt-a", commandId: CommandId.make("command-a"), threadId, request: interrupt },
    ]);
    assert.isTrue(yield* outbox.hasUnsettledInterrupt(threadId, [turnId]));
    assert.isFalse(yield* outbox.hasUnsettledInterrupt(ThreadId.make("thread-b"), [turnId]));
    assert.isFalse(yield* outbox.hasUnsettledInterrupt(threadId, [ProviderTurnId.make("turn-b")]));
    const claimed = yield* outbox.claimNext({ workerId: "worker", leaseDurationMs: 30000 });
    assert.isTrue(Option.isSome(claimed));
    assert.isTrue(yield* outbox.hasUnsettledInterrupt(threadId, [turnId]));
    yield* outbox.succeed({ effectId: "interrupt-a", workerId: "worker" });
    assert.isFalse(yield* outbox.hasUnsettledInterrupt(threadId, [turnId]));
  }).pipe(Effect.provide(Outbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect("process-loss cleanup leaves fenced threads' effects untouched", () =>
  Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2;
    const fenced = ThreadId.make("fenced-thread");
    const other = ThreadId.make("other-thread");
    const request = {
      type: "provider-turn.interrupt" as const,
      providerSessionId: ProviderSessionId.make("session"),
      providerThreadId: ProviderThreadId.make("provider-thread"),
      providerTurnId: ProviderTurnId.make("turn"),
    };
    yield* outbox.enqueue([
      { id: "fenced", commandId: CommandId.make("command:fenced"), threadId: fenced, request },
      { id: "other", commandId: CommandId.make("command:other"), threadId: other, request },
    ]);
    const result = yield* outbox.reconcileAfterProcessLossExcept([fenced]);
    assert.equal(result.cancelled, 1);
    const first = yield* outbox.get("fenced");
    const second = yield* outbox.get("other");
    assert.isTrue(Option.isSome(first) && first.value.status === "pending");
    assert.isTrue(Option.isSome(second) && second.value.status === "cancelled");
  }).pipe(Effect.provide(Outbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect("terminal survivor cleanup cancels only the named continuation", () =>
  Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread-terminal");
    const first = RunId.make("run-first");
    const other = RunId.make("run-other");
    yield* outbox.enqueue([
      {
        id: `effect:restart-continuation:${first}`,
        commandId: CommandId.make("command:first"),
        threadId,
        request: { type: "provider-runtime.continue", sourceRunId: first },
      },
      {
        id: `effect:restart-continuation:${other}`,
        commandId: CommandId.make("command:other"),
        threadId,
        request: { type: "provider-runtime.continue", sourceRunId: other },
      },
    ]);
    const cancelled = yield* outbox.cancelContinuations(threadId, [first]);
    assert.deepEqual(cancelled, [`effect:restart-continuation:${first}`]);
    const a = yield* outbox.get(`effect:restart-continuation:${first}`);
    const b = yield* outbox.get(`effect:restart-continuation:${other}`);
    assert.isTrue(Option.isSome(a) && a.value.status === "cancelled");
    assert.isTrue(Option.isSome(b) && b.value.status === "pending");
  }).pipe(Effect.provide(Outbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect.each([false, true])(
  "a survivor continuation becomes runnable again after a crash (completed: %s)",
  (completed) =>
    Effect.gen(function* () {
      const outbox = yield* Outbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread-survivor");
      const sourceRunId = RunId.make("run-survivor");
      const effectId = `effect:restart-continuation:${sourceRunId}`;
      yield* outbox.enqueue([
        {
          id: effectId,
          commandId: CommandId.make("command:survivor"),
          threadId,
          request: { type: "provider-runtime.continue", sourceRunId },
        },
      ]);
      yield* outbox.claimNext({ workerId: "old-server", leaseDurationMs: 30000 });
      if (completed) yield* outbox.succeed({ effectId, workerId: "old-server" });
      assert.isTrue(yield* outbox.requeueSurvivorContinuation(threadId, sourceRunId));
      const recovered = yield* outbox.get(effectId);
      assert.isTrue(Option.isSome(recovered) && recovered.value.status === "pending");
    }).pipe(Effect.provide(Outbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);
