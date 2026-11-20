import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EventId, MessageId, ProjectId, ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerConfig from "../config.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadHistoryArchive from "./ThreadHistoryArchive.ts";
import { layerSharedApplicationDataPlaneTest, modelSelection } from "./runtimeLayer.testkit.ts";

it.layer(
  ThreadHistoryArchive.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "parked-hold-archive-" })),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(layerSharedApplicationDataPlaneTest),
  ),
)("recovery parked holds", (it) => {
  it.effect(
    "a later turn releases ordinary unattended work but keeps recovery-parked work held",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const projects = yield* ProjectService.ProjectService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const archive = yield* ThreadHistoryArchive.ThreadHistoryArchive;
          const projectId = ProjectId.make("recovery-park-project");
          const threadId = ThreadId.make("recovery-park-thread");
          yield* projects.create({
            commandId: CommandId.make("recovery-park-project-create"),
            projectId,
            title: "Test",
            workspaceRoot: "/tmp/recovery-park",
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("recovery-park-create"),
            threadId,
            projectId,
            title: "Test",
            createdBy: "user",
            creationSource: "web",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          const send = (key: string, mode: "start_immediately" | "queue_after_active") =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`recovery-park:${key}`),
              threadId,
              messageId: MessageId.make(`recovery-park:${key}`),
              text: key,
              attachments: [],
              modelSelection,
              createdBy: "agent",
              creationSource: "mcp",
              dispatchMode: { type: mode },
            });
          yield* send("active", "start_immediately");
          yield* send("parked", "queue_after_active");
          yield* send("ordinary", "queue_after_active");
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("recovery-park-stop"),
            threadId,
          });
          const stopped = yield* orchestrator.getThreadProjection(threadId);
          const parked = stopped.runs.find(
            (run) => run.userMessageId === MessageId.make("recovery-park:parked"),
          )!;
          const ordinary = stopped.runs.find(
            (run) => run.userMessageId === MessageId.make("recovery-park:ordinary"),
          )!;
          assert.isTrue(parked.queueHeld === true);
          assert.isTrue(ordinary.queueHeld === true);
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make("recovery-park:notice-event"),
                type: "turn-item.updated",
                threadId,
                runId: parked.id,
                providerInstanceId: parked.providerInstanceId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`turn-item:recovery-parked:${parked.id}`),
                  type: "system_notice",
                  threadId,
                  runId: parked.id,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 100,
                  status: "waiting",
                  title: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  severity: "warning",
                  message: "Recovery needs your decision before this message can be sent again.",
                },
              },
            ],
          });
          const archivePolicy = {
            archiveAfterDays: 30,
            deleteAfterDays: null,
            now: Date.parse("2026-10-22T00:00:00.000Z"),
          };
          assert.equal((yield* archive.runPass(archivePolicy)).archivedThreads, 0);
          yield* send("later", "start_immediately");
          const later = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === MessageId.make("recovery-park:later"),
          )!;
          const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
          const released = yield* sink
            .stream({ threadId, afterSequence, eventType: "run.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === ordinary.id &&
                  stored.event.payload.queueHeld === false,
              ),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            );
          yield* sink.write({
            events: [
              {
                id: EventId.make("recovery-park:later-completed"),
                type: "run.updated",
                threadId,
                runId: later.id,
                nodeId: later.rootNodeId!,
                providerInstanceId: later.providerInstanceId,
                occurredAt: now,
                payload: { ...later, status: "completed", startedAt: now, completedAt: now },
              },
            ],
          });
          yield* Fiber.join(released);
          const result = yield* orchestrator.getThreadProjection(threadId);
          assert.isTrue(result.runs.find((run) => run.id === parked.id)?.queueHeld === true);
          assert.isFalse(result.runs.find((run) => run.id === ordinary.id)?.queueHeld === true);
          yield* orchestrator.dispatch({
            type: "queued-run.edit",
            commandId: CommandId.make("recovery-park-edit"),
            threadId,
            runId: parked.id,
            text: "Edited by the person",
          });
          const edited = yield* orchestrator.getThreadProjection(threadId);
          assert.isTrue(edited.runs.find((run) => run.id === parked.id)?.queueHeld === true);
          assert.equal(
            edited.turnItems.find((item) => item.id === `turn-item:recovery-parked:${parked.id}`)
              ?.status,
            "waiting",
          );
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("recovery-park-stop-ordinary"),
            threadId,
          });
          yield* orchestrator.dispatch({
            type: "queued-run.start",
            commandId: CommandId.make("recovery-park-start"),
            threadId,
            runId: parked.id,
          });
          const sent = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(sent.runs.find((run) => run.id === parked.id)?.status, "starting");
          assert.equal(
            sent.turnItems.find((item) => item.id === `turn-item:recovery-parked:${parked.id}`)
              ?.status,
            "completed",
          );
          assert.equal((yield* archive.runPass(archivePolicy)).archivedThreads, 1);
        }),
      ),
  );
  it.effect.each(["resume", "discard"] as const)(
    "a person can %s a recovery-parked message",
    (action) =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const projectId = ProjectId.make(`recovery-action-project:${action}`);
        const threadId = ThreadId.make(`recovery-action-thread:${action}`);
        yield* projects.create({
          commandId: CommandId.make(`recovery-action-project-create:${action}`),
          projectId,
          title: "Test",
          workspaceRoot: `/tmp/recovery-action-${action}`,
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`recovery-action-create:${action}`),
          threadId,
          projectId,
          title: "Test",
          createdBy: "user",
          creationSource: "web",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        for (const key of ["active", "parked"] as const)
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`recovery-action:${action}:${key}`),
            threadId,
            messageId: MessageId.make(`recovery-action:${action}:${key}`),
            text: key,
            attachments: [],
            modelSelection,
            createdBy: "agent",
            creationSource: "mcp",
            dispatchMode: { type: key === "active" ? "start_immediately" : "queue_after_active" },
          });
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`recovery-action-stop:${action}`),
          threadId,
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        const parked = before.runs.find(
          (run) => run.userMessageId === MessageId.make(`recovery-action:${action}:parked`),
        )!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`recovery-action-notice:${action}`),
              type: "turn-item.updated",
              threadId,
              runId: parked.id,
              providerInstanceId: parked.providerInstanceId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`turn-item:recovery-parked:${parked.id}`),
                type: "system_notice",
                threadId,
                runId: parked.id,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 100,
                status: "waiting",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                severity: "warning",
                message: "Recovery needs your decision before this message can be sent again.",
              },
            },
          ],
        });
        if (action === "resume")
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make("recovery-action-resume"),
            threadId,
          });
        else
          yield* orchestrator.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make("recovery-action-discard"),
            threadId,
            runId: parked.id,
          });
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          after.runs.find((run) => run.id === parked.id)?.status,
          action === "resume" ? "starting" : "cancelled",
        );
        const notice = after.turnItems.find(
          (item) => item.id === `turn-item:recovery-parked:${parked.id}`,
        );
        assert.equal(notice?.status, "completed");
        assert.equal(
          notice?.type === "system_notice" ? notice.message : null,
          action === "resume"
            ? "Recovery message released by your request."
            : "Recovery message discarded.",
        );
      }),
  );
});
