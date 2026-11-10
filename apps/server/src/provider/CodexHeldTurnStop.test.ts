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
    readonly ownedByRun?: boolean;
    /** Another native thread of this GOAT thread with its own goal block. */
    readonly otherGoal?: boolean;
  },
) =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make(`held-${name}`);
    const turn = { threadId, nativeThreadId: "native-thread", nativeTurnId: "goal-turn" };
    const obligations = yield* Ref.make([turn]);
    const goalBlocks = yield* Ref.make([
      { threadId, nativeThreadId: "native-thread" },
      ...(options.otherGoal === true ? [{ threadId, nativeThreadId: "other-native-thread" }] : []),
    ]);
    const goalBlocksAtWake = yield* Ref.make<number | undefined>(undefined);
    /** Set when the start guard stopped holding the thread while its goal block still stood. */
    const unfencedWithGoal = yield* Ref.make(false);
    // Like the record store: one write per call, with the goal of that native thread on request.
    const clearStop = (
      _record: unknown,
      cleared: { readonly nativeThreadId: string; readonly nativeTurnId: string },
      releaseGoal?: boolean,
    ) =>
      Effect.gen(function* () {
        const held = (yield* Ref.get(obligations)).filter(
          (entry) => entry.nativeTurnId !== cleared.nativeTurnId,
        );
        yield* Ref.set(obligations, held);
        if (releaseGoal === true)
          yield* Ref.update(goalBlocks, (blocks) =>
            blocks.filter((block) => block.nativeThreadId !== cleared.nativeThreadId),
          );
        if (
          held.length === 0 &&
          (yield* Ref.get(goalBlocks)).some(
            (block) => block.nativeThreadId === cleared.nativeThreadId,
          )
        )
          yield* Ref.set(unfencedWithGoal, true);
      }).pipe(Effect.as(undefined));
    const detached = Layer.mock(CodexDetached.CodexDetachedAppServers)({
      socketTransportEnabled: true,
      stopFencedThreads: Ref.get(obligations).pipe(
        Effect.map((held) => held.map((entry) => entry.threadId)),
      ),
      getStopObligations: () =>
        Ref.get(obligations).pipe(Effect.map((held) => held.map((block) => ({ record, block })))),
      clearStopObligation: clearStop,
      getGoalBlocks: () =>
        Ref.get(goalBlocks).pipe(
          Effect.map((blocks) => blocks.map((block) => ({ record, block }))),
        ),
      // Like the record store: a goal block stays while any stop fence holds its thread.
      clearGoalBlock: (_record, block) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(obligations)).length === 0)
            yield* Ref.update(goalBlocks, (blocks) =>
              blocks.filter((entry) => entry.nativeThreadId !== block.nativeThreadId),
            );
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
        ownedByRun: () => Effect.succeed(options.ownedByRun === true),
        release: (heldRecord, cleared) => clearStop(heldRecord, cleared, true),
        threadId,
        nativeTurnId: options.turnId,
        stop: (_record, target) =>
          Effect.sync(() => {
            stopped.push(target.nativeTurnId);
            return options.confirmed;
          }),
      });
      return {
        outbox,
        claim,
        outcome,
        stopped,
        obligations,
        goalBlocks,
        goalBlocksAtWake,
        unfencedWithGoal,
      };
    }).pipe(Effect.provide(CodexSurvivors.layer.pipe(Layer.provide(detached))));
  });

it.effect("stopping the shown turn releases its stop fence and goal block in one step", () =>
  Effect.gen(function* () {
    const held = yield* heldStart("confirmed", { confirmed: true, turnId: "goal-turn" });
    assert.strictEqual(held.outcome, "stopped");
    assert.deepStrictEqual(held.stopped, ["goal-turn"]);
    // A worker that polls between two writes must never find the thread unfenced but goal-blocked.
    assert.isFalse(yield* Ref.get(held.unfencedWithGoal));
    yield* held.outbox.awaitStartAvailable;
    assert.strictEqual(Option.getOrThrow(yield* held.claim).id, "start-confirmed");
  }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
);

it.effect("a goal block on another native thread refuses the stop before anything stops", () =>
  Effect.gen(function* () {
    // Admission would still refuse the message, so ending the turn could not release it.
    const exit = yield* Effect.exit(
      heldStart("other-goal", { confirmed: true, turnId: "goal-turn", otherGoal: true }),
    );
    assert.isTrue(Exit.isFailure(exit));
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

it.effect("a run's own turn that recovery fenced without a binding is never stopped", () =>
  Effect.gen(function* () {
    const held = yield* heldStart("run-owned", {
      confirmed: true,
      turnId: "goal-turn",
      ownedByRun: true,
    });
    assert.strictEqual(held.outcome, "none");
    assert.deepStrictEqual(held.stopped, []);
    assert.lengthOf(yield* Ref.get(held.obligations), 1);
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
