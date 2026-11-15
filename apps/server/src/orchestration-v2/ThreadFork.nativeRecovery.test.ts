import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const runForkWithFailingNativeSource = (forkFailures: number) => {
  const driver = ProviderDriverKind.make("claudeAgent");
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const modelSelection = { instanceId, model: "test-model" };
  const started = Deferred.makeUnsafe<ProviderAdapter.ProviderAdapterV2TurnInput>();
  let forkCalls = 0;
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: "/tmp/fork-missing-native-source",
            model: modelSelection.model,
            capabilities: ClaudeProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          ensureThread: ({ threadId, existingProviderThread }) =>
            Effect.succeed({
              ...existingProviderThread!,
              appThreadId: threadId,
              nativeThreadRef: { driver, nativeId: "native-fresh-fork", strength: "strong" },
              status: "idle",
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) => Deferred.succeed(started, turn).pipe(Effect.asVoid),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: ({ sourceProviderThread, targetThreadId }) =>
            ++forkCalls <= forkFailures
              ? Effect.fail(
                  new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver,
                    providerThreadId: sourceProviderThread.id,
                    cause:
                      "Session not found: native-deleted-source; authorization=BearerSyntheticSecret",
                  }),
                )
              : Effect.succeed({
                  ...sourceProviderThread,
                  appThreadId: targetThreadId,
                  nativeThreadRef: { driver, nativeId: "native-forked", strength: "strong" },
                  updatedAt: now,
                }),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const starter = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
    const now = yield* DateTime.now;
    const sourceThreadId = ThreadId.make("fork-missing-source");
    const targetThreadId = ThreadId.make("fork-missing-target");
    const parentThreadId = ThreadId.make("fork-missing-parent");
    // A completed run whose native session no longer exists.
    const seedRun = (threadId: ThreadId, marker: string) =>
      Effect.gen(function* () {
        const providerThreadId = ProviderThreadId.make(`${threadId}-native-thread`);
        const runId = RunId.make(`${threadId}-run`);
        const userMessageId = MessageId.make(`${threadId}-message`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}-provider-thread`),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: providerThreadId,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native-deleted-source", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make(`${threadId}-run`),
              type: "run.created",
              threadId,
              runId: runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId,
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`${threadId}-user-item`),
              type: "turn-item.updated",
              threadId,
              runId: runId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`${threadId}-user-item`),
                threadId,
                runId: runId,
                nodeId: null,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId: userMessageId,
                text: marker,
                attachments: [],
              },
            },
          ],
        });
        return runId;
      });

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fork-missing-create-parent"),
      threadId: parentThreadId,
      projectId: ProjectId.make("fork-missing-project"),
      title: "Fork missing parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const parentRunId = yield* seedRun(parentThreadId, "INHERITED_PARENT_MARKER");
    // The source is itself a fork, so its history starts in its parent.
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-missing-fork-parent"),
      sourceThreadId: parentThreadId,
      targetThreadId: sourceThreadId,
      sourcePoint: { type: "run", runId: parentRunId },
      createdBy: "user",
      creationSource: "web",
    });
    const sourceRunId = yield* seedRun(sourceThreadId, "FORKED_SOURCE_MARKER");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-missing-fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: sourceRunId },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("fork-missing-continue"),
      threadId: targetThreadId,
      messageId: MessageId.make("fork-missing-continue"),
      text: "Continue the fork",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const initial = yield* orchestrator.getThreadProjection(targetThreadId);
    const runId = initial.runs[0]!.id;
    if (forkFailures === 1) {
      yield* starter
        .start({ threadId: targetThreadId, runId, willRetry: true })
        .pipe(Effect.ignore);
    }
    yield* starter.start({ threadId: targetThreadId, runId });

    const projection = yield* orchestrator.getThreadProjection(targetThreadId);
    assert.deepEqual(
      projection.turnItems.flatMap((item) => (item.type === "error" ? [item.title] : [])),
      [],
    );
    assert.equal(projection.runs[0]?.status, "running");
    return { projection, turn: yield* Deferred.await(started), forkCalls };
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        { name: "fork-missing-native-source" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { runEffectWorker: false },
      ),
    ),
  );
};

it.effect("a native fork whose source session is gone starts fresh with the source history", () =>
  Effect.gen(function* () {
    const { projection, turn } = yield* runForkWithFailingNativeSource(Number.POSITIVE_INFINITY);
    // Resolving the fork transfer stops later sends from retrying the native fork.
    assert.equal(projection.contextTransfers[0]?.status, "resolved_portable");
    assert.isNull(projection.providerThreads[0]?.forkedFrom);
    assert.include(JSON.stringify(turn), "FORKED_SOURCE_MARKER");
    const handoff = projection.contextHandoffs[0];
    const history = handoff?.history?.messages.map((message) => message.text).join("\n") ?? "";
    // The source's own fork parent comes first, as it does in the source's timeline.
    assert.isAbove(
      history.indexOf("FORKED_SOURCE_MARKER"),
      history.indexOf("INHERITED_PARENT_MARKER"),
    );
    assert.isAtLeast(history.indexOf("INHERITED_PARENT_MARKER"), 0);
    // Omitted items live in the source thread, so recovery reads point there.
    assert.include(handoff?.history?.coverage ?? "", 'threadId:"fork-missing-source"');
    assert.notInclude(handoff?.history?.coverage ?? "", "fork-missing-target");
    const notices = projection.turnItems.flatMap((item) =>
      item.type === "system_notice" ? [item.message] : [],
    );
    assert.lengthOf(notices, 1);
    assert.include(notices[0], "Session not found: native-deleted-source");
    assert.notInclude(notices[0], "BearerSyntheticSecret");
  }),
);

it.effect("a native fork that fails before its last attempt still forks natively", () =>
  Effect.gen(function* () {
    const { projection, forkCalls } = yield* runForkWithFailingNativeSource(1);
    assert.equal(forkCalls, 2);
    assert.equal(projection.contextTransfers[0]?.status, "consumed");
    assert.equal(projection.contextTransfers[0]?.resolution?.strategy, "native_fork");
  }),
);
