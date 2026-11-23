import * as MemoryDerivedCache from "../memory/MemoryDerivedCache.ts";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";

const sessionId = "idle-exit-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
const taskId = "b8sleep180";

function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}

const result = (uuid: string) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    terminal_reason: "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });

// SIGKILL ends the stream without a frame. SIGTERM makes the CLI stop its tasks first; the
// empty roster level can come before or after the stop notification.
const exitWhileIdle = (options: {
  readonly awaited: boolean;
  readonly signal: "SIGKILL" | "SIGTERM" | "SIGTERM-roster-first";
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { awaited, signal } = options;
      const cwd = yield* checkpointWorkspace("claude-idle-exit-awaited-task");
      const processes: Array<Queue.Queue<SDKMessage, Cause.Done>> = [];
      const offers: SDKUserMessage[] = [];
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const random = yield* SecureRandom.SecureRandom;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const services =
        yield* Effect.context<
          Effect.Services<ReturnType<typeof ClaudeAdapterV2.makeClaudeAdapterV2>>
        >();
      const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
        Effect.gen(function* () {
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: modelSelection.instanceId,
            settings,
            environment: {},
            attachmentsDir: cwd,
            fileSystem,
            path,
            random,
            idAllocator,
            continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
            queryRunner: {
              allocateSessionId: Effect.succeed(sessionId),
              open: () =>
                Effect.gen(function* () {
                  const sdkMessages = yield* Queue.unbounded<SDKMessage, Cause.Done>();
                  processes.push(sdkMessages);
                  return {
                    messages: Stream.fromQueue(sdkMessages),
                    offer: (message: SDKUserMessage) =>
                      Effect.sync(() => void offers.push(message)),
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    mcpServerStatus: Effect.succeed([]),
                    readMcpResource: () => Effect.die("unexpected MCP resource read"),
                    callMcpTool: () => Effect.die("unexpected MCP tool call"),
                    listPermissionRules: Effect.die("unexpected permission rules read"),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(sdkMessages),
                  };
                }),
              forkSession: () => Effect.die("unused"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          }).pipe(Effect.provideContext(services));
          return [adapter];
        }),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const threadId = ThreadId.make("thread:idle-exit-awaited-task");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:idle-exit-awaited-task"),
          title: "Idle exit",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("first"),
          text: "Sleep 180 seconds in the background and wait for it.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const firstProcess = processes[0]!;
        const rostered = yield* watch(
          (event) =>
            event.type === "provider-thread.updated" &&
            event.payload.pendingBackgroundTasks?.some((task) => task.taskId === taskId) === true,
        );
        yield* Queue.offer(
          firstProcess,
          frame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: taskId, task_type: "local_bash", description: "sleep 180" }],
            uuid: "roster",
            session_id: sessionId,
          }),
        );
        yield* Fiber.join(rostered);
        if (awaited) {
          const records = yield* orchestrator.getThreadRecords(threadId, ["providerThreads"]);
          const providerThread = records.providerThreads[0]!;
          const runtime = yield* sessions.get(providerThread.providerSessionId!);
          if (Option.isNone(runtime) || runtime.value.awaitBackgroundTasks === undefined) {
            return yield* Effect.die("Claude runtime must accept background waits");
          }
          const awaitedRoster = yield* watch(
            (event) =>
              event.type === "provider-thread.updated" &&
              event.payload.pendingBackgroundTasks?.some((task) => task.awaited === true) === true,
          );
          yield* runtime.value.awaitBackgroundTasks({
            providerThread,
            taskIds: [taskId],
            awaited: true,
          });
          yield* Fiber.join(awaitedRoster);
        }
        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            (event.payload.status === "waiting" || event.payload.status === "completed"),
        );
        yield* Queue.offer(firstProcess, result("waiting-on-sleep"));
        yield* Fiber.join(settled);
        yield* worker.drain();
        const beforeExit = yield* orchestrator.getThreadProjection(threadId);
        const firstRun = beforeExit.runs[0]!;
        assert.deepEqual(
          beforeExit.providerThreads[0]?.pendingBackgroundTasks?.map((task) => [
            task.taskId,
            task.awaited,
          ]),
          [[taskId, awaited ? true : undefined]],
        );

        const recorded = yield* watch((event) => event.type === "run.background-work-cancelled");
        const woken = yield* watch(
          (event) => event.type === "run.updated" && event.payload.id !== firstRun.id,
        );
        if (signal !== "SIGKILL") {
          const notification = frame({
            type: "system",
            subtype: "task_notification",
            task_id: taskId,
            status: "stopped",
            output_file: "",
            summary: "sleep 180",
            uuid: "stopped",
            session_id: sessionId,
          });
          const emptyRoster = frame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
            uuid: "roster-empty",
            session_id: sessionId,
          });
          const killed = frame({
            type: "system",
            subtype: "task_updated",
            task_id: taskId,
            patch: { status: "killed", end_time: 1 },
            uuid: "killed",
            session_id: sessionId,
          });
          yield* Queue.offerAll(
            firstProcess,
            signal === "SIGTERM"
              ? [notification, killed, emptyRoster]
              : [emptyRoster, notification, killed],
          );
        }
        // The CLI exits while the thread is idle, after its last frames; the GOAT server keeps running.
        yield* Queue.end(firstProcess);
        yield* Fiber.join(recorded);
        yield* worker.drain();

        const afterExit = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterExit.runs
            .find((run) => run.id === firstRun.id)
            ?.restartCancelledBackgroundWork?.map((work) => work.id),
          [taskId],
          "the run must record the awaited task the exited process took with it",
        );
        // Drained effects already dispatched any wake, so a missing one fails here instead of hanging.
        assert.equal(
          afterExit.runs.some((run) => run.id !== firstRun.id),
          awaited,
          "only awaited work wakes the agent without a user message",
        );
        if (!awaited) return;
        yield* Fiber.join(woken);
        yield* worker.drain();
        const afterWake = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(
          afterWake.runs.filter((run) => run.id !== firstRun.id),
          1,
          "the agent must be woken exactly once",
        );
        assert.lengthOf(offers.slice(1), 1);
        assert.include(
          JSON.stringify(offers[1]?.message),
          taskId,
          "the wake must carry a note naming the lost task",
        );
        assert.equal(
          afterWake.messages.filter((message) => message.createdBy === "user").length,
          1,
        );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "claude-idle-exit-awaited-task" },
            registry,
            { runEffectWorker: false, runContinuationWorker: true },
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          MemoryDerivedCache.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

it.effect("wakes the agent when Claude's process exits while it awaits background work", () =>
  exitWhileIdle({ awaited: true, signal: "SIGKILL" }),
);

it.effect("wakes the agent when Claude stops awaited background work before exiting", () =>
  exitWhileIdle({ awaited: true, signal: "SIGTERM" }),
);

it.effect("wakes the agent when Claude empties its roster before stopping awaited work", () =>
  exitWhileIdle({ awaited: true, signal: "SIGTERM-roster-first" }),
);

it.effect("records but does not wake for an unawaited shell lost when Claude's process exits", () =>
  exitWhileIdle({ awaited: false, signal: "SIGKILL" }),
);
