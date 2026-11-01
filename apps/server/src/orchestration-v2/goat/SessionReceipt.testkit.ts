import {
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Foundation from "../FoundationPersistence.testkit.ts";
import * as EventSink from "../EventSink.ts";
import * as ProviderEventIngestor from "../ProviderEventIngestor.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";
import * as SessionReceiptGate from "./SessionReceiptGate.ts";
import {
  backgroundScenarioIds,
  makeRunOwnedSubagentNodeFixture,
  makeRunOwnedSubagentTurnItemFixture,
} from "../RunExecutionService.testkit.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";

export const layerNoProviderInstances = Layer.mock(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
)({
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - Optional instances require undefined rather than void.
  getInstance: () => Effect.succeed(undefined),
});

export const threadId = ThreadId.make("goat-bot-session:receipt:1");
export const runId = RunId.make("receipt-run");
const attemptId = RunAttemptId.make("receipt-attempt");
export const providerInstanceId = ProviderInstanceId.make("codex");
export const providerSessionId = ProviderSessionId.make("receipt-provider");
const layerIngestor = ProviderEventIngestor.layer.pipe(
  Layer.provide(layerNoProviderInstances),
  Layer.provideMerge(Foundation.layerTest),
  Layer.provide(
    Layer.mergeAll(Layer.mock(GitVcsDriver.GitVcsDriver)({}), ThreadCommandExecutor.layer),
  ),
);
export const layer = SessionReceiptGate.layer.pipe(Layer.provideMerge(layerIngestor));

export const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const now = DateTime.makeUnsafe(0);
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "test" },
    providerThreadId: null,
    userMessageId: MessageId.make("receipt-message"),
    rootNodeId: NodeId.make("receipt-root"),
    activeAttemptId: attemptId,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* sink.write({
    events: [
      Foundation.threadCreatedEvent({
        id: "receipt-thread-created",
        thread: Foundation.makeThread(threadId, now),
        now,
      }),
      {
        id: EventId.make("receipt-run-created"),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: run,
      },
    ],
  });
  yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
    VALUES ('receipt-conversation', 'owner', 'goat', 'goat', 'receipt-conversation', '1970-01-01')`;
  yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version, generation, task_json, created_at, updated_at)
    VALUES ('receipt-task', 'owner', 'receipt-conversation', 'running', 1, 1, '{"originInputId":"receipt-input"}', '1970-01-01', '1970-01-01')`;
  yield* sql`INSERT INTO channel_bot_session_runs (thread_id, message_id, task_id, task_generation, kind, run_id, created_at)
    VALUES (${threadId}, 'receipt-message', 'receipt-task', 1, 'task', ${runId}, '1970-01-01')`;
  yield* sql`INSERT INTO channel_outbox (delivery_id, cause_key, kind, destination_kind, message_json, state, next_attempt_at, created_at, updated_at)
    VALUES ('receipt-delivery', 'reply:receipt-input', 'reply', 'goat', '{}', 'delivering', '1970-01-01', '1970-01-01', '1970-01-01')`;
});

export const settle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE channel_outbox SET state = 'delivered' WHERE delivery_id = 'receipt-delivery'`;
  yield* (yield* SessionReceiptGate.SessionReceiptGate).changed;
});

export const question = (
  key: string,
  mode: "message" | "live",
  driverName = "codex",
  approval = false,
): ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> => {
  const driver = ProviderDriverKind.make(driverName);
  const ids = { ...backgroundScenarioIds(key), threadId, runId, attemptId };
  const requestId = RuntimeRequestId.make("request:" + key);
  const node = {
    ...makeRunOwnedSubagentNodeFixture({ ids, status: "running" }),
    kind: approval ? ("approval_request" as const) : ("user_input_request" as const),
    runtimeRequestId: requestId,
  };
  const baseItem = makeRunOwnedSubagentTurnItemFixture({
    ids,
    providerInstanceId,
    childThreadId: ids.childThreadId,
    driver,
    status: "running",
  });
  const item = approval
    ? { ...baseItem, type: "approval_request" as const, requestId, requestKind: "command" as const }
    : {
        ...baseItem,
        type: "user_input_request" as const,
        requestId,
        questions: [{ id: "q", header: "Branch", question: "Which branch?", options: [] }],
        ...(mode === "message" ? { responseMode: "message" as const } : {}),
      };
  const request: OrchestrationV2RuntimeRequest = {
    id: requestId,
    nodeId: node.id,
    providerTurnId: ids.rootProviderTurnId,
    nativeRequestRef: null,
    kind: approval ? "command" : "user_input",
    status: "pending",
    responseCapability:
      mode === "message" ? { type: "message" } : { type: "live", providerSessionId },
    createdAt: DateTime.makeUnsafe(0),
    resolvedAt: null,
  };
  return [
    { type: "node.updated", driver, node },
    { type: "turn_item.updated", driver, turnItem: item },
    { type: "runtime_request.updated", driver, threadId, runtimeRequest: request },
  ];
};
export const input = (
  event: ProviderAdapter.ProviderAdapterV2Event,
): ProviderEventIngestor.ProviderEventIngestInput & {
  readonly receiptAttemptId: RunAttemptId;
} => ({
  providerSessionId,
  providerInstanceId,
  threadId,
  runId,
  nodeId: NodeId.make("receipt-root"),
  receiptAttemptId: attemptId,
  event,
});
