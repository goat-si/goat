import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import {
  CODEX_DRIVER,
  modelSelection,
  threadCreatedEvent,
} from "./ProviderEventIngestor.fixtures.ts";

const layerNoProviderInstances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - Optional instances require undefined rather than void.
  getInstance: () => Effect.succeed(undefined),
});

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ingestor-rows-git-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layer = it.layer(
  Layer.mergeAll(
    layerTestDatabase,
    layerTestStores,
    layerTestEventSink,
    IdAllocator.layer,
    ProviderEventIngestor.layer.pipe(
      Layer.provide(layerNoProviderInstances),
      Layer.provide(
        Layer.mergeAll(
          layerTestStores,
          layerTestEventSink,
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
          layerGit,
        ),
      ),
    ),
  ),
);
layer("agent mode selection", (it) => {
  it.effect("applies an agent's mode change without undoing newer thread settings", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const rootEvent = yield* threadCreatedEvent(now);
      if (rootEvent.type !== "thread.created") throw new Error("Expected thread fixture");
      // Saved mid-turn: a newer model and effort the reporting turn never saw.
      const saved = {
        ...modelSelection,
        model: "gpt-6.1-sol",
        options: [
          { id: "effort", value: "high" },
          { id: "mode", value: "plan" },
        ],
      };
      yield* eventSink.write({
        events: [{ ...rootEvent, payload: { ...rootEvent.payload, modelSelection: saved } }],
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
      });
      const ingest = (instanceId: ProviderInstanceId, from: string) =>
        ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootEvent.threadId,
          event: {
            type: "thread_model_selection.updated",
            driver: CODEX_DRIVER,
            threadId: rootEvent.threadId,
            instanceId,
            changes: [{ id: "mode", from, to: "default" }],
          },
        });
      assert.deepEqual(
        (yield* ingest(modelSelection.instanceId, "plan")).map((stored) => stored.event.type),
        ["thread.model-selection-updated"],
      );
      assert.deepEqual((yield* projectionStore.getThread(rootEvent.threadId)).modelSelection, {
        ...saved,
        options: [
          { id: "effort", value: "high" },
          { id: "mode", value: "default" },
        ],
      });
      assert.deepEqual(yield* ingest(modelSelection.instanceId, "plan"), []);
      assert.deepEqual(yield* ingest(ProviderInstanceId.make("other-instance"), "default"), []);
    }),
  );
});
