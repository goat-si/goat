import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import { deviceReleaseApplies } from "./CleanupEffects.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for lifecycle commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "device-release" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:device-release"),
      title: "Lane",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("settling, archiving and deleting a thread each queue the release of its devices", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:device-release");
    yield* createThread(threadId);
    const releaseTypes = (commandId: string) =>
      outbox
        .listByCommandId(CommandId.make(commandId))
        .pipe(
          Effect.map((effects) =>
            effects
              .map((effect) => effect.request.type)
              .filter((type) => type === "device.release"),
          ),
        );

    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle"),
      threadId,
    });
    assert.deepEqual(yield* releaseTypes("settle"), ["device.release"]);
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId,
    });
    assert.deepEqual(yield* releaseTypes("archive"), ["device.release"]);
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete"),
      threadId,
    });
    assert.deepEqual(yield* releaseTypes("delete"), ["device.release"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a release queued by a settle is skipped once the thread is active again", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:device-release-resumed");
    yield* createThread(threadId);
    const active = yield* projections.getThreadShell(threadId);
    assert.isFalse(deviceReleaseApplies(active));
    const now = yield* DateTime.now;
    assert.isTrue(deviceReleaseApplies(active && { ...active, settledOverride: "settled" }));
    assert.isTrue(deviceReleaseApplies(active && { ...active, archivedAt: now }));
    assert.isTrue(deviceReleaseApplies(active && { ...active, deletedAt: now }));
    assert.isTrue(deviceReleaseApplies(null));
  }).pipe(Effect.provide(layerTest)),
);
