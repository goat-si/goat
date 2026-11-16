import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { dispatchFailure } from "../mcp/threadAccess.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

const instanceId = ProviderInstanceId.make("codex");
const otherInstanceId = ProviderInstanceId.make("codex-other");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for selection controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerFor = (restart: boolean) =>
  Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "active-turn-refusals" },
      ProviderAdapterRegistry.layerFromAdapters([
        {
          ...adapter,
          planSelectionTransition: () =>
            Effect.succeed(
              restart
                ? { type: "restart_session" as const }
                : { type: "apply_on_next_turn" as const },
            ),
        },
        { ...adapter, instanceId: otherInstanceId },
      ]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  );

/** A thread with a live provider session and, when \`active\`, a running turn on it. */
const seedThread = (active: boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:active-turn");
    const now = yield* DateTime.now;
    const sessionId = ProviderSessionId.make("session:active-turn");
    const providerThreadId = ProviderThreadId.make("provider-thread:active-turn");
    const runId = RunId.make("run:active-turn");
    const nodeId = NodeId.make("node:active-turn");
    const attemptId = RunAttemptId.make("attempt:active-turn");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-active-turn"),
      threadId,
      projectId: ProjectId.make("project:active-turn"),
      title: "Active turn",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/repo",
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("active-turn:session"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("active-turn:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: adapter.driver,
          nativeId: "native:active-turn",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (active) {
      yield* projections.apply({
        id: EventId.make("active-turn:run"),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:active-turn"),
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make("active-turn:turn"),
        type: "provider-turn.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make("provider-turn:active-turn"),
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: { driver: adapter.driver, nativeId: "native:turn", strength: "strong" },
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
    }
    return { threadId, runId };
  });

const assertRefusedUnchanged = (
  threadId: ThreadId,
  commandId: CommandId,
  run: Effect.Effect<unknown, Orchestrator.OrchestratorV2Error, Orchestrator.OrchestratorV2>,
  reason: string,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const before = yield* projections.getThreadProjection(threadId);
    const sequence = yield* orchestrator.getThreadEventSequence(threadId);
    const outcome = yield* run.pipe(Effect.result);
    assert.ok(Result.isFailure(outcome));
    assert.instanceOf(outcome.failure, Orchestrator.OrchestratorDispatchError);
    assert.include(String(outcome.failure.cause), reason);
    // Every client, older ones included, shows this text; an agent's tool result carries it.
    const text = String(outcome.failure.cause);
    assert.equal(userFacingDispatchErrorMessage(outcome.failure), text);
    assert.deepInclude(dispatchFailure(outcome.failure), {
      code: "orchestration_error",
      message: text,
    });
    assert.deepEqual(yield* projections.getThreadProjection(threadId), before);
    assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
  });

it.effect.each(
  (["provider.switch", "thread.model-selection.set"] as const).flatMap((type) =>
    [
      { active: true, selectionChange: "instance" },
      { active: false, selectionChange: "instance" },
      { active: true, selectionChange: "next-turn" },
      { active: true, selectionChange: "restart" },
    ].map((scenario) => ({ type, ...scenario })),
  ),
)(
  "a $type $selectionChange that would end the live session is refused while a turn runs (active: $active)",
  ({ type, active, selectionChange }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { threadId } = yield* seedThread(active);
      const before = yield* projections.getThreadProjection(threadId);
      const commandId = CommandId.make("switch-selection");
      const target = {
        instanceId: selectionChange === "instance" ? otherInstanceId : instanceId,
        model: selectionChange === "instance" ? modelSelection.model : "gpt-6",
      };
      const dispatch = orchestrator.dispatch({ type, commandId, threadId, modelSelection: target });
      if (active && selectionChange !== "next-turn") {
        yield* assertRefusedUnchanged(threadId, commandId, dispatch, "has a turn running");
        return;
      }
      yield* dispatch;
      const after = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(after.thread.modelSelection, target);
      assert.equal(after.thread.providerInstanceId, target.instanceId);
      assert.deepEqual(after.runs, before.runs);
      assert.deepEqual(after.providerTurns, before.providerTurns);
    }).pipe(Effect.provide(layerFor(selectionChange === "restart"))),
);

it.effect.each([
  { case: "a person's change during a running turn", active: true, compareAndSet: false },
  { case: "the same change after the turn completed", active: false, compareAndSet: false },
  { case: "a compare-and-set rebind during a running turn", active: true, compareAndSet: true },
])("a worktree change ending the turn is refused: $case", ({ active, compareAndSet }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId } = yield* seedThread(active);
    const commandId = CommandId.make("change-worktree");
    const dispatch = orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId,
      threadId,
      worktreePath: "/other-worktree",
      ...(compareAndSet ? { expectedWorktreePath: "/repo" } : {}),
    });
    if (active && !compareAndSet) {
      yield* assertRefusedUnchanged(threadId, commandId, dispatch, "has a turn running");
      return;
    }
    yield* dispatch;
    assert.equal((yield* projections.getThread(threadId)).worktreePath, "/other-worktree");
  }).pipe(Effect.provide(layerFor(false))),
);

it.effect("a worktree handoff that queues the agent's continuation proceeds during its turn", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId } = yield* seedThread(true);
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("handoff-worktree"),
      threadId,
      worktreePath: "/handoff-worktree",
      continuation: { messageId: MessageId.make("message:handoff"), text: "Continue there" },
    });
    assert.equal((yield* projections.getThread(threadId)).worktreePath, "/handoff-worktree");
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    assert.equal(
      runs.find((run) => run.userMessageId === MessageId.make("message:handoff"))?.status,
      "queued",
    );
  }).pipe(Effect.provide(layerFor(false))),
);

it.effect.each([
  {
    case: "the mobile Git sheet's worktree change",
    update: { branch: "feature", worktreePath: "/mobile" },
  },
  { case: "a rename, as the MCP thread metadata tool sends", update: { title: "Renamed" } },
])("during a running turn: $case", ({ update }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId } = yield* seedThread(true);
    const commandId = CommandId.make("metadata-during-turn");
    const dispatch = orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId,
      threadId,
      ...update,
    });
    if ("worktreePath" in update) {
      yield* assertRefusedUnchanged(threadId, commandId, dispatch, "has a turn running");
      return;
    }
    yield* dispatch;
    const thread = yield* projections.getThread(threadId);
    assert.equal(thread.title, "Renamed");
    assert.equal(thread.worktreePath, "/repo");
  }).pipe(Effect.provide(layerFor(false))),
);
