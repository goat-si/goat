import {
  CommandId,
  OrchestrationV2QuestionEscalation,
  type UserInputRespondedBy,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { runOrchestratorV2Scenario } from "./testkit/OrchestratorScenario.ts";
import * as QuestionEscalationService from "./QuestionEscalationService.ts";

export const decodeQuestion = Schema.decodeUnknownEffect(OrchestrationV2QuestionEscalation);
export const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5" };
export const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Projection tests never open a provider process"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerBase = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "question-escalation" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
export const layerTest = Layer.mergeAll(
  layerBase,
  ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerBase,
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      ),
    ),
  ),
);
const create = (
  threadId: ThreadId,
  launcher?: NonNullable<OrchestrationV2AppThread["launchedBy"]>,
) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${threadId}`),
  threadId,
  projectId: ProjectId.make("project:question-escalation"),
  title: String(threadId),
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
  ...(launcher === undefined ? {} : { launchedBy: launcher }),
});
export const setup = (suffix: string, launcher = true) =>
  runOrchestratorV2Scenario({
    name: "question-escalation/setup",
    commands: [
      create(ThreadId.make(`launcher:${suffix}`)),
      create(
        ThreadId.make(`asking:${suffix}`),
        launcher
          ? {
              kind: "launch" as const,
              environmentLabel: null,
              threadTitle: null,
              threadId: ThreadId.make(`launcher:${suffix}`),
              environmentId: null,
              via: "thread_launch",
            }
          : undefined,
      ),
    ],
    projectionThreadIds: [ThreadId.make(`launcher:${suffix}`), ThreadId.make(`asking:${suffix}`)],
  });
export const questionEvents = (suffix: string) =>
  Effect.gen(function* () {
    const askingId = ThreadId.make(`asking:${suffix}`);
    const requestId = RuntimeRequestId.make(`request:${suffix}`);
    const now = yield* DateTime.now;
    const nodeId = NodeId.make(`node:${suffix}`);
    const events = [
      {
        id: EventId.make(`question:${suffix}:node`),
        type: "node.updated",
        threadId: askingId,
        nodeId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId: askingId,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      },
      {
        id: EventId.make(`question:${suffix}:request`),
        type: "runtime-request.updated",
        threadId: askingId,
        nodeId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      },
      {
        id: EventId.make(`question:${suffix}:item`),
        type: "turn-item.updated",
        threadId: askingId,
        nodeId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:${suffix}`),
          type: "user_input_request",
          threadId: askingId,
          runId: null,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "waiting",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          requestId,
          responseMode: "message",
          questions: [
            {
              id: "color",
              header: "Color",
              question: "Which color?",
              options: [{ label: "Blue", description: "Use blue" }],
              multiSelect: false,
            },
          ],
        },
      },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
    return events;
  });

export const ids = (suffix: string) => ({
  launcherId: ThreadId.make(`launcher:${suffix}`),
  askingId: ThreadId.make(`asking:${suffix}`),
  requestId: RuntimeRequestId.make(`request:${suffix}`),
  messageId: MessageId.make(`question-escalation:asking:${suffix}:request:${suffix}`),
  resolutionId: MessageId.make(`question-resolution:asking:${suffix}:request:${suffix}`),
});
export const start = Effect.gen(function* () {
  const service = yield* QuestionEscalationService.QuestionEscalationService;
  yield* service.start();
  yield* service.awaitSubscribed;
  return service;
});
export const records = (suffix: string) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return yield* projections.getThreadRecords(ids(suffix).launcherId, ["messages", "runs"]);
  });
export const seed = (suffix: string, events?: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const service = yield* QuestionEscalationService.QuestionEscalationService;
    const stored = yield* sink.write({ events: events ?? (yield* questionEvents(suffix)) });
    yield* Effect.forEach(stored, service.handleStoredEvent, { discard: true });
    return stored;
  });
// Arm an unbounded persisted-event subscription before the action that should produce it.
export const awaitEvent = (
  matches: (stored: import("@goat/contracts").OrchestrationV2StoredEvent) => boolean,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const ready = yield* Deferred.make<void>();
    const cursor = yield* sink.latestSequence();
    const fiber = yield* sink
      .stream({
        afterSequence: cursor,
        onSubscribed: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      })
      .pipe(Stream.filter(matches), Stream.take(1), Stream.runCollect, Effect.forkScoped);
    yield* Deferred.await(ready);
    return fiber;
  });
export const awaitMessage = (messageId: MessageId) =>
  awaitEvent(
    (stored) => stored.event.type === "message.updated" && stored.event.payload.id === messageId,
  );
export const holdLauncher = (suffix: string) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`hold:${suffix}`),
      messageId: MessageId.make(`hold:${suffix}`),
      threadId: ids(suffix).launcherId,
      text: "Active launcher work",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
    });
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`unrelated:${suffix}`),
      messageId: MessageId.make(`unrelated:${suffix}`),
      threadId: ids(suffix).launcherId,
      text: "Unrelated queued work",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
    });
  });
export const answer = (
  suffix: string,
  respondedBy: UserInputRespondedBy = { type: "user" },
  dismiss = false,
) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    yield* engine.dispatch(
      dismiss
        ? {
            type: "thread.user-input.dismiss",
            commandId: CommandId.make(`dismiss:${suffix}`),
            threadId: ids(suffix).askingId,
            requestId: ids(suffix).requestId,
            respondedBy,
          }
        : {
            type: "runtime-request.respond",
            commandId: CommandId.make(`answer:${suffix}`),
            threadId: ids(suffix).askingId,
            requestId: ids(suffix).requestId,
            answers: { color: "Blue" },
            respondedBy,
          },
    );
  });
