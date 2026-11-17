import { assert } from "@effect/vitest";
import {
  MessageId,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type ProjectId,
  RunId,
  type ThreadId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Statement from "effect/sql/Statement";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ServerSettings from "../../serverSettings.ts";
import * as Receipts from "../CommandReceiptStore.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { modelSelection } from "../ProviderSessionFixture.testkit.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";

// Exercise the real DTO decorator with the manager under test and committed
// destination state. Only the run fixture and unrelated transport ports are synthetic.
export const readPreparedRunDto = Effect.fnUntraced(function* (
  threadId: ThreadId,
  runId: RunId,
  delegatedTaskId: NodeId,
  pastRunCount = 0,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const committed = yield* Effect.serviceOption(ServerSettings.MemoryProviderCommittedPolicy);
  if (Option.isNone(committed)) return yield* Effect.die("test requires committed memory policy");
  const projection = yield* store.getThreadProjection(threadId);
  const run: OrchestrationV2Run = {
    id: runId,
    delegatedTaskId,
    threadId,
    ordinal: 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("reattach-message"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: projection.thread.createdAt,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    memoryGrantCeiling: "read_write",
  };
  const runs = [
    ...Array.from({ length: pastRunCount }, (_, index) => ({
      ...run,
      id: RunId.make(`historical-run-${index}`),
      ordinal: index + 2,
    })),
    run,
  ];
  let threadReads = 0;
  const countThreadReads: Statement.Transformer = (statement) => {
    const [query] = statement.compile();
    if (query.includes("SELECT payload_json FROM orchestration_v2_projection_threads")) {
      threadReads++;
    }
    return Effect.succeed(statement);
  };
  return yield* Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const records = yield* threads.getThreadRecords(threadId, ["runs"]);
    if (pastRunCount > 0) {
      assert.equal(threadReads, 1);
      for (const historical of records.runs.slice(0, -1)) {
        assert.notProperty(historical, "currentMemoryAccess");
      }
    }
    return records.runs.at(-1)!;
  }).pipe(
    Effect.provide(
      ThreadManagement.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, manager),
            Layer.succeed(ServerSettings.ServerSettingsService, settings),
            Layer.succeed(ServerSettings.MemoryProviderCommittedPolicy, committed.value),
            Layer.mock(Receipts.CommandReceiptStoreV2)({}),
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () => Effect.succeed({ ...projection, runs }),
            }),
          ),
        ),
      ),
    ),
    Effect.provideService(Statement.CurrentTransformer, countThreadReads),
  );
});
export function makeThreadCreatedEvent(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly projectId?: ProjectId;
  readonly delegatedBy?: ThreadId;
}) {
  return Effect.gen(function* () {
    const projectId =
      input.projectId ??
      (yield* input.idAllocator.allocate.project({
        fixtureName: "provider-session-manager",
      }));
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId,
      title: "Provider session manager",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage:
        input.delegatedBy === undefined
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId }
          : {
              parentThreadId: input.delegatedBy,
              relationshipToParent: "subagent",
              rootThreadId: input.delegatedBy,
            },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return {
      id: yield* input.idAllocator.allocate.event({ threadId: input.threadId }),
      type: "thread.created" as const,
      threadId: input.threadId,
      occurredAt: input.now,
      payload: thread,
    };
  });
}
