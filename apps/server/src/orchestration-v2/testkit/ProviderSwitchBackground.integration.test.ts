import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./testing/providerSwitchAdapter.ts";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

const waitForIdle = Effect.fn("ProviderSwitchTest.waitForIdle")(function* (
  targetThreadId: ThreadId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const isIdle = (projection: OrchestrationV2ThreadProjection) =>
    projection.runs.every(
      (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
    );
  const afterSequence = yield* eventSink.latestSequence();
  const current = yield* orchestrator.getThreadProjection(targetThreadId);
  if (isIdle(current)) {
    return current;
  }
  // Projections commit with their events, so each later event is the only time to re-read.
  const [idle] = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(targetThreadId)),
    Stream.filter(isIdle),
    Stream.take(1),
    Stream.runCollect,
  );
  if (idle === undefined) {
    return yield* Effect.die(
      new Error("Provider switch test event stream ended before the thread went idle"),
    );
  }
  return idle;
});

// regression: #20343 sending to an instance with separate history must release the old session

it.live.each([
  [
    "detaches the previous instance's session when a send hands off to another instance",
    { background: false, queued: false, sharedHistory: false },
  ],
  [
    "refuses the hand-off while the previous instance still runs background work",
    { background: true, queued: false, sharedHistory: false },
  ],
  [
    "keeps a busy previous session running when a queued hand-off starts",
    { background: true, queued: true, sharedHistory: false },
  ],
  [
    "holds a queued account switch while the replaced session still runs background work",
    { background: true, queued: true, sharedHistory: true },
  ],
] as const)("%s", ([, { background, queued, sharedHistory }]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("handoff-releases-session");
      const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const backgroundWork = yield* Ref.make(background);
      const closedSessions = yield* Ref.make<ReadonlyArray<string>>([]);
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondSelection: ModelSelection = {
        ...CLAUDE_MODEL_SELECTION,
        instanceId: ProviderInstanceId.make("claude-second-account"),
      };
      const adapters = [
        makeTestAdapter({
          instanceId: CLAUDE_MODEL_SELECTION.instanceId,
          driver: CLAUDE_DRIVER,
          capabilities: ClaudeProviderCapabilitiesV2,
          modelSelection: CLAUDE_MODEL_SELECTION,
          responseByRunOrdinal: { 1: "First account complete" },
          capturedTurns,
          backgroundWork,
          closedSessions,
          ...(queued ? { holdFirstTurn: firstStarted, releaseFirstTurn: releaseFirst } : {}),
        }),
        makeTestAdapter({
          instanceId: secondSelection.instanceId,
          driver: CLAUDE_DRIVER,
          capabilities: ClaudeProviderCapabilitiesV2,
          modelSelection: secondSelection,
          responseByRunOrdinal: { 2: "Second account complete" },
          capturedTurns,
        }),
      ];
      // Without a shared continuation key, each Claude instance owns its own native history.
      const layerRegistry = sharedHistory
        ? Layer.succeed(
            ProviderAdapterRegistry.ProviderAdapterRegistryV2,
            ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
              get: (instanceId) => {
                const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
                return adapter === undefined
                  ? Effect.fail(
                      new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({
                        instanceId,
                      }),
                    )
                  : Effect.succeed(adapter);
              },
              list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
              getMetadata: () =>
                Effect.succeed({
                  driver: CLAUDE_DRIVER,
                  continuationKey: "claude:shared-native-account-history",
                  enabled: true,
                  capabilities: ClaudeProviderCapabilitiesV2,
                }),
            }),
          )
        : ProviderAdapterRegistry.layerFromAdapters(adapters);
      const handoffThreadId = ThreadId.make("thread:handoff-releases-session");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const send = (ordinal: number, modelSelection: ModelSelection, attempt = "") =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:handoff-releases-session:${ordinal}${attempt}`),
            threadId: handoffThreadId,
            messageId: MessageId.make(`message:handoff-releases-session:${ordinal}${attempt}`),
            text: `Prompt ${ordinal}`,
            attachments: [],
            modelSelection,
            dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:handoff-releases-session:create"),
          threadId: handoffThreadId,
          projectId: ProjectId.make("project:handoff-releases-session"),
          title: "Handoff releases session",
          modelSelection: CLAUDE_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        yield* send(1, CLAUDE_MODEL_SELECTION);

        if (queued) {
          yield* Deferred.await(firstStarted);
          yield* send(2, secondSelection);
          const queuedRunId = (yield* orchestrator.getThreadProjection(handoffThreadId)).runs[1]
            ?.id;
          assert.isDefined(queuedRunId);
          yield* Deferred.succeed(releaseFirst, undefined);
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.runId === queuedRunId &&
                (event.payload.queueHeld === true || event.payload.status === "completed"),
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const afterQueue = yield* orchestrator.getThreadProjection(handoffThreadId);
          const firstSession = afterQueue.providerSessions.find(
            (session) => session.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
          );
          // Detaching would end the background agents, so the busy session must stay up.
          assert.deepEqual(yield* Ref.get(closedSessions), []);
          assert.equal(firstSession?.status, "ready");
          if (!sharedHistory) {
            assert.deepEqual(
              afterQueue.runs.map((run) => [run.providerInstanceId, run.status]),
              [
                [CLAUDE_MODEL_SELECTION.instanceId, "completed"],
                [secondSelection.instanceId, "completed"],
              ],
            );
            return;
          }
          // Resuming the native thread beside the busy session would fork its history.
          assert.deepEqual(
            afterQueue.runs.map((run) => [run.status, run.queueHeld === true]),
            [
              ["completed", false],
              ["queued", true],
            ],
          );
          assert.lengthOf(yield* Ref.get(capturedTurns), 1);
          yield* Ref.set(backgroundWork, false);
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make("command:handoff-releases-session:resume"),
            threadId: handoffThreadId,
          });
          yield* worker.drain();
          const resumed = yield* waitForIdle(handoffThreadId);
          assert.deepEqual(
            resumed.runs.map((run) => [run.providerInstanceId, run.status]),
            [
              [CLAUDE_MODEL_SELECTION.instanceId, "completed"],
              [secondSelection.instanceId, "completed"],
            ],
          );
          assert.deepEqual(yield* Ref.get(closedSessions), [firstSession!.id]);
          return;
        }

        yield* worker.drain();
        const afterFirst = yield* waitForIdle(handoffThreadId);
        const firstSession = afterFirst.providerSessions.find(
          (session) => session.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
        );
        assert.equal(firstSession?.status, "ready");

        if (background) {
          // Native subagents live only in the adapter's roster, so the projection's
          // pendingBackgroundTasks stays empty while the probe still reports work.
          assert.deepEqual(afterFirst.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
          const refused = yield* send(2, secondSelection, ":refused").pipe(Effect.flip);
          assert.include(String(refused.cause), "still running background agents or commands");
          const unchanged = yield* orchestrator.getThreadProjection(handoffThreadId);
          assert.lengthOf(unchanged.runs, 1);
          assert.deepEqual(yield* Ref.get(closedSessions), []);
          assert.equal(unchanged.thread.providerInstanceId, CLAUDE_MODEL_SELECTION.instanceId);
          assert.deepEqual(
            unchanged.providerSessions.map((session) => [session.id, session.status]),
            [[firstSession!.id, "ready"]],
          );
          yield* Ref.set(backgroundWork, false);
        }

        yield* send(2, secondSelection);
        yield* worker.drain();
        const afterSecond = yield* waitForIdle(handoffThreadId);
        yield* worker.drain();
        const projection = yield* orchestrator.getThreadProjection(handoffThreadId);

        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [CLAUDE_MODEL_SELECTION.instanceId, "completed"],
            [secondSelection.instanceId, "completed"],
          ],
        );
        assert.lengthOf(afterSecond.contextHandoffs, 1);
        assert.deepEqual(
          projection.providerSessions.map((session) => session.providerInstanceId),
          [secondSelection.instanceId],
        );
        // The detached event alone hides the session; the runtime must also close.
        assert.deepEqual(yield* Ref.get(closedSessions), [firstSession!.id]);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name: "handoff-releases-session",
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: {
                  type: "readOnly",
                  access: { type: "fullAccess" },
                  networkAccess: false,
                },
              },
            },
            layerRegistry,
          ),
        ),
      );
    }),
  ),
);

// regression: #21314 a queued PR update must follow the provider that took over the thread
