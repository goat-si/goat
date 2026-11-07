import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { createThread, createRun } from "./ProjectionRecovery.testkit.ts";

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

it.effect.each(["attached", "detached", "replaced"] as const)(
  "recovers attached sessions without restoring detached errors, session=%s",
  (state) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const now = yield* DateTime.now;
      const threadId = yield* createThread("failed-status-session");
      const providerSessionId = ProviderSessionId.make("session:recovery:failed-status");
      const session = {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "error" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        extensionStatuses: [{ key: "watch", text: "Watching" }],
        createdAt: now,
        updatedAt: now,
        lastError: "Rate limited",
      };
      yield* projections.apply({
        id: EventId.make("event:recovery:failed-status:attached"),
        type: "provider-session.attached",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: session,
      });
      if (state !== "attached") {
        yield* projections.apply({
          id: EventId.make("event:recovery:failed-status:detached"),
          type: "provider-session.detached",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: { providerSessionId, detachedAt: now, reason: "Thread settled." },
        });
      }
      const replacementSessionId = ProviderSessionId.make("session:recovery:replacement");
      if (state === "replaced") {
        yield* projections.apply({
          id: EventId.make("event:recovery:replacement:attached"),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            ...session,
            id: replacementSessionId,
            status: "ready",
            extensionStatuses: [],
            lastError: null,
          },
        });
        yield* createRun(threadId, "completed");
      }
      assert.deepEqual(
        yield* projections.getRecoveryThreadIds("runtime"),
        state === "detached" ? [] : [threadId],
      );
      yield* recovery.reconcile("startup");
      const eventStore = yield* EventStore.EventStoreV2;
      const stored = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
      const sessionUpdates = stored.flatMap(({ event }) =>
        event.type === "provider-session.updated"
          ? [
              {
                id: event.payload.id,
                status: event.payload.status,
                lastError: event.payload.lastError,
                extensionStatuses: event.payload.extensionStatuses,
              },
            ]
          : [],
      );
      assert.deepEqual(
        sessionUpdates,
        state === "detached"
          ? []
          : [
              {
                id: state === "attached" ? providerSessionId : replacementSessionId,
                status: state === "attached" ? "error" : "stopped",
                lastError: state === "attached" ? "Rate limited" : null,
                extensionStatuses: [],
              },
            ],
      );
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    }).pipe(Effect.provide(layerRecoveryTest)),
);
