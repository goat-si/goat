import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;

const questionRecoveryFixture = (
  suffix: string,
  options: {
    launchedBy?: "local" | "remote" | "none";
    launcherThreadId?: ThreadId;
    requestId?: RuntimeRequestId;
    legacy?: "app_owned" | "provider_native" | "unproven" | "wrong_parent";
    archived?: boolean;
    deleted?: boolean;
    status?: OrchestrationV2RuntimeRequest["status"];
    kind?: OrchestrationV2RuntimeRequest["kind"];
  } = {},
) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`question-recovery:${suffix}`);
    const parentId = ThreadId.make("question-recovery:parent");
    const requestId = options.requestId ?? RuntimeRequestId.make(`question-recovery:${suffix}`);
    const nodeId = NodeId.make(`question-recovery:${suffix}`);
    const thread: OrchestrationV2AppThread = {
      createdBy: "agent",
      creationSource: options.legacy === "provider_native" ? "provider" : "mcp",
      id: threadId,
      projectId: ProjectId.make("project:question-recovery"),
      title: suffix,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: options.legacy ? parentId : null,
        relationshipToParent: options.legacy ? "subagent" : null,
        rootThreadId: parentId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: options.archived ? now : null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: options.deleted ? now : null,
      ...(options.launchedBy === "none" || (options.legacy && options.launchedBy === undefined)
        ? {}
        : {
            launchedBy: {
              kind: "launch" as const,
              environmentLabel: null,
              threadTitle: null,
              threadId: options.launcherThreadId ?? parentId,
              environmentId: options.launchedBy === "remote" ? EnvironmentId.make("remote") : null,
              via: "thread_launch",
            },
          }),
    };
    yield* store.apply({
      id: EventId.make(`${threadId}:created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    });
    yield* store.apply({
      id: EventId.make(`${requestId}:request`),
      type: "runtime-request.updated",
      threadId,
      nodeId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: options.kind ?? "user_input",
        status: options.status ?? "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: options.status && options.status !== "pending" ? now : null,
      },
    });
    if (options.legacy && options.legacy !== "unproven") {
      const ownerId =
        options.legacy === "wrong_parent"
          ? ThreadId.make("question-recovery:wrong-parent")
          : parentId;
      const owner = yield* store.getThreadShell(ownerId);
      if (owner === null)
        yield* store.apply({
          id: EventId.make(`${ownerId}:created`),
          type: "thread.created",
          threadId: ownerId,
          occurredAt: now,
          payload: {
            ...thread,
            id: ownerId,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ownerId },
          },
        });
      yield* store.apply({
        id: EventId.make(`${nodeId}:task`),
        type: "subagent.updated",
        threadId: ownerId,
        nodeId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId: ownerId,
          runId: null,
          parentNodeId: NodeId.make(`${ownerId}:root`),
          origin: options.legacy === "provider_native" ? "provider_native" : "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId: threadId,
          nativeTaskRef: null,
          prompt: "Task",
          title: null,
          model: null,
          status: "waiting",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
    }
    return { threadId, requestId };
  });
const selectQuestionRecovery = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const expected = [
    yield* questionRecoveryFixture("A"),
    yield* questionRecoveryFixture("a"),
    yield* questionRecoveryFixture("z:legacy", { legacy: "app_owned" }),
  ];
  yield* questionRecoveryFixture("no-launcher", { launchedBy: "none" });
  yield* questionRecoveryFixture("remote", { launchedBy: "remote" });
  yield* questionRecoveryFixture("remote-legacy", { launchedBy: "remote", legacy: "app_owned" });
  yield* questionRecoveryFixture("native", { launchedBy: "local", legacy: "provider_native" });
  yield* questionRecoveryFixture("unproven", { legacy: "unproven" });
  yield* questionRecoveryFixture("wrong-parent", { legacy: "wrong_parent" });
  yield* questionRecoveryFixture("archived", { archived: true });
  yield* questionRecoveryFixture("deleted", { deleted: true });
  for (const status of ["resolved", "expired", "cancelled"] as const)
    yield* questionRecoveryFixture(status, { status });
  for (const kind of [
    "command",
    "file-read",
    "file-change",
    "mcp-elicitation",
    "permission",
  ] as const)
    yield* questionRecoveryFixture(kind, { kind });
  const result = yield* store.getQuestionEscalationCandidates({ limit: 500 });
  assert.deepEqual(result, expected);
  assert.deepEqual(yield* store.getQuestionEscalationCandidates({ limit: 1 }), [expected[0]!]);
  return result;
});
it.effect("SQL and memory question recovery selection agree", () =>
  Effect.gen(function* () {
    const sql = yield* selectQuestionRecovery.pipe(Effect.provide(layerTest));
    const memory = yield* selectQuestionRecovery.pipe(Effect.provide(ProjectionStore.layerMemory));
    assert.deepEqual(sql, memory);
  }),
);
it.effect("caps startup question recovery at 500 in SQL and memory", () => {
  const verify = Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const first = yield* questionRecoveryFixture("000");
    for (let i = 1; i <= 500; i++) yield* questionRecoveryFixture(String(i).padStart(3, "0"));
    const result = yield* store.getQuestionEscalationCandidates({ limit: 1000 });
    assert.lengthOf(result, 500);
    assert.deepEqual(result[0], first);
    assert.equal(result.at(-1)?.requestId, RuntimeRequestId.make("question-recovery:499"));
  });
  return Effect.all(
    [
      verify.pipe(Effect.provide(layerTest)),
      verify.pipe(Effect.provide(ProjectionStore.layerMemory)),
    ],
    { discard: true },
  );
});

it.effect(
  "SQL and memory launched question queries match exact launcher identity and legacy ownership",
  () => {
    const verify = Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const launcherThreadId = ThreadId.make("question-recovery:parent");
      const first = yield* questionRecoveryFixture("A");
      const legacy = yield* questionRecoveryFixture("B", { legacy: "app_owned" });
      const remote = yield* questionRecoveryFixture("C", { launchedBy: "remote" });
      const sameRequestId = RuntimeRequestId.make("shared-request-A");
      const tieA = yield* questionRecoveryFixture("tie-A", { requestId: sameRequestId });
      const tieB = yield* questionRecoveryFixture("tie-B", {
        requestId: RuntimeRequestId.make("shared-request-B"),
      });
      yield* questionRecoveryFixture("other-launcher", {
        launcherThreadId: ThreadId.make("other"),
      });
      yield* questionRecoveryFixture("native", { launchedBy: "local", legacy: "provider_native" });
      yield* questionRecoveryFixture("unproven", { legacy: "unproven" });
      yield* questionRecoveryFixture("wrong-parent", { legacy: "wrong_parent" });
      yield* questionRecoveryFixture("archived", { archived: true });
      yield* questionRecoveryFixture("deleted", { deleted: true });
      yield* questionRecoveryFixture("approval", { kind: "command" });
      yield* questionRecoveryFixture("resolved", { status: "resolved" });
      const local = yield* store.getLaunchedPendingQuestions({
        launcherThreadId,
        launcherEnvironmentId: null,
        limit: 101,
      });
      assert.deepEqual(local, [first, legacy, tieA, tieB]);
      assert.deepEqual(
        yield* store.getLaunchedPendingQuestions({
          launcherThreadId,
          launcherEnvironmentId: EnvironmentId.make("remote"),
          limit: 101,
        }),
        [remote],
      );
      assert.deepEqual(
        yield* store.getLaunchedPendingQuestions({
          launcherThreadId,
          launcherEnvironmentId: EnvironmentId.make("wrong-environment"),
          limit: 101,
        }),
        [],
      );
      assert.deepEqual(
        yield* store.getLaunchedPendingQuestions({
          launcherThreadId,
          launcherEnvironmentId: null,
          limit: 1,
        }),
        [first],
      );
      return local;
    });
    return Effect.gen(function* () {
      const sql = yield* verify.pipe(Effect.provide(layerTest));
      const memory = yield* verify.pipe(Effect.provide(ProjectionStore.layerMemory));
      assert.deepEqual(sql, memory);
    });
  },
);

it.effect("SQL and memory restrict runtime request reads to explicit question IDs", () => {
  const verify = Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, requestId } = yield* questionRecoveryFixture("filtered");
    const question = yield* store.getRuntimeRequest(threadId, requestId);
    assert.isDefined(question);
    yield* store.apply({
      id: EventId.make("filtered:approval"),
      type: "runtime-request.updated",
      threadId,
      nodeId: question!.nodeId,
      occurredAt: question!.createdAt,
      payload: { ...question!, id: RuntimeRequestId.make("filtered:approval"), kind: "command" },
    });
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["runtimeRequests"], {
        runtimeRequestIds: [requestId],
      })).runtimeRequests.map((request) => request.id),
      [requestId],
    );
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["runtimeRequests"], { runtimeRequestIds: [] }))
        .runtimeRequests,
      [],
    );
    assert.lengthOf(
      (yield* store.getThreadRecords(threadId, ["runtimeRequests"])).runtimeRequests,
      2,
    );
  });
  return Effect.all(
    [
      verify.pipe(Effect.provide(layerTest)),
      verify.pipe(Effect.provide(ProjectionStore.layerMemory)),
    ],
    { discard: true },
  );
});
