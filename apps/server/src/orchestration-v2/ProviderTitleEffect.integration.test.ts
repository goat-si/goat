import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process is needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layer = Layer.mergeAll(
  EffectOutbox.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "provider-title-effect" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect("commits a provider rename effect only when the GOAT title changes", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:title-effect");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("title-create"),
      threadId,
      projectId: ProjectId.make("project:title"),
      title: "Before",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("title-change"),
      threadId,
      title: "After",
    });
    const effect = yield* outbox.get("effect:title-change:provider-session.apply-thread-title");
    assert.deepEqual(Option.getOrUndefined(effect)?.request, {
      type: "provider-session.apply-thread-title",
      title: "After",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("title-unchanged"),
      threadId,
      title: "After",
    });
    assert.isTrue(
      Option.isNone(
        yield* outbox.get("effect:title-unchanged:provider-session.apply-thread-title"),
      ),
    );
  }).pipe(Effect.provide(layer)),
);
