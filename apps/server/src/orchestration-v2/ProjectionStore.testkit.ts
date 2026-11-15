import {
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
export const driver = ProviderDriverKind.make("codex");
export const providerInstanceId = modelSelection.instanceId;
export const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const D10_NOW = DateTime.makeUnsafe("2026-10-13T00:00:00.000Z");
export const encodeD10TurnItem = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2TurnItem));

export const createD10Thread = Effect.fn("createD10Thread")(function* (
  suffix: string,
  forkedFrom: OrchestrationV2AppThread["forkedFrom"] = null,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${suffix}`);
  yield* store.apply({
    id: EventId.make(`event:${suffix}:thread`),
    type: "thread.created",
    threadId,
    occurredAt: D10_NOW,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Pending window fixture",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom,
      createdAt: D10_NOW,
      updatedAt: D10_NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  return threadId;
});

export function d10DecisionFixture(threadId: ThreadId, suffix: string) {
  const base = {
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "waiting" as const,
    title: null,
    startedAt: D10_NOW,
    completedAt: null,
    updatedAt: D10_NOW,
  };
  const question = {
    ...base,
    id: TurnItemId.make(`${suffix}:question-item`),
    ordinal: 1,
    type: "user_input_request",
    requestId: RuntimeRequestId.make(`${suffix}:question`),
    responseMode: "message",
    questions: [
      {
        id: "q",
        header: "Choice",
        question: "Choose a destination",
        options: [{ label: "One", description: "First destination", value: "  native\t" }],
        multiSelect: false,
        allowCustomAnswer: true,
        initialAnswer: "  draft\n",
      },
    ],
  } satisfies OrchestrationV2TurnItem;
  const approval = {
    ...base,
    id: TurnItemId.make(`${suffix}:approval-item`),
    ordinal: 2,
    type: "approval_request",
    requestId: RuntimeRequestId.make(`${suffix}:approval`),
    requestKind: "command",
    prompt: "Run the requested command?",
    appName: "D10 fixture",
    options: [
      { decision: "acceptForSession", label: "Allow this session", warning: "Fixture caution" },
      { decision: "decline", label: "Decline" },
    ],
  } satisfies OrchestrationV2TurnItem;
  const requestBase = {
    nodeId: NodeId.make(`${suffix}:node`),
    providerTurnId: null,
    nativeRequestRef: null,
    status: "pending" as const,
    createdAt: D10_NOW,
    resolvedAt: null,
  };
  const requests: OrchestrationV2RuntimeRequest[] = [
    {
      ...requestBase,
      id: question.requestId,
      kind: "user_input",
      responseCapability: { type: "message" },
    },
    {
      ...requestBase,
      id: approval.requestId,
      kind: "command",
      responseCapability: {
        type: "live",
        providerSessionId: ProviderSessionId.make("d10-session"),
      },
    },
  ];
  return { question, approval, requests };
}

export function d10Command(threadId: ThreadId, suffix: string, ordinal: number) {
  return {
    id: TurnItemId.make(`${suffix}:item:${ordinal}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: D10_NOW,
    completedAt: D10_NOW,
    updatedAt: D10_NOW,
    type: "command_execution",
    input: "fixture",
    output: "fixture output",
    exitCode: 0,
  } satisfies OrchestrationV2TurnItem;
}

export const saveD10Request = Effect.fn("saveD10Request")(function* (
  threadId: ThreadId,
  request: OrchestrationV2RuntimeRequest,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`${request.id}:${request.status}`),
    type: "runtime-request.updated",
    threadId,
    occurredAt: D10_NOW,
    payload: request,
  });
});

export const saveD10Item = Effect.fn("saveD10Item")(function* (item: OrchestrationV2TurnItem) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`${item.id}:updated`),
    type: "turn-item.updated",
    threadId: item.threadId,
    ...(item.runId === null ? {} : { runId: item.runId }),
    ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
    driver,
    occurredAt: D10_NOW,
    payload: item,
  });
});

export const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") statements.push(query);
      };
      return span;
    },
  });
  return { statements, tracer };
};

export const addRolledBackRecoveryCandidate = Effect.fn("addRolledBackRecoveryCandidate")(
  function* (suffix: string) {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:${suffix}:rolled-back`);
    const runId = RunId.make(`run:${suffix}:rolled-back`);
    const rootNodeId = NodeId.make(`node:${suffix}:rolled-back`);
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${suffix}:rolled-back`),
      rootNodeId,
      activeAttemptId: null,
      status: "running" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };

    yield* projectionStore.apply({
      id: EventId.make(`event:${suffix}:thread-created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make(`project:${suffix}`),
        title: "Rolled-back recovery candidate",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    yield* projectionStore.apply({
      id: EventId.make(`event:${suffix}:run-created`),
      type: "run.created",
      threadId,
      runId,
      nodeId: rootNodeId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: run,
    });
    yield* projectionStore.apply({
      id: EventId.make(`event:${suffix}:item-running`),
      type: "turn-item.updated",
      threadId,
      runId,
      nodeId: rootNodeId,
      driver,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`item:${suffix}:rolled-back`),
        threadId,
        runId,
        nodeId: rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: "abandoned command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 60",
      },
    });
    yield* projectionStore.apply({
      id: EventId.make(`event:${suffix}:run-rolled-back`),
      type: "run.updated",
      threadId,
      runId,
      nodeId: rootNodeId,
      driver,
      occurredAt: now,
      payload: { ...run, status: "rolled_back", completedAt: now },
    });

    return threadId;
  },
);
