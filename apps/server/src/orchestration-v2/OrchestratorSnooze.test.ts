import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("snoozes questions, rejects approvals, and wakes when a question is answered", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const now = yield* DateTime.now;
    for (const scenario of ["cancel", "answer", "approval"] as const) {
      const kind = scenario === "approval" ? "command" : "user_input";
      const threadId = ThreadId.make(`thread:snoozed-live-${scenario}`);
      const requestId = RuntimeRequestId.make(`request:snoozed-live-${scenario}`);
      const sessionId = ProviderSessionId.make(`session:snoozed-live-${scenario}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create-snoozed-live-${scenario}`),
        threadId,
        projectId: ProjectId.make("project:snoozed-live"),
        title: "Deferred question",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make(`snooze-live-${scenario}`),
        threadId,
        snoozedUntil: "2099-07-25T09:00:00.000Z",
      });
      const before = yield* projections.getThread(threadId);
      yield* projections.apply({
        id: EventId.make(`attach-snoozed-live-${scenario}`),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`request-snoozed-live-${scenario}`),
        type: "runtime-request.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId: NodeId.make(`node:snoozed-live-${scenario}`),
          providerTurnId: null,
          nativeRequestRef: null,
          kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: sessionId },
          createdAt: now,
          resolvedAt: null,
        },
      });
      const resnooze = yield* Effect.result(
        orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`resnooze-${scenario}`),
          threadId,
          snoozedUntil: "2099-07-25T09:00:00.000Z",
        }),
      );
      assert.equal(resnooze._tag, kind === "user_input" ? "Success" : "Failure");
      const commandId = CommandId.make(`respond-snoozed-live-${scenario}`);
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId,
        requestId,
        ...(scenario === "answer"
          ? { answers: { choice: "Yes" } }
          : { decision: scenario === "cancel" ? ("cancel" as const) : ("accept" as const) }),
      });
      const after = yield* projections.getThread(threadId);
      if (scenario === "answer") {
        assert.isNull(after.snoozedUntil);
        assert.isNull(after.snoozedAt);
      } else {
        assert.deepEqual(after.snoozedUntil, before.snoozedUntil);
        assert.deepEqual(after.snoozedAt, before.snoozedAt);
      }
      assert.equal((yield* projections.getRuntimeRequest(threadId, requestId))?.status, "resolved");
      assert.equal(
        (yield* outbox.listByCommandId(commandId))[0]?.request.type,
        "runtime-request.respond",
      );
    }
  }).pipe(Effect.provide(layerTest)),
);
