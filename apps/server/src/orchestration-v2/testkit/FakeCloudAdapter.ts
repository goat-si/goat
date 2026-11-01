import {
  type OrchestrationV2CloudTask,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  MessageId,
  RunId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { ProviderAdapterTurnStartError } from "@goat/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";

export const fakeCloudInstanceId = ProviderInstanceId.make("fakeCloud");
export const fakeCloudDriver = ProviderDriverKind.make("fakeCloud");
export function fakeCloudCapabilities(followUp = true): OrchestrationV2ProviderCapabilities {
  return {
    ...CodexProviderCapabilitiesV2,
    sessions: {
      ...CodexProviderCapabilitiesV2.sessions,
      executionLocation: "cloud",
      followUp: { supported: followUp, reason: "Fake Cloud has no follow-up" },
    },
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: false,
      supportsSteeringByInterruptRestart: false,
      supportsQueuedMessages: followUp,
    },
    checkpointing: {
      ...CodexProviderCapabilitiesV2.checkpointing,
      appCanCheckpointFilesystem: false,
      providerCanRollbackConversation: false,
    },
  };
}

export const makeFakeCloudAdapter = Effect.fnUntraced(function* (
  followUp = true,
  instanceId = fakeCloudInstanceId,
) {
  const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
  const submissions = yield* Ref.make(0);
  const creations = yield* Ref.make(0);
  const attachments = yield* Ref.make(0);
  const cancellations = yield* Ref.make(0);
  const detaches = yield* Ref.make(0);
  const current = yield* Ref.make<ProviderAdapter.ProviderAdapterV2TurnInput | null>(null);
  const capabilities = fakeCloudCapabilities(followUp);
  const publish = (event: ProviderAdapter.ProviderAdapterV2Event) =>
    Queue.offer(queue, event).pipe(Effect.asVoid);
  const accept = Effect.fnUntraced(function* (input: ProviderAdapter.ProviderAdapterV2TurnInput) {
    if (input.providerThread.nativeThreadRef === null)
      yield* Ref.update(creations, (count) => count + 1);
    const now = yield* DateTime.now;
    const task: OrchestrationV2CloudTask = {
      taskId: "remote-task-1",
      acceptedAppRunId: input.runId,
      url: "https://example.com/tasks/1",
      status: "running",
      tracking: "live",
      source: input.cloudSource!,
      localChangesExcluded: input.providerThread.cloudTask?.localChangesExcluded ?? false,
      ...(input.providerThread.cloudTask?.localChangesIncluded === undefined
        ? {}
        : { localChangesIncluded: input.providerThread.cloudTask.localChangesIncluded }),
      updatedAt: DateTime.formatIso(now),
    };
    yield* input.commitCloudTask!(task, {
      nativeThreadRef: {
        driver: fakeCloudDriver,
        nativeId: "native-session-1",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
    });
    yield* Ref.set(current, input);
    yield* publish({
      type: "provider_turn.updated",
      driver: fakeCloudDriver,
      threadId: input.threadId,
      providerTurn: {
        id: ProviderTurnId.make(`provider-turn:fake-cloud:${input.attemptId}`),
        providerThreadId: input.providerThread.id,
        nodeId: input.rootNodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: { driver: fakeCloudDriver, nativeId: "remote-task-1", strength: "strong" },
        ordinal: input.providerTurnOrdinal,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
  });
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver: fakeCloudDriver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (open) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const unsupported = () =>
          Effect.fail(
            new ProviderAdapterTurnStartError({
              driver: fakeCloudDriver,
              threadId: open.threadId,
              providerThreadId: ProviderThreadId.make("pt:fake-cloud"),
              runId: RunId.make("run:fake-unsupported"),
              cause: "Unsupported fake operation",
            }),
          );
        yield* Effect.addFinalizer(() =>
          Ref.update(detaches, (count) => count + 1).pipe(Effect.andThen(Queue.end(queue))),
        );
        const ensure = (input: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) => {
          if (input.existingProviderThread) return Effect.succeed(input.existingProviderThread);
          const thread: OrchestrationV2ProviderThread = {
            id: ProviderThreadId.make("pt:fake-cloud"),
            driver: fakeCloudDriver,
            providerInstanceId: instanceId,
            providerSessionId: open.providerSessionId,
            appThreadId: input.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          };
          return Effect.succeed(thread);
        };
        return {
          instanceId,
          driver: fakeCloudDriver,
          providerSessionId: open.providerSessionId,
          providerSession: {
            id: open.providerSessionId,
            driver: fakeCloudDriver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: open.runtimePolicy.cwd ?? "/repo",
            model: open.modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(queue),
          ensureThread: ensure,
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Ref.update(submissions, (count) => count + 1).pipe(Effect.andThen(accept(input))),
          resumeTurn: (input) =>
            Ref.update(attachments, (count) => count + 1).pipe(
              Effect.andThen(
                Ref.set(current, {
                  ...input,
                  message: {
                    messageId: MessageId.make("message:unused-attach"),
                    text: "",
                    attachments: [],
                    createdBy: "user",
                    creationSource: "web",
                  },
                }),
              ),
            ),
          interruptTurn: () => Ref.update(cancellations, (count) => count + 1),
          steerTurn: unsupported,
          respondToRuntimeRequest: unsupported,
          readThreadSnapshot: unsupported,
          rollbackThread: unsupported,
          forkThread: unsupported,
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
  const finish = Effect.fnUntraced(function* (
    linkOnly = false,
    status: "succeeded" | "cancelled" = "succeeded",
    beforeTerminal: Effect.Effect<void> = Effect.void,
  ) {
    const input = yield* Ref.get(current);
    if (!input) return;
    const now = yield* DateTime.now;
    yield* input.commitCloudTask!({
      taskId: "remote-task-1",
      acceptedAppRunId: input.runId,
      url: "https://example.com/tasks/1",
      status: linkOnly ? "running" : status,
      tracking: linkOnly ? "link-only" : "live",
      summary: linkOnly ? "Running in the cloud" : "Completed fake task",
      ...(linkOnly ? {} : { prUrl: "https://github.com/acme/repo/pull/1", branch: "agent/fix" }),
      source: input.cloudSource!,
      localChangesExcluded: input.providerThread.cloudTask?.localChangesExcluded ?? false,
      ...(input.providerThread.cloudTask?.localChangesIncluded === undefined
        ? {}
        : { localChangesIncluded: input.providerThread.cloudTask.localChangesIncluded }),
      updatedAt: DateTime.formatIso(now),
    });
    yield* beforeTerminal;
    yield* publish({
      type: "turn.terminal",
      driver: fakeCloudDriver,
      providerThreadId: input.providerThread.id,
      providerTurnId: ProviderTurnId.make(`provider-turn:fake-cloud:${input.attemptId}`),
      runOrdinal: input.runOrdinal,
      status: status === "cancelled" ? "cancelled" : "completed",
      failure: null,
      threadDisposition: "reusable",
    });
  });
  return {
    adapter,
    finish,
    current,
    publish,
    creations,
    submissions,
    attachments,
    cancellations,
    detaches,
  };
});
