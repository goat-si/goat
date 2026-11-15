import { createThread, createRun } from "./ProjectionRecovery.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";

const layerRecoveryTest = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(
    EventSink.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EventStore.layer,
          ProjectionStore.layer,
          EffectOutbox.layer,
          IdAllocator.layer,
        ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
  Layer.provide(ServerSettings.layerTest()),
);
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");

it.effect("leaves a finished delegated child's background roster to the child", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    // The parent sorts first, so it is reconciled before the child.
    const parent = yield* createThread("delegation");
    yield* createRun(parent, "completed");
    const child = yield* createThread("delegation:child", {
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
    });
    const childProviderThreadId = ProviderThreadId.make(`provider-thread:${child}`);
    const childSessionId = ProviderSessionId.make(`session:${child}`);
    yield* projections.apply({
      id: EventId.make(`event:${child}:session`),
      type: "provider-session.attached",
      threadId: child,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: childSessionId,
        driver,
        providerInstanceId,
        status: "ready",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    const childRun = yield* createRun(child, "completed", {
      providerThreadId: childProviderThreadId,
    });
    yield* projections.apply({
      id: EventId.make(`event:${child}:roster`),
      type: "provider-thread.updated",
      threadId: child,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: childProviderThreadId,
        appThreadId: child,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId: childSessionId,
        nativeThreadRef: { driver, nativeId: "child-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [
          { taskId: "wait", description: "sleep 600", kind: "command", awaited: true },
        ],
      },
    });
    // Finalizing a delegated task records the child's provider thread on the parent's row.
    const taskId = NodeId.make(`node:${parent}:task`);
    yield* projections.apply({
      id: EventId.make(`event:${parent}:task`),
      type: "subagent.updated",
      threadId: parent,
      occurredAt: now,
      payload: {
        id: taskId,
        threadId: parent,
        runId: RunId.make(`run:${parent}:1`),
        parentNodeId: NodeId.make(`node:${parent}:root`),
        origin: "app_owned",
        createdBy: "agent",
        driver,
        providerInstanceId,
        providerThreadId: childProviderThreadId,
        childThreadId: child,
        nativeTaskRef: null,
        prompt: "wait for the build",
        title: null,
        model: null,
        status: "completed",
        result: "Waiting on the build",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      },
    });

    yield* recovery.reconcile("startup");

    const effects = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${child}
    `;
    assert.deepEqual(effects, [{ effect_id: `effect:restart-continuation:${childRun}` }]);
    const projection = yield* projections.getThreadProjection(child);
    assert.deepEqual(projection.runs[0]?.restartCancelledBackgroundWork, [
      { kind: "shell", label: "sleep 600 (id wait)", id: "wait", awaited: true },
    ]);
  }).pipe(Effect.provide(layerRecoveryTest)),
);
