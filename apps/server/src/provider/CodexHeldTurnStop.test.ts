import { assert, it } from "@effect/vitest";
import { CommandId, ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { layerEffectOutboxProvided } from "../orchestration-v2/FoundationPersistence.testkit.ts";
import * as CodexDetached from "./CodexDetachedAppServerLive.ts";
import { stopHeldTurns } from "./CodexHeldTurnStop.ts";
import * as CodexSurvivors from "./CodexSurvivors.ts";

const record = { instanceId: ProviderInstanceId.make("codex"), recordName: "codex-record" };

/** A queued start on a thread held by one unowned Codex turn, with the real start guard. */
const heldStart = (name: string, confirmed: boolean) =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make(`held-${name}`);
    const turn = { threadId, nativeThreadId: "native-thread", nativeTurnId: "goal-turn" };
    const obligations = yield* Ref.make([turn]);
    const detached = Layer.mock(CodexDetached.CodexDetachedAppServers)({
      socketTransportEnabled: true,
      stopFencedThreads: Ref.get(obligations).pipe(
        Effect.map((held) => held.map((entry) => entry.threadId)),
      ),
      getStopObligations: () =>
        Ref.get(obligations).pipe(Effect.map((held) => held.map((block) => ({ record, block })))),
      clearStopObligation: (_record, cleared) =>
        Ref.update(obligations, (held) =>
          held.filter((entry) => entry.nativeTurnId !== cleared.nativeTurnId),
        ).pipe(Effect.as(undefined)),
    });
    return yield* Effect.gen(function* () {
      const survivors = yield* CodexSurvivors.CodexSurvivors;
      yield* survivors.setStartWake(outbox.notifyAvailable());
      yield* outbox.setStartGuard(
        survivors.startBlockedThreads.pipe(
          Effect.map((blockedThreads) => ({ blockedThreads, survivors: [] })),
        ),
      );
      yield* outbox.enqueue([
        {
          id: `start-${name}`,
          commandId: CommandId.make(`start-${name}`),
          threadId,
          request: { type: "provider-turn.start", runId: RunId.make(`run-${name}`) },
        },
      ]);
      const claim = outbox.claimNext({ workerId: name, leaseDurationMs: 30_000 });
      assert.isTrue(Option.isNone(yield* claim));
      const stopped: Array<string> = [];
      const outcome = yield* stopHeldTurns({
        survivors,
        threadId,
        stop: (_record, target) =>
          Effect.sync(() => {
            stopped.push(target.nativeTurnId);
            return confirmed;
          }),
      });
      return { outbox, claim, outcome, stopped, obligations };
    }).pipe(Effect.provide(CodexSurvivors.layer.pipe(Layer.provide(detached))));
  });

it.effect("stopping a held turn Codex confirms ended lets the waiting message start", () =>
  Effect.gen(function* () {
    const held = yield* heldStart("confirmed", true);
    assert.strictEqual(held.outcome, "stopped");
    assert.deepStrictEqual(held.stopped, ["goal-turn"]);
    yield* held.outbox.awaitStartAvailable;
    assert.strictEqual(Option.getOrThrow(yield* held.claim).id, "start-confirmed");
  }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
);

it.effect("a stop Codex has not confirmed keeps the message waiting behind the turn", () =>
  Effect.gen(function* () {
    const held = yield* heldStart("unconfirmed", false);
    assert.strictEqual(held.outcome, "stopping");
    assert.lengthOf(yield* Ref.get(held.obligations), 1);
    assert.isTrue(Option.isNone(yield* held.claim));
  }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
);
