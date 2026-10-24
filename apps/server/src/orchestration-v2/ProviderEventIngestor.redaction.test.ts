import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  TurnItemId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { registerCredentialRunTag } from "../mcp/goatCredentialRedaction.ts";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ingestor-redaction-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layerDependencies = Layer.mergeAll(
  layerTestStores,
  layerTestEventSink,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  layerGit,
);
const layerTest = Layer.mergeAll(
  layerDependencies,
  ProviderEventIngestor.layer.pipe(Layer.provide(layerDependencies)),
);

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");
// Synthetic, shaped like an issued MCP credential.
const TOKEN = "testtag0SyntheticMcpTokenNotARealCredential00000000";
registerCredentialRunTag("testtag0");

it.layer(layerTest)("ProviderEventIngestorV2 credential redaction", (it) => {
  it.effect("persists a command row's env dump without the GOAT MCP token", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const projectId = yield* idAllocator.allocate.project({ fixtureName: "redaction" });
      const threadId = yield* idAllocator.allocate.thread({ fixtureName: "redaction", projectId });
      const thread: OrchestrationV2AppThread = {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId,
        title: "Credential redaction",
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        branchPullRequest: null,
        activeOrderKey: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      const runId = RunId.make("run:provider-event-redaction");
      const itemId = TurnItemId.make("turn-item:provider-event-redaction");
      const turnItem = {
        id: itemId,
        threadId,
        runId,
        nodeId: NodeId.make("node:provider-event-redaction"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "command_execution",
        input: "env",
        output: `HOME=/home/agent\nGOAT_ACP_MCP_AUTHORIZATION=Bearer ${TOKEN}\n`,
      } satisfies OrchestrationV2TurnItem;

      yield* ingestor.ingestNormalized({
        providerSessionId: yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        }),
        providerInstanceId: modelSelection.instanceId,
        threadId,
        runId,
        event: { type: "turn_item.updated", driver: CODEX_DRIVER, turnItem },
      });
      const projection = yield* projectionStore.getThreadProjection(threadId);
      const persisted = projection.turnItems.find((item) => item.id === itemId);

      assert.equal(
        persisted?.type === "command_execution" ? persisted.output : undefined,
        "HOME=/home/agent\nGOAT_ACP_MCP_AUTHORIZATION=Bearer [redacted]\n",
      );
    }),
  );

  it.effect("redacts every provider record, such as an agent message repeating the token", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const projectId = yield* idAllocator.allocate.project({ fixtureName: "redaction-message" });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "redaction-message",
        projectId,
      });
      const events = yield* ingestor.normalize({
        providerSessionId: yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        }),
        providerInstanceId: modelSelection.instanceId,
        threadId,
        event: {
          type: "message.updated",
          driver: CODEX_DRIVER,
          message: {
            createdBy: "agent",
            creationSource: "provider",
            id: MessageId.make("message:redaction"),
            threadId,
            runId: null,
            nodeId: null,
            role: "assistant",
            text: `Your token is ${TOKEN}.`,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      });

      const payload = events[0]?.type === "message.updated" ? events[0].payload : undefined;
      assert.equal(payload?.text, "Your token is [redacted].");
    }),
  );
});
