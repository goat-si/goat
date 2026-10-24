import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  RunId,
  TurnItemId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { registerCredentialRunTag } from "../mcp/goatCredentialRedaction.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "event-store-redaction-" })),
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

const seedThread = (fixtureName: string) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({ fixtureName });
    const threadId = yield* idAllocator.allocate.thread({ fixtureName, projectId });
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
    return threadId;
  });

it.layer(layerTest)("orchestration event log credential redaction", (it) => {
  it.effect("persists a provider's command row without the GOAT MCP token it printed", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadId = yield* seedThread("redaction-command");
      const runId = RunId.make("run:redaction-command");
      const itemId = TurnItemId.make("turn-item:redaction-command");
      const turnItem = {
        id: itemId,
        threadId,
        runId,
        nodeId: NodeId.make("node:redaction-command"),
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

  // Run finalization, cloud results and MCP-driven messages write without the ingestor.
  it.effect("stores and projects an event written straight to the sink without the token", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadId = yield* seedThread("redaction-message");
      const messageId = MessageId.make("message:redaction");
      const stored = yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "message.updated",
            threadId,
            occurredAt: now,
            payload: {
              createdBy: "agent",
              creationSource: "provider",
              id: messageId,
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
        ],
      });
      const projection = yield* projectionStore.getThreadProjection(threadId);

      const logged = stored[0]?.event;
      assert.equal(
        logged?.type === "message.updated" ? logged.payload.text : undefined,
        "Your token is [redacted].",
      );
      assert.equal(
        projection.messages.find((message) => message.id === messageId)?.text,
        "Your token is [redacted].",
      );
    }),
  );

  it.effect("stores a project event an agent named with the token without it", () =>
    Effect.gen(function* () {
      const eventStore = yield* EventStore.EventStoreV2;
      const now = "2026-10-24T00:00:00.000Z";
      const projectId = ProjectId.make("project:redaction");
      const stored = yield* eventStore.appendProjectEvent({
        type: "project.created",
        eventId: EventId.make("event:project-redaction"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.make("command:project-redaction"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: `Debug ${TOKEN}`,
          workspaceRoot: "/tmp/project-redaction",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      assert.equal(
        stored.type === "project.created" ? stored.payload.title : undefined,
        "Debug [redacted]",
      );
    }),
  );
});
