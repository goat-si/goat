import { assert, it } from "@effect/vitest";
import { CommandId, type OrchestrationV2Run } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  childModel,
  parentId,
  at,
  scope,
  layerTestWithSql,
  nextEventId,
  recordProviderTurn,
  finishTask,
  childRuns,
  makeFixture,
  type ServiceOptions,
  withService,
  continueInput,
} from "./OrchestratorMcpService.reviewContinuation.testkit.ts";

it.effect(
  "a lane claimed for a continuation that fails to commit is released, and a retry replays the refusal",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const [firstRun] = yield* childRuns(fixture.childThreadId);
      const setFirstRun = (status: OrchestrationV2Run["status"]) =>
        fixture.store
          .apply({
            id: nextEventId(),
            type: "run.updated",
            threadId: fixture.childThreadId,
            runId: firstRun!.id,
            occurredAt: at,
            payload: { ...firstRun!, status, completedAt: at },
          })
          .pipe(Effect.orDie);
      // A user message reaches the reviewer between MCP preflight and commit.
      const race: ServiceOptions["race"] = { current: setFirstRun("running") };
      const sql = yield* SqlClient.SqlClient;
      const lanes = () => sql<{ pending: number }>`SELECT pending FROM goatclaw_lane_reservations`;
      yield* withService(
        fixture,
        (service) =>
          Effect.gen(function* () {
            const first = yield* service
              .delegateTask(scope, continueInput(fixture))
              .pipe(Effect.flip);
            assert.equal(first.code, "invalid_request");
            assert.include(first.message, "running or queued");
            assert.lengthOf(yield* lanes(), 0);
            yield* setFirstRun("completed");
            const replayed = yield* service
              .delegateTask(scope, continueInput(fixture))
              .pipe(Effect.flip);
            assert.equal(replayed.code, "invalid_request");
            assert.lengthOf(yield* lanes(), 0);
            // With the lane free, a new request continues the reviewer within maxLanes 1.
            const created = yield* service.delegateTask(
              scope,
              continueInput(fixture, { clientRequestId: "round-2b" }),
            );
            assert.equal(created.childThreadId, fixture.childThreadId);
            assert.deepEqual(
              (yield* lanes()).map((lane) => lane.pending),
              [0],
            );
          }),
        { goatclaw: true, race },
      );
      assert.lengthOf(
        (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents,
        2,
      );
    }).pipe(Effect.provide(layerTestWithSql)),
);

it.effect.each(["an interrupted call", "two concurrent calls"] as const)(
  "%s with one clientRequestId leave one round holding one lane",
  (name) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const sql = yield* SqlClient.SqlClient;
      const lanes = () => sql<{ pending: number }>`SELECT pending FROM goatclaw_lane_reservations`;
      const race: ServiceOptions["race"] = {
        current: name === "an interrupted call" ? Effect.interrupt : undefined,
      };
      yield* withService(
        fixture,
        (service) =>
          Effect.gen(function* () {
            if (name === "an interrupted call") {
              const exit = yield* Effect.exit(service.delegateTask(scope, continueInput(fixture)));
              assert.isTrue(exit._tag === "Failure");
              assert.lengthOf(yield* lanes(), 0);
              yield* service.delegateTask(scope, continueInput(fixture));
            } else {
              const [left, right] = yield* Effect.all(
                [
                  service.delegateTask(scope, continueInput(fixture)),
                  service.delegateTask(scope, continueInput(fixture)),
                ],
                { concurrency: 2 },
              );
              assert.equal(left.taskId, right.taskId);
            }
            assert.deepEqual(
              (yield* lanes()).map((lane) => lane.pending),
              [0],
            );
          }),
        { goatclaw: true, race },
      );
      assert.lengthOf(
        (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents,
        2,
      );
    }).pipe(Effect.provide(layerTestWithSql)),
);

it.effect(
  "a call that read the tasks before a same-id round committed cannot move that round's lane",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      // A second finished reviewer, so the two calls name different earlier rounds.
      yield* fixture.orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("review-round-1b"),
        parentThreadId: parentId,
        parentRunId: fixture.parentRun.id,
        parentNodeId: fixture.parentRun.rootNodeId!,
        task: "Review the docs",
        role: "review",
        modelSelection: childModel,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const other = (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents.find(
        (task) => task.id !== fixture.first.id,
      )!;
      const [otherRun] = yield* childRuns(other.childThreadId!);
      yield* recordProviderTurn({
        run: otherRun!,
        nativeId: "native-other",
        turn: "completed",
        runStatus: "completed",
      });
      yield* finishTask(other.id, "completed");
      const before = (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents;
      const staleTasks: ServiceOptions["staleTasks"] = { current: undefined };
      const sql = yield* SqlClient.SqlClient;
      const lanes = () =>
        sql<{
          child_thread_id: string | null;
        }>`SELECT child_thread_id FROM goatclaw_lane_reservations`;
      yield* withService(
        fixture,
        (service) =>
          Effect.gen(function* () {
            yield* service.delegateTask(scope, continueInput(fixture));
            staleTasks.current = before;
            const refused = yield* service
              .delegateTask(scope, continueInput(fixture, { continueFrom: other.id }))
              .pipe(Effect.flip);
            assert.include(refused.message, "different review round");
            assert.deepEqual(
              (yield* lanes()).map((lane) => lane.child_thread_id),
              [fixture.childThreadId],
            );
          }),
        { goatclaw: true, staleTasks },
      );
    }).pipe(Effect.provide(layerTestWithSql)),
);
