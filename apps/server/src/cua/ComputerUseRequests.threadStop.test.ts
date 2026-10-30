import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderTurnId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { makeComputerUseStop } from "../orchestration-v2/goat/ComputerUseStop.ts";
import {
  instanceId,
  threadId as runningThreadId,
  withHarness,
} from "../handoffs/Handoffs.testkit.ts";
import {
  requestWithHandoffs,
  sessionId,
  supported,
  withRequests,
} from "./ComputerUseRequests.testkit.ts";

it.effect("replaying a completed Stop does not revoke a newer session", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<Handoffs.Handoffs["Service"]>();
    yield* withHarness(
      ({ orchestrator, worker }) =>
        withRequests(orchestrator, supported, ({ request, handoffs }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(ready, handoffs);
            const commandId = CommandId.make("replay-stop");
            yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId,
              threadId: runningThreadId,
            });
            yield* worker.drain();
            const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(commandId);
            const stop = effects.find((effect) => effect.request.type === "computer-use.stop");
            if (stop === undefined) return assert.fail("expected stop effect");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("after-stop"),
              threadId: runningThreadId,
              messageId: MessageId.make("message:after-stop"),
              text: "Continue",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();
            const first = yield* request({ apps: ["com.example.Editor"] });
            if (first.kind !== "needs_human") return assert.fail("expected approval");
            yield* handoffs.respond(
              {
                threadId: runningThreadId,
                handoffId: first.handoff.handoffId,
                action: "completed",
                computerUseScope: "session",
              },
              sessionId,
            );
            const replay = yield* makeComputerUseStop.pipe(
              Effect.provideService(Handoffs.Handoffs, handoffs),
            );
            yield* replay(stop);
            assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
          }),
        ),
      Layer.mock(Handoffs.Handoffs)({
        stopComputerUseSessions: (id, cutoff) =>
          Deferred.await(ready).pipe(
            Effect.flatMap((handoffs) => handoffs.stopComputerUseSessions(id, cutoff)),
          ),
      }),
    );
  }),
);

it.effect("thread Stop with no active turn clears the session choice", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<Handoffs.Handoffs["Service"]>();
    yield* withHarness(
      ({ orchestrator, worker }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("thread:stop-without-turn");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-idle-stop"),
            threadId,
            projectId: ProjectId.make("project:handoff-tests"),
            title: "Idle",
            modelSelection: { instanceId, model: "fake" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO computer_use_session_approvals (thread_id, app_key) VALUES (${threadId}, 'com.example.editor')`;
          yield* withRequests(orchestrator, supported, ({ handoffs }) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(ready, handoffs);
              yield* orchestrator.dispatch({
                type: "thread.stop",
                commandId: CommandId.make("stop-idle"),
                threadId,
              });
              yield* worker.drain();
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make("restart-idle"),
                threadId,
                messageId: MessageId.make("message:restart-idle"),
                text: "Continue",
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
              yield* worker.drain();
              assert.equal(
                (yield* requestWithHandoffs(handoffs, threadId)({ apps: ["com.example.Editor"] }))
                  .kind,
                "needs_human",
              );
            }),
          );
        }),
      Layer.mock(Handoffs.Handoffs)({
        stopComputerUseSessions: (id, cutoff) =>
          Deferred.await(ready).pipe(
            Effect.flatMap((handoffs) => handoffs.stopComputerUseSessions(id, cutoff)),
          ),
      }),
    );
  }),
);

it.effect.each(["running", "waiting", "idle"] as const)(
  "thread Stop revokes an approval from a %s thread and ignores its old mention",
  (state) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<Handoffs.Handoffs["Service"]>();
      yield* withHarness(
        ({ orchestrator, worker }) =>
          Effect.gen(function* () {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("old-named"),
              threadId: runningThreadId,
              messageId: MessageId.make("message:old-named"),
              text: "Use com.example.Editor",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(ready, handoffs);
                const first = yield* request({ apps: ["com.example.Editor"] });
                if (first.kind !== "needs_human") return assert.fail("expected approval");
                yield* handoffs.respond(
                  {
                    threadId: runningThreadId,
                    handoffId: first.handoff.handoffId,
                    action: "completed",
                    computerUseScope: "session",
                  },
                  sessionId,
                );
                if (state === "running") {
                  const projection = yield* orchestrator.getThreadProjection(runningThreadId);
                  const run = projection.runs.find((item) => item.status === "running");
                  if (!run || !run.providerThreadId || !run.activeAttemptId || !run.rootNodeId)
                    return assert.fail("expected running provider target");
                  const now = yield* DateTime.now;
                  yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
                    id: EventId.make("event:running-provider-turn"),
                    type: "provider-turn.updated",
                    threadId: runningThreadId,
                    occurredAt: now,
                    payload: {
                      id: ProviderTurnId.make("provider-turn:stop-test"),
                      providerThreadId: run.providerThreadId,
                      nodeId: run.rootNodeId,
                      runAttemptId: run.activeAttemptId,
                      nativeTurnRef: null,
                      ordinal: 1,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }
                if (state !== "running") {
                  const projections = yield* ProjectionStore.ProjectionStoreV2;
                  const projection = yield* orchestrator.getThreadProjection(runningThreadId);
                  const run = projection.runs.find((candidate) => candidate.status === "running");
                  if (run === undefined) return assert.fail("expected running run");
                  const now = yield* DateTime.now;
                  yield* projections.apply({
                    type: "run.updated",
                    id: EventId.make(`event:stop-${state}`),
                    threadId: runningThreadId,
                    occurredAt: now,
                    payload: {
                      ...run,
                      status: state === "idle" ? "completed" : "waiting",
                      completedAt: state === "idle" ? now : null,
                    },
                  });
                }
                yield* orchestrator.dispatch({
                  type: "thread.stop",
                  commandId: CommandId.make(`stop-${state}`),
                  threadId: runningThreadId,
                });
                if (state === "running") {
                  const sql = yield* SqlClient.SqlClient;
                  const effects = yield* sql<{
                    effect_type: string;
                  }>`SELECT effect_type FROM orchestration_v2_effect_outbox
                    WHERE command_id = ${CommandId.make(`stop-${state}`)} ORDER BY rowid`;
                  assert.deepEqual(
                    effects.slice(0, 2).map((effect) => effect.effect_type),
                    ["computer-use.stop", "provider-turn.interrupt"],
                  );
                  yield* worker.drain(1);
                  assert.lengthOf(
                    yield* sql`SELECT thread_id FROM computer_use_session_approvals WHERE thread_id = ${runningThreadId}`,
                    0,
                  );
                  const projections = yield* ProjectionStore.ProjectionStoreV2;
                  const projection = yield* orchestrator.getThreadProjection(runningThreadId);
                  const turn = projection.providerTurns.find(
                    (item) => item.id === ProviderTurnId.make("provider-turn:stop-test"),
                  );
                  const run = projection.runs.find((item) => item.status === "running");
                  if (!turn || !run) return assert.fail("expected running turn and run");
                  const now = yield* DateTime.now;
                  yield* projections.apply({
                    id: EventId.make("event:provider-turn-terminal"),
                    type: "provider-turn.updated",
                    threadId: runningThreadId,
                    occurredAt: now,
                    payload: { ...turn, status: "completed", completedAt: now },
                  });
                  yield* projections.apply({
                    id: EventId.make("event:run-terminal"),
                    type: "run.updated",
                    threadId: runningThreadId,
                    occurredAt: now,
                    payload: { ...run, status: "completed", completedAt: now },
                  });
                }
                yield* worker.drain();
                yield* orchestrator.dispatch({
                  type: "message.dispatch",
                  commandId: CommandId.make(`continue-${state}`),
                  threadId: runningThreadId,
                  messageId: MessageId.make(`message:continue-${state}`),
                  text: "Continue",
                  attachments: [],
                  dispatchMode: { type: "start_immediately" },
                  createdBy: "user",
                  creationSource: "web",
                });
                yield* worker.drain();
                assert.equal(
                  (yield* request({ apps: ["com.example.Editor"] })).kind,
                  "needs_human",
                );
                yield* orchestrator.dispatch({
                  type: "message.dispatch",
                  commandId: CommandId.make(`new-named-${state}`),
                  threadId: runningThreadId,
                  messageId: MessageId.make(`message:new-named-${state}`),
                  text: "Use com.example.Editor",
                  attachments: [],
                  dispatchMode: { type: "queue_after_active" },
                  createdBy: "user",
                  creationSource: "web",
                });
                assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
              }),
            );
          }),
        Layer.mock(Handoffs.Handoffs)({
          stopComputerUseSessions: (id, cutoff) =>
            Deferred.await(ready).pipe(
              Effect.flatMap((handoffs) => handoffs.stopComputerUseSessions(id, cutoff)),
            ),
        }),
      );
    }),
);
