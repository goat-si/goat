import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ScheduledTaskId,
  TurnItemId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
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

describe("scheduled fresh conversation", () => {
  it.live("keeps the user's conversation after a scheduled fresh run in the same thread", () =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("scheduled-fresh-user-chat");
      const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
        makeTestAdapter({
          instanceId: CLAUDE_MODEL_SELECTION.instanceId,
          driver: CLAUDE_DRIVER,
          capabilities: ClaudeProviderCapabilitiesV2,
          modelSelection: CLAUDE_MODEL_SELECTION,
          responseByRunOrdinal: {},
          capturedTurns,
          nativeThreadGeneration: yield* Ref.make(0),
        }),
      ]);
      const threadId = ThreadId.make("thread:scheduled-fresh-user-chat");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const send = (name: string, scheduled: boolean) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:scheduled-fresh-user-chat:${name}`),
            threadId,
            messageId: MessageId.make(`message:scheduled-fresh-user-chat:${name}`),
            text: name,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "queue_after_active" },
            ...(scheduled
              ? {
                  scheduledTaskId: ScheduledTaskId.make("scheduled-fresh-user-chat"),
                  freshContext: true,
                }
              : {}),
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:scheduled-fresh-user-chat:create"),
          threadId,
          projectId: ProjectId.make("project:scheduled-fresh-user-chat"),
          title: "User chat with a fresh-session schedule",
          modelSelection: CLAUDE_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        const eventSink = yield* EventSink.EventSinkV2;
        for (const [name, scheduled] of [
          ["user-first", false],
          ["scheduled", true],
          ["user-second", false],
          ["compaction", false],
          ["scheduled-after-compaction", true],
          ["user-third", false],
        ] as const) {
          if (name === "compaction") {
            // The user's run compacts, so later dispatches no longer read the first scheduled run's message.
            const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
            const compactedAt = yield* DateTime.now;
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("event:scheduled-fresh-user-chat:compaction"),
                  type: "turn-item.updated",
                  threadId,
                  runId: run.id,
                  nodeId: run.rootNodeId!,
                  occurredAt: compactedAt,
                  payload: {
                    id: TurnItemId.make("item:scheduled-fresh-user-chat:compaction"),
                    threadId,
                    runId: run.id,
                    nodeId: run.rootNodeId,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1_000,
                    status: "completed",
                    title: null,
                    startedAt: compactedAt,
                    completedAt: compactedAt,
                    updatedAt: compactedAt,
                    type: "compaction",
                    driver: CLAUDE_DRIVER,
                  },
                },
              ],
            });
            continue;
          }
          yield* send(name, scheduled);
          yield* worker.drain();
          yield* waitForIdle(threadId);
        }
        const turns = yield* Ref.get(capturedTurns);
        const turnFor = (name: string) => turns.find((turn) => turn.text.endsWith(name));
        assert.notEqual(
          turnFor("scheduled")!.nativeThreadId,
          turnFor("user-first")!.nativeThreadId,
        );
        // The scheduled run's fresh session must not replace the user's conversation.
        assert.equal(turnFor("user-second")!.nativeThreadId, turnFor("user-first")!.nativeThreadId);
        assert.equal(turnFor("user-third")!.nativeThreadId, turnFor("user-first")!.nativeThreadId);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name: "scheduled-fresh-user-chat",
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
  );
});
