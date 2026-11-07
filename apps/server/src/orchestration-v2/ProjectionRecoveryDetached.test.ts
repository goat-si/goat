import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
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
import { createThread } from "./ProjectionRecovery.testkit.ts";
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

it.effect.each(["startup", "shutdown"] as const)(
  "stops a detached session and its orphaned active provider thread on %s",
  (trigger) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const now = yield* DateTime.now;
      const threadId = yield* createThread("detached-session");
      const providerSessionId = ProviderSessionId.make("session:recovery:detached");
      yield* projections.apply({
        id: EventId.make("event:recovery:detached-session:attached"),
        type: "provider-session.attached",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
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
      yield* projections.apply({
        id: EventId.make("event:recovery:detached-session:detached"),
        type: "provider-session.detached",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: { providerSessionId, detachedAt: now, reason: "Thread settled." },
      });
      const providerThreadId = ProviderThreadId.make("provider-thread:recovery:detached");
      yield* projections.apply({
        id: EventId.make("event:recovery:detached-provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          appThreadId: threadId,
          ownerNodeId: null,
          driver,
          providerInstanceId,
          providerSessionId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), [threadId]);

      const summary = yield* recovery.reconcile(trigger);

      assert.equal(summary.stoppedSessions, 1);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM orchestration_v2_projection_provider_sessions
      WHERE provider_session_id = ${providerSessionId}
    `;
      assert.deepEqual(rows, [{ status: "stopped" }]);
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.providerThreads[0]?.status, "idle");
      const eventStore = yield* EventStore.EventStoreV2;
      const sequence = yield* eventStore.latestSequence();
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
      yield* recovery.reconcile(trigger);
      assert.equal(yield* eventStore.latestSequence(), sequence);
    }).pipe(Effect.provide(layerRecoveryTest)),
);
