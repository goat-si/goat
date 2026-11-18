import {
  EventId,
  MessageId,
  RunId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as EventStore from "./EventStore.ts";

export const layerTest = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const providerInstanceId = ProviderInstanceId.make("codex");
export const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

export const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

export const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: { readonly archivedAt?: DateTime.Utc; readonly deletedAt?: DateTime.Utc } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

export const threadId = ThreadId.make("thread:find");
export const projectId = ProjectId.make("project:find");
export const runId = RunId.make("run:find");

export function item(
  id: string,
  ordinal: number,
  text: string,
  kind: "user_message" | "assistant_message" | "proposed_plan" = "assistant_message",
  owner = threadId,
): Extract<
  OrchestrationV2TurnItem,
  { type: "user_message" | "assistant_message" | "proposed_plan" }
> {
  const base = {
    id: TurnItemId.make(id),
    threadId: owner,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at(100 - ordinal),
    completedAt: at(100 - ordinal),
    updatedAt: at(1),
  };
  if (kind === "proposed_plan")
    return { ...base, type: kind, planId: PlanId.make(id), markdown: text, streaming: false };
  if (kind === "user_message")
    return {
      ...base,
      type: kind,
      messageId: MessageId.make(id),
      text,
      inputIntent: "turn_start",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    };
  return { ...base, type: kind, messageId: MessageId.make(id), text, streaming: false };
}

export function run(
  owner = threadId,
  id = runId,
  ordinal = 1,
  status: OrchestrationV2Run["status"] = "completed",
): Extract<OrchestrationV2DomainEvent, { type: "run.created" }> {
  return {
    id: EventId.make(`run:${owner}:${id}:${status}`),
    threadId: owner,
    occurredAt: at(1),
    type: "run.created",
    payload: {
      id,
      threadId: owner,
      ordinal,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-6" },
      providerThreadId: null,
      userMessageId: MessageId.make("prompt"),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: at(1),
      startedAt: at(1),
      completedAt: at(2),
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

export const commit = Effect.fn("ThreadFindTest.commit")(function* (
  events: readonly OrchestrationV2DomainEvent[],
) {
  const store = yield* EventStore.EventStoreV2;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.append({ events });
  yield* Effect.forEach(events, projection.apply, { discard: true });
});
export const putItems = (items: readonly OrchestrationV2TurnItem[], version = "initial") =>
  commit(
    items.map((payload) => ({
      id: EventId.make(`${payload.threadId}:${payload.id}:${version}`),
      threadId: payload.threadId,
      occurredAt: at(1),
      type: "turn-item.updated" as const,
      payload,
    })),
  );
