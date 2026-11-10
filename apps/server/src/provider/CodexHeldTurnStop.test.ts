import { assert, it } from "@effect/vitest";
import { CommandId, ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as CodexClient from "effect-codex-app-server/client";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { layerEffectOutboxProvided } from "../orchestration-v2/FoundationPersistence.testkit.ts";
import * as CodexDetached from "./CodexDetachedAppServerLive.ts";
import { stopHeldTurn, stopTurnOnClient } from "./CodexHeldTurnStop.ts";
import * as CodexSurvivors from "./CodexSurvivors.ts";

const record = { instanceId: ProviderInstanceId.make("codex"), recordName: "codex-record" };

/**
 * A queued start on a thread held by an unowned Codex goal turn: a stop fence plus the goal
 * block that admission also checks, behind the real start guard.
 */
const heldStart = (
  name: string,
  options: {
    readonly confirmed: boolean;
    readonly turnId: string;
    readonly survivorTurn?: boolean;
  },
) =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make(`held-${name}`);
    const turn = { threadId, nativeThreadId: "native-thread", nativeTurnId: "goal-turn" };
    const obligations = yield* Ref.make([turn]);
    const goalBlocks = yield* Ref.make([{ threadId, nativeThreadId: "native-thread" }]);
    const goalBlocksAtWake = yield* Ref.make<number | undefined>(undefined);
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
      getGoalBlocks: () =>
        Ref.get(goalBlocks).pipe(
          Effect.map((blocks) => blocks.map((block) => ({ record, block }))),
        ),
      // Like the record store: a goal block stays while any stop fence holds its thread.
      clearGoalBlock: () =>
        Effect.gen(function* () {
          if ((yield* Ref.get(obligations)).length === 0) yield* Ref.set(goalBlocks, []);
        }).pipe(Effect.as(undefined)),
    });
    return yield* Effect.gen(function* () {
      const survivors = yield* CodexSurvivors.CodexSurvivors;
      if (options.survivorTurn === true)
        yield* survivors.replace([
          { ...record, ...turn, sourceRunId: RunId.make("run-before-restart") },
        ]);
      yield* survivors.setStartWake(
        Ref.get(goalBlocks).pipe(
          Effect.flatMap((blocks) => Ref.set(goalBlocksAtWake, blocks.length)),
          Effect.andThen(outbox.notifyAvailable()),
        ),
      );
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
      const outcome = yield* stopHeldTurn({
        survivors,
        clearStopQuietly: (_record, cleared) =>
          Ref.update(obligations, (held) =>
            held.filter((entry) => entry.nativeTurnId !== cleared.nativeTurnId),
          ),
        threadId,
        nativeTurnId: options.turnId,
        stop: (_record, target) =>
          Effect.sync(() => {
            stopped.push(target.nativeTurnId);
            return options.confirmed;
          }),
      });
      return { outbox, claim, outcome, stopped, obligations, goalBlocks, goalBlocksAtWake };
    }).pipe(Effect.provide(CodexSurvivors.layer.pipe(Layer.provide(detached))));
  });

it.effect("stopping the shown turn releases both fences before the waiting message starts", () =>
  Effect.gen(function* () {
    const held = yield* heldStart("confirmed", { confirmed: true, turnId: "goal-turn" });
    assert.strictEqual(held.outcome, "stopped");
    assert.deepStrictEqual(held.stopped, ["goal-turn"]);
    assert.strictEqual(yield* Ref.get(held.goalBlocksAtWake), 0);
    yield* held.outbox.awaitStartAvailable;
    assert.strictEqual(Option.getOrThrow(yield* held.claim).id, "start-confirmed");
  }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
);

it.effect("a turn other than the one shown is never stopped", () =>
  Effect.gen(function* () {
    const held = yield* heldStart("replaced", { confirmed: true, turnId: "earlier-turn" });
    assert.strictEqual(held.outcome, "none");
    assert.deepStrictEqual(held.stopped, []);
    assert.lengthOf(yield* Ref.get(held.obligations), 1);
  }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
);

it.effect("a turn that survived a restart is left to its own run", () =>
  Effect.gen(function* () {
    const held = yield* heldStart("survivor", {
      confirmed: true,
      turnId: "goal-turn",
      survivorTurn: true,
    });
    assert.strictEqual(held.outcome, "none");
    assert.deepStrictEqual(held.stopped, []);
  }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
);

it.effect("a stop Codex has not confirmed keeps the message waiting behind the turn", () =>
  Effect.gen(function* () {
    const held = yield* heldStart("unconfirmed", { confirmed: false, turnId: "goal-turn" });
    assert.strictEqual(held.outcome, "stopping");
    assert.lengthOf(yield* Ref.get(held.obligations), 1);
    assert.lengthOf(yield* Ref.get(held.goalBlocks), 1);
    assert.isTrue(Option.isNone(yield* held.claim));
  }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
);

/** A Codex client whose goal reads active until a pause is accepted, and that records requests. */
const fakeClient = (pauseAccepted: boolean) => {
  const requests: Array<string> = [];
  let goalStatus = "active";
  const client = {
    handleServerNotification: () => Effect.void,
    request: (method: string) =>
      Effect.sync(() => {
        requests.push(method);
        if (method === "thread/goal/set" && pauseAccepted) goalStatus = "paused";
        if (method === "thread/goal/get") return { goal: { status: goalStatus } };
        if (method === "thread/turns/list")
          return { data: [{ id: "goal-turn", status: "interrupted" }] };
        return {};
      }),
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  return { client, requests };
};
const target = {
  threadId: ThreadId.make("held"),
  nativeThreadId: "native-thread",
  nativeTurnId: "goal-turn",
};

it.effect("a goal Codex will not pause leaves the turn running and fails the stop", () =>
  Effect.gen(function* () {
    const { client, requests } = fakeClient(false);
    const exit = yield* Effect.exit(stopTurnOnClient(client, target));
    assert.isTrue(Exit.isFailure(exit));
    assert.notInclude(requests, "turn/interrupt");
  }),
);

it.effect("a paused goal lets the turn be interrupted and confirmed ended", () =>
  Effect.gen(function* () {
    const { client, requests } = fakeClient(true);
    assert.isTrue(yield* stopTurnOnClient(client, target));
    assert.isBelow(requests.indexOf("thread/goal/set"), requests.indexOf("turn/interrupt"));
  }),
);
