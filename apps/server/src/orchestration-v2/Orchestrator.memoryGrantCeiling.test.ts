import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ScheduledTaskId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { runMemoryPrepareInput } from "./RunExecutionService.ts";
import { withCreationProvenance } from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process before L2 consumption"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const databaseLayer = SqlitePersistence.layerMemory;
const layer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "memory-ceiling" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer, runEffectWorker: false },
  ),
);

it.effect(
  "persists local delegation ceilings through commands, events and child run preparation",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      for (const ceiling of ["read_write", "read", "none", undefined] as const) {
        const suffix = ceiling ?? "legacy";
        const threadId = ThreadId.make(`parent:${suffix}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${suffix}`),
          threadId,
          projectId: ProjectId.make("project:memory-ceiling"),
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`message:${suffix}`),
          threadId,
          messageId: MessageId.make(`message:${suffix}`),
          text: "Parent work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const parent = yield* store.getThreadProjection(threadId);
        const run = parent.runs[0]!;
        expect(
          runMemoryPrepareInput({ run, message: parent.messages[0]!, projection: parent }),
        ).toEqual({
          memoryGrantCeiling: null,
        });
        const command = {
          type: "delegated_task.request" as const,
          commandId: CommandId.make(`delegate:${suffix}`),
          parentThreadId: threadId,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: "Child work",
          modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
          ...(ceiling === undefined ? {} : { memoryGrantCeiling: ceiling }),
        };
        yield* orchestrator.dispatch(command);
        const updated = yield* store.getThreadProjection(threadId);
        const task = updated.subagents[0]!;
        expect(task.memoryGrantCeiling).toBe(ceiling ?? "none");
        const child = yield* store.getThreadProjection(task.childThreadId!);
        expect(child.runs[0]!.memoryGrantCeiling).toBe(ceiling ?? "none");
        expect(
          runMemoryPrepareInput({
            run: child.runs[0]!,
            message: child.messages[0]!,
            projection: child,
          }),
        ).toEqual({ memoryGrantCeiling: ceiling ?? "none" });
        const scheduledMessage = MessageId.make(`scheduled:${suffix}`);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`scheduled:${suffix}`),
          threadId,
          messageId: scheduledMessage,
          scheduledTaskId: ScheduledTaskId.make(`scheduled-task:${suffix}`),
          memoryGrantCeiling: ceiling ?? "none",
          text: "Bound task",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const bound = yield* store.getThreadProjection(threadId);
        const boundRun = bound.runs.find((run) => run.userMessageId === scheduledMessage)!;
        const boundMessage = bound.messages.find((message) => message.id === scheduledMessage)!;
        expect(
          runMemoryPrepareInput({ run: boundRun, message: boundMessage, projection: bound }),
        ).toEqual({
          memoryGrantCeiling: ceiling ?? "none",
        });
        expect(boundRun.status).toBe("queued");
        // Recovery-prefixed terminal events bypass the background listener;
        // explicitly resume so the assertion observes completed promotion.
        yield* sink.write({
          commandId: CommandId.make(`command:runtime-reconcile:parent:${suffix}`),
          events: [
            {
              id: EventId.make(`terminal:parent:${suffix}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...run, status: "completed", completedAt: now },
            },
          ],
        });
        yield* orchestrator.resumeQueuedRuns;
        const promoted = (yield* store.getThreadProjection(threadId)).runs.find(
          (item) => item.id === boundRun.id,
        )!;
        expect(promoted.status).toBe("starting");
        expect(promoted.memoryGrantCeiling).toBe(ceiling ?? "none");

        if (ceiling === "read_write" || ceiling === "none") {
          const firstChildRun = child.runs[0]!;
          yield* sink.write({
            commandId: CommandId.make(`command:runtime-reconcile:child:${suffix}`),
            events: [
              {
                id: EventId.make(`terminal:child:${suffix}`),
                type: "run.updated",
                threadId: child.thread.id,
                occurredAt: now,
                payload: { ...firstChildRun, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.recoverDelegatedTasks;
          const published = (yield* store.getThreadProjection(threadId)).subagents.find(
            (item) => item.id === task.id,
          )!;
          expect(published.result).not.toBeNull();
          for (const next of ceiling === "read_write"
            ? (["read", "none"] as const)
            : (["read_write"] as const)) {
            const messageId = MessageId.make(`follow-up:${suffix}:${next}`);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`follow-up:${suffix}:${next}`),
              threadId: child.thread.id,
              messageId,
              memoryGrantCeiling: next,
              senderThreadId: threadId,
              text: "Follow-up after published result",
              attachments: [],
              modelSelection,
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "mcp",
            });
            const followupChild = yield* store.getThreadProjection(child.thread.id);
            const followupRun = followupChild.runs.find(
              (item) => item.userMessageId === messageId,
            )!;
            const followupParent = yield* store.getThreadProjection(threadId);
            const followupTask = followupParent.subagents.find(
              (item) => item.id === followupRun.delegatedTaskId,
            )!;
            expect(followupTask.id).not.toBe(task.id);
            expect(followupTask.memoryGrantCeiling).toBe(next);
            expect(followupRun.memoryGrantCeiling).toBe(next);
          }
        }
        expect(
          withCreationProvenance(
            { ...command, memoryGrantCeiling: "read_write" },
            { createdBy: "user", creationSource: "web" },
          ),
        ).toMatchObject({ memoryGrantCeiling: "none" });
      }
    }).pipe(Effect.provide(layer)),
);
