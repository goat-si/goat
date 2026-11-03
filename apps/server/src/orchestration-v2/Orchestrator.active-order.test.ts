import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

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
    { name: "active-order" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("clears a saved active order for user messages but preserves it for agent messages", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    for (const createdBy of ["agent", "user"] as const) {
      const threadId = ThreadId.make(`thread:active-order-${createdBy}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create-active-order-${createdBy}`),
        threadId,
        projectId: ProjectId.make(`project:active-order-${createdBy}`),
        title: "Thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "thread.active.reorder",
        commandId: CommandId.make(`reorder-${createdBy}`),
        threadId,
        orderKey: "a",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`dispatch-active-order-${createdBy}`),
        threadId,
        messageId: MessageId.make(`message-active-order-${createdBy}`),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy,
        creationSource: createdBy === "user" ? "web" : "mcp",
      });
      assert.equal(
        (yield* projections.getThreadProjection(threadId)).thread.activeOrderKey,
        createdBy === "user" ? null : "a",
      );
      assert.equal(
        (yield* projections.getThreadShell(threadId))?.activeOrderKey,
        createdBy === "user" ? null : "a",
      );
    }
  }).pipe(Effect.provide(layerTest)),
);
