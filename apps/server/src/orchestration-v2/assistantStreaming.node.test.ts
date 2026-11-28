import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeId, type OrchestrationV2ExecutionNode } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { AgentScope } from "@goat/shared/AgentScope";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeAssistantStreamingFilter } from "./assistantStreaming.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  CODEX_DRIVER,
  modelSelection,
  threadCreatedEvent,
} from "./ProviderEventIngestor.fixtures.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
const sink = EventSink.layer.pipe(Layer.provide(Layer.mergeAll(stores, database)));
const git = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "stream-node-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const instances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - Missing instances are undefined.
  getInstance: () => Effect.succeed(undefined),
});
const dependencies = Layer.mergeAll(
  Layer.succeed(AgentScope, AgentScope.defaultValue()),
  instances,
  stores,
  sink,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  git,
);
const testLayer = Layer.mergeAll(
  database,
  dependencies,
  ProviderEventIngestor.layer.pipe(Layer.provide(dependencies)),
);

it.layer(testLayer)("assistant node ingestion", (it) => {
  it.effect("persists changed running nodes and skips exact duplicates", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const thread = yield* threadCreatedEvent(now);
      yield* sink.write({ events: [thread] });
      const providerSessionId = yield* ids.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: thread.threadId,
      });
      const nodeId = NodeId.make(`${thread.threadId}:assistant`);
      const node: OrchestrationV2ExecutionNode = {
        id: nodeId,
        threadId: thread.threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "assistant_message",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const filter = makeAssistantStreamingFilter("paragraph");
      const ingest = (next: OrchestrationV2ExecutionNode) => {
        const event = filter({ type: "node.updated", driver: CODEX_DRIVER, node: next }, 0);
        return event === null
          ? Effect.succeed([])
          : ingestor.ingestNormalized({
              providerSessionId,
              providerInstanceId: modelSelection.instanceId,
              threadId: thread.threadId,
              event,
            });
      };
      assert.lengthOf(yield* ingest(node), 1);
      assert.isEmpty(yield* ingest(node));
      assert.lengthOf(yield* ingest({ ...node, countsForRun: true }), 1);
      const projection = yield* projections.getThreadProjection(thread.threadId);
      assert.isTrue(projection.nodes.find((entry) => entry.id === nodeId)?.countsForRun);
    }),
  );
});
