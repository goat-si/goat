import { assert, it } from "@effect/vitest";
import { CommandId, NodeId, TurnItemId, type OrchestrationV2Subagent } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelChildWork from "../channels/ChannelChildWork.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  driver,
  childModel,
  parentId,
  at,
  scope,
  providerMode,
  layerTest,
  nextEventId,
  recordProviderTurn,
  finishTask,
  childRuns,
  makeFixture,
  withService,
  continueInput,
  continued,
  sendUnbound,
} from "./OrchestratorMcpService.reviewContinuation.testkit.ts";

it.effect(
  "continueFrom starts a new review task in the same reviewer thread with its own ledger",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* withService(fixture, (service) =>
        Effect.gen(function* () {
          const created = yield* service.delegateTask(scope, continueInput(fixture));
          assert.notEqual(created.taskId, fixture.first.id);
          assert.equal(created.childThreadId, fixture.childThreadId);
          assert.equal(created.role, "review");
          assert.isUndefined(created.reviewLedger);
          assert.deepEqual(created.reviewRound, {
            continuedFrom: fixture.first.id,
            conversation: "starting",
            compacted: false,
          });
          const tasks = (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents;
          assert.lengthOf(tasks, 2);
          assert.lengthOf(tasks.find((task) => task.id === fixture.first.id)!.reviewLedger!, 1);
          const runs = yield* childRuns(fixture.childThreadId);
          assert.lengthOf(runs, 2);
          assert.equal(runs[1]!.delegatedTaskId, created.taskId);
          const messages = (yield* fixture.store.getThreadRecords(fixture.childThreadId, [
            "messages",
          ])).messages;
          assert.equal(
            messages.find((message) => message.id === runs[1]!.userMessageId)?.text,
            continueInput(fixture).task,
          );
          // A retry with the same clientRequestId returns the same round while it runs.
          const retried = yield* service.delegateTask(scope, continueInput(fixture));
          assert.equal(retried.taskId, created.taskId);
          assert.lengthOf(yield* childRuns(fixture.childThreadId), 2);
          // The same id aimed at another round is refused rather than replayed.
          const reused = yield* service
            .delegateTask(scope, continueInput(fixture, { continueFrom: NodeId.make("other") }))
            .pipe(Effect.flip);
          assert.equal(reused.code, "invalid_request");

          yield* recordProviderTurn({
            run: runs[1]!,
            nativeId: "native-1",
            turn: "completed",
            runStatus: "completed",
          });
          const status = yield* service.taskStatus(scope, created.taskId);
          assert.equal(status.reviewRound?.conversation, "continued");
          const fresh = yield* service.taskStatus(scope, fixture.first.id);
          assert.deepEqual(fresh.reviewRound, {
            continuedFrom: null,
            conversation: "new",
            compacted: false,
          });
          yield* service.recordReviewFindings(scope, {
            taskId: created.taskId,
            entries: [
              {
                kind: "decision",
                findingId: "f2",
                severity: "low",
                cites: null,
                summary: "Still open",
                decision: "accepted",
                evidence: null,
              },
            ],
          });
          const exported = yield* service.exportReviewFindings(scope, {
            from: "2026-10-29T00:00:00.000Z",
            to: "2026-10-31T00:00:00.000Z",
          });
          const lines = exported.jsonl
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { taskId: string; continuedFrom: string | null });
          assert.deepEqual(
            lines.map((line) => [line.taskId, line.continuedFrom]),
            [
              [fixture.first.id, null],
              [created.taskId, fixture.first.id],
            ].toSorted((left, right) => left[0]!.localeCompare(right[0]!)),
          );
        }),
      );
    }).pipe(Effect.provide(layerTest)),
);

const childTurnItemsOrdinal = 100;

it.effect.each([
  { name: "brief completed on the earlier conversation", expected: "continued" },
  { name: "resume moved the brief to another conversation", expected: "recovered" },
  { name: "a steering restart moved to another conversation", expected: "recovered" },
  { name: "a provider turn without a native thread id", expected: "unverified" },
  { name: "the brief never completed and the task failed", expected: "not_started" },
  { name: "only a steering restart completed", expected: "unverified" },
  { name: "the conversation was rolled back", expected: "rewound" },
] as const)("reviewRound reports $expected when $name", ({ name, expected }) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* continued(fixture);
    const run = (yield* childRuns(fixture.childThreadId))[1]!;
    const record = (
      nativeId: string | undefined,
      turn: "completed" | "failed",
      attemptOrdinal = 1,
    ) =>
      recordProviderTurn({
        run,
        nativeId,
        turn,
        attemptOrdinal,
        reason: attemptOrdinal === 1 ? "initial" : "steering_restart",
        runStatus: turn === "completed" ? "completed" : "failed",
      });
    let taskStatus: OrchestrationV2Subagent["status"] = "completed";
    switch (name) {
      case "brief completed on the earlier conversation":
        yield* record("native-1", "completed");
        break;
      case "resume moved the brief to another conversation":
        yield* record("native-2", "completed");
        break;
      case "a steering restart moved to another conversation":
        yield* record("native-1", "completed");
        yield* record("native-2", "completed", 2);
        break;
      case "a provider turn without a native thread id":
        yield* record(undefined, "completed");
        break;
      case "the brief never completed and the task failed":
        yield* record("native-1", "failed");
        taskStatus = "failed";
        break;
      case "only a steering restart completed":
        yield* record("native-1", "failed");
        yield* record("native-1", "completed", 2);
        break;
      case "the conversation was rolled back": {
        yield* record("native-1", "completed");
        const child = yield* fixture.store.getThread(fixture.childThreadId);
        yield* fixture.store.apply({
          id: nextEventId(),
          type: "thread.metadata-updated",
          threadId: fixture.childThreadId,
          occurredAt: at,
          payload: { ...child, rollbackRequestId: CommandId.make("rollback-later") },
        });
        break;
      }
    }
    yield* finishTask(created.taskId, taskStatus);
    const status = yield* withService(fixture, (service) =>
      service.taskStatus(scope, created.taskId),
    );
    assert.deepEqual(status.reviewRound, {
      continuedFrom: fixture.first.id,
      conversation: expected,
      compacted: false,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reviewRound reports a compaction GOAT recorded in the reviewer conversation", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* continued(fixture);
    const run = (yield* childRuns(fixture.childThreadId))[1]!;
    yield* fixture.store.apply({
      id: nextEventId(),
      type: "turn-item.updated",
      threadId: fixture.childThreadId,
      runId: run.id,
      occurredAt: at,
      payload: {
        id: TurnItemId.make("compaction-item"),
        threadId: fixture.childThreadId,
        runId: run.id,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: childTurnItemsOrdinal,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "compaction",
        driver,
      },
    });
    yield* recordProviderTurn({
      run,
      nativeId: "native-1",
      turn: "completed",
      runStatus: "completed",
    });
    const status = yield* withService(fixture, (service) =>
      service.taskStatus(scope, created.taskId),
    );
    assert.deepInclude(status.reviewRound, { conversation: "continued", compacted: true });
    // The compaction came after round 1, so round 1 does not report it.
    const first = yield* withService(fixture, (service) =>
      service.taskStatus(scope, fixture.first.id),
    );
    assert.deepInclude(first.reviewRound, { conversation: "new", compacted: false });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "omitted role", code: "invalid_request", says: "requires role" },
  { name: "another role", code: "invalid_request", says: "requires role" },
  { name: "a remote host", code: "invalid_request", says: "another machine" },
  { name: "worktree isolation", code: "invalid_request", says: "omit isolation" },
  { name: "a slash command brief", code: "invalid_request", says: "slash command" },
  { name: "an unknown task", code: "task_not_found", says: "not a delegated task" },
  { name: "another model", code: "invalid_request", says: "provider and model" },
  { name: "an unfinished earlier round", code: "invalid_request", says: "has not finished" },
  {
    name: "a running turn in the reviewer thread",
    code: "invalid_request",
    says: "running or queued",
  },
  { name: "an earlier brief that never completed", code: "invalid_request", says: "no record" },
  {
    name: "a replaced provider conversation",
    code: "invalid_request",
    says: "conversation changed",
  },
  { name: "a rollback request", code: "invalid_request", says: "rolled back" },
  { name: "a cloud provider", code: "invalid_request", says: "cannot continue a review" },
  { name: "an older round", code: "invalid_request", says: "latest review round" },
] as const)("continueFrom refuses $name and starts nothing", ({ name, code, says }) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const [firstRun] = yield* childRuns(fixture.childThreadId);
    let input: Record<string, unknown> = continueInput(fixture);
    switch (name) {
      case "omitted role":
        input = { ...input, role: undefined };
        break;
      case "another role":
        input = { ...input, role: "general" };
        break;
      case "a remote host":
        input = { ...input, target: { host: "box" }, remote: { cwd: "/repo" } };
        break;
      case "worktree isolation":
        input = { ...input, isolation: "worktree" };
        break;
      case "a slash command brief":
        input = { ...input, task: "/compact keep the tests" };
        break;
      case "an unknown task":
        input = { ...input, continueFrom: NodeId.make("missing-task") };
        break;
      case "another model":
        input = { ...input, target: { model: "other-model" } };
        break;
      case "an unfinished earlier round":
        yield* finishTask(fixture.first.id, "running");
        break;
      case "a running turn in the reviewer thread":
        yield* fixture.store.apply({
          id: nextEventId(),
          type: "run.updated",
          threadId: fixture.childThreadId,
          runId: firstRun!.id,
          occurredAt: at,
          payload: { ...firstRun!, status: "running" },
        });
        break;
      case "an earlier brief that never completed":
        yield* recordProviderTurn({
          run: firstRun!,
          nativeId: "native-1",
          turn: "failed",
          runStatus: "completed",
        });
        break;
      case "a replaced provider conversation":
        yield* recordProviderTurn({
          run: firstRun!,
          nativeId: "native-9",
          turn: "completed",
          attemptOrdinal: 2,
          reason: "steering_restart",
          runStatus: "completed",
        });
        break;
      case "a rollback request": {
        const child = yield* fixture.store.getThread(fixture.childThreadId);
        yield* fixture.store.apply({
          id: nextEventId(),
          type: "thread.metadata-updated",
          threadId: fixture.childThreadId,
          occurredAt: at,
          payload: { ...child, rollbackRequestId: CommandId.make("rollback-1") },
        });
        break;
      }
      case "a cloud provider":
        providerMode.cloud = true;
        break;
      case "an older round": {
        const second = yield* continued(fixture);
        const run = (yield* childRuns(fixture.childThreadId))[1]!;
        yield* recordProviderTurn({
          run,
          nativeId: "native-1",
          turn: "completed",
          runStatus: "completed",
        });
        yield* finishTask(second.taskId, "completed");
        input = { ...input, clientRequestId: "round-3" };
        break;
      }
    }
    const before = {
      tasks: (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents.length,
      runs: (yield* childRuns(fixture.childThreadId)).length,
    };
    const refused = yield* withService(fixture, (service) =>
      service.delegateTask(scope, input as Parameters<typeof service.delegateTask>[1]),
    ).pipe(Effect.flip);
    assert.equal(refused.code, code);
    assert.include(refused.message, says);
    assert.deepEqual(
      {
        tasks: (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents.length,
        runs: (yield* childRuns(fixture.childThreadId)).length,
      },
      before,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "the parent run ended",
  "the child is the parent",
  "the child's mode is above the caller's",
] as const)("the review-continue command commits nothing when %s", (name) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const command = {
      type: "delegated_task.review-continue" as const,
      commandId: CommandId.make("direct-continue"),
      threadId: parentId,
      parentRunId: fixture.parentRun.id,
      parentNodeId: fixture.parentRun.rootNodeId!,
      continueFrom: fixture.first.id,
      childThreadId: name === "the child is the parent" ? parentId : fixture.childThreadId,
      task: "Round 2",
      modelSelection: childModel,
      completionWake: "always" as const,
      memoryGrantCeiling: "none" as const,
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
    };
    let dispatch = fixture.orchestrator.dispatch(command);
    if (name === "the parent run ended") {
      const parentRun = (yield* fixture.store.getThreadRecords(parentId, ["runs"])).runs[0]!;
      yield* fixture.store.apply({
        id: nextEventId(),
        type: "run.updated",
        threadId: parentId,
        runId: parentRun.id,
        occurredAt: at,
        payload: { ...parentRun, status: "completed", completedAt: at },
      });
    }
    if (name === "the child's mode is above the caller's") {
      yield* fixture.orchestrator.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("parent-plan-mode"),
        threadId: parentId,
        interactionMode: "plan",
      });
      dispatch = dispatch.pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: "full-access",
          interactionMode: "plan",
        }),
      );
    }
    const before = (yield* childRuns(fixture.childThreadId)).length;
    const refused = yield* dispatch.pipe(Effect.flip);
    assert.include(
      ["OrchestratorDispatchError", "OrchestratorThreadAboveModeLimitError"],
      refused._tag,
    );
    if (name === "the child's mode is above the caller's")
      assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
    assert.lengthOf((yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents, 1);
    assert.lengthOf(yield* childRuns(fixture.childThreadId), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("goat_thread_send stays refused after a continued review round finishes", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* continued(fixture);
    const run = (yield* childRuns(fixture.childThreadId))[1]!;
    yield* recordProviderTurn({
      run,
      nativeId: "native-1",
      turn: "completed",
      runStatus: "completed",
    });
    yield* finishTask(created.taskId, "completed");
    const threads = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(
        ThreadManagementService.layer.pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
          Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
          Layer.provide(Layer.succeed(Orchestrator.OrchestratorV2, fixture.orchestrator)),
        ),
      ),
    );
    const refused = yield* threads
      .assertReviewTaskSendAllowed({
        threadId: fixture.childThreadId,
        senderThreadId: parentId,
        createdBy: "agent",
      })
      .pipe(Effect.flip);
    assert.equal(refused._tag, "ThreadManagementReviewTaskFinishedError");
    assert.include(refused.message, "continueFrom");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a /compact run after the round does not block continuing it", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* sendUnbound(fixture, "compact", "/compact");
    const created = yield* continued(fixture);
    assert.equal(created.reviewRound?.continuedFrom, fixture.first.id);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an unrelated run after the round blocks continuing it", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* sendUnbound(fixture, "unbound", "Something unrelated");
    const refused = yield* continued(fixture).pipe(Effect.flip);
    assert.include(refused.message, "latest review round");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a channel-owned caller is refused and its child-work reservation returns", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const released: Array<unknown> = [];
    const record = { id: "child-work-1" } as unknown as Parameters<
      ChannelChildWork.ChannelChildWork["Service"]["releaseReserved"]
    >[0];
    const refused = yield* continued(fixture).pipe(
      Effect.provide(
        Layer.mock(ChannelChildWork.ChannelChildWork)({
          admit: () => Effect.succeed({ _tag: "admitted", record, requestKey: "round-2" }),
          releaseReserved: (reserved) => Effect.sync(() => void released.push(reserved)),
        }),
      ),
      Effect.flip,
    );
    assert.include(refused.message, "channel-owned");
    assert.deepEqual(released, [record]);
    assert.lengthOf((yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents, 1);
    assert.lengthOf(yield* childRuns(fixture.childThreadId), 1);
  }).pipe(Effect.provide(layerTest)),
);
