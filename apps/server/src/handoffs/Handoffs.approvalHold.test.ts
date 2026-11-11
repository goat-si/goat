import { assert, it } from "@effect/vitest";
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  HUB_DEVICE_HANDOFF_PATHS,
  type EnvironmentId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Handoffs from "./Handoffs.ts";
import { computerUseGrantClients, instanceId, threadId, withHarness } from "./Handoffs.testkit.ts";

const ask = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  environmentId: EnvironmentId,
  path: string,
  title: string,
) =>
  Effect.gen(function* () {
    const service = yield* Handoffs.Handoffs;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    return yield* service.create({
      kind: "approval",
      title,
      reason: "The agent needs a person.",
      requestedBy: { threadId, providerInstanceId: instanceId, path },
      target: { environmentId, path },
      runId: run.id,
      nodeId: run.rootNodeId!,
      human: { location: "PRIVATE" },
      args: { path, title },
      expiresAt: DateTime.add(yield* DateTime.now, { hours: 1 }),
    });
  });

const pendingCards = (orchestrator: Orchestrator.OrchestratorV2["Service"]) =>
  orchestrator
    .getThreadProjection(threadId)
    .pipe(
      Effect.map((projection) =>
        projection.turnItems.flatMap((item) =>
          item.type === "human_handoff" &&
          item.handoff !== undefined &&
          (item.handoff.state === "pending" || item.handoff.state === "opened")
            ? [item.handoff.handoffId]
            : [],
        ),
      ),
    );

const withService = <A, E>(
  body: (input: {
    readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
    readonly environmentId: EnvironmentId;
  }) => Effect.Effect<A, E, Handoffs.Handoffs>,
) =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const { environmentId, dependencies } = yield* computerUseGrantClients(orchestrator);
      return yield* body({ orchestrator, environmentId }).pipe(
        Effect.provide(Handoffs.layer.pipe(Layer.provide(dependencies))),
      );
    }),
  );

it.effect(
  "a thread with an open approval that asks for another gets a refusal naming the open one, and no card is created",
  () =>
    withService(({ orchestrator, environmentId }) =>
      Effect.gen(function* () {
        const open = yield* ask(
          orchestrator,
          environmentId,
          HUB_DEVICE_HANDOFF_PATHS.join,
          "Join lidge to the hub",
        );
        const refused = yield* ask(
          orchestrator,
          environmentId,
          "ssh.runtime_update",
          "Update runtime on lidge?",
        ).pipe(Effect.flip);
        assert.equal(refused._tag === "HandoffError" && refused.reason, "limit_reached");
        assert.include(refused.message, open.handoffId);
        assert.include(refused.message, "Join lidge to the hub");
        assert.include(refused.message, HUB_DEVICE_HANDOFF_PATHS.join);
        assert.include(refused.message, "End this turn");
        assert.include(refused.message, "handoff.withdraw");
        // Asking for the same change again names the open card instead of returning it silently.
        const again = yield* ask(
          orchestrator,
          environmentId,
          HUB_DEVICE_HANDOFF_PATHS.join,
          "Join lidge to the hub",
        ).pipe(Effect.flip);
        assert.include(again.message, open.handoffId);
        assert.deepEqual(yield* pendingCards(orchestrator), [open.handoffId]);
      }),
    ),
);

it.effect("a computer use grant neither holds a thread nor is held by an open approval", () =>
  withService(({ orchestrator, environmentId }) =>
    Effect.gen(function* () {
      const grant = yield* ask(
        orchestrator,
        environmentId,
        COMPUTER_USE_GRANT_HANDOFF_PATH,
        "Allow computer use on test-host?",
      );
      const hub = yield* ask(
        orchestrator,
        environmentId,
        HUB_DEVICE_HANDOFF_PATHS.leave,
        "Remove box from the hub",
      );
      const second = yield* ask(
        orchestrator,
        environmentId,
        COMPUTER_USE_GRANT_HANDOFF_PATH,
        "Allow computer use on other-host?",
      );
      const pending = yield* pendingCards(orchestrator);
      assert.include(pending, hub.handoffId);
      assert.include(pending, second.handoffId);
      assert.notEqual(grant.handoffId, second.handoffId);
    }),
  ),
);

it.effect("a withdrawn approval frees the thread and is recorded as ended by the agent", () =>
  withService(({ orchestrator, environmentId }) =>
    Effect.gen(function* () {
      const service = yield* Handoffs.Handoffs;
      const open = yield* ask(
        orchestrator,
        environmentId,
        "ssh.runtime_update",
        "Update runtime on lidge?",
      );
      const withdrawn = yield* service.withdraw({ threadId, handoffId: open.handoffId });
      assert.equal(withdrawn.state, "cancelled");
      assert.deepEqual(withdrawn.actor, { type: "agent", threadId });
      const next = yield* ask(
        orchestrator,
        environmentId,
        HUB_DEVICE_HANDOFF_PATHS.join,
        "Join lidge to the hub",
      );
      assert.deepEqual(yield* pendingCards(orchestrator), [next.handoffId]);
      const again = yield* service
        .withdraw({ threadId, handoffId: open.handoffId })
        .pipe(Effect.flip);
      assert.equal(again.reason, "conflict");
      const grant = yield* ask(
        orchestrator,
        environmentId,
        COMPUTER_USE_GRANT_HANDOFF_PATH,
        "Allow computer use on test-host?",
      );
      const grantRefused = yield* service
        .withdraw({ threadId, handoffId: grant.handoffId })
        .pipe(Effect.flip);
      assert.equal(grantRefused.reason, "invalid_request");
    }),
  ),
);
