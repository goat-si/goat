import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import { AcpProviderCapabilitiesV2 } from "@goat/provider-acp/server/adapter";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION, GROK_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./testing/providerSwitchAdapter.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const threadId = ThreadId.make("thread:provider-switch");
const projectId = ProjectId.make("project:provider-switch");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const GROK_DRIVER = ProviderDriverKind.make("acp");

describe("rollback kept conversation", () => {
  it.live.each([
    {
      name: "an ACP rollback that starts a fresh agent session",
      instanceId: GROK_MODEL_SELECTION.instanceId,
      driver: GROK_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      modelSelection: GROK_MODEL_SELECTION,
      rollback: "replaces_native_thread",
      failResumeAfterRollback: false,
      history: "plain",
      delivers: ["favourite colour is teal"],
      withholds: ["favourite animal is an otter"],
    },
    {
      name: "a native rollback whose next resume fails",
      instanceId: CLAUDE_MODEL_SELECTION.instanceId,
      driver: CLAUDE_DRIVER,
      capabilities: ClaudeProviderCapabilitiesV2,
      modelSelection: CLAUDE_MODEL_SELECTION,
      rollback: "truncates",
      failResumeAfterRollback: true,
      history: "plain",
      delivers: ["favourite colour is teal"],
      withholds: ["favourite animal is an otter"],
    },
    {
      // Pi forks into a new native thread that still holds the kept turns.
      name: "a native rollback that forks a new native thread",
      instanceId: CLAUDE_MODEL_SELECTION.instanceId,
      driver: CLAUDE_DRIVER,
      capabilities: ClaudeProviderCapabilitiesV2,
      modelSelection: CLAUDE_MODEL_SELECTION,
      rollback: "replaces_native_thread",
      failResumeAfterRollback: false,
      history: "plain",
      delivers: [],
      withholds: ["favourite colour is teal", "favourite animal is an otter"],
    },
    {
      name: "an ACP rollback where no attempt recorded its native session",
      instanceId: GROK_MODEL_SELECTION.instanceId,
      driver: GROK_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      modelSelection: GROK_MODEL_SELECTION,
      rollback: "replaces_native_thread",
      failResumeAfterRollback: false,
      history: "legacy_all_turns",
      delivers: ["favourite colour is teal"],
      withholds: ["favourite animal is an otter"],
    },
    {
      name: "an ACP rollback of a forked thread to its baseline",
      instanceId: GROK_MODEL_SELECTION.instanceId,
      driver: GROK_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      modelSelection: GROK_MODEL_SELECTION,
      rollback: "replaces_native_thread",
      failResumeAfterRollback: false,
      history: "forked_to_baseline",
      delivers: ["home town is Oslo"],
      withholds: ["favourite colour is teal", "favourite animal is an otter"],
    },
    {
      name: "an ACP rollback in a thread restarted with fresh context",
      instanceId: GROK_MODEL_SELECTION.instanceId,
      driver: GROK_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      modelSelection: GROK_MODEL_SELECTION,
      rollback: "replaces_native_thread",
      failResumeAfterRollback: false,
      history: "after_fresh_context",
      delivers: ["favourite colour is teal"],
      withholds: ["home town is Oslo", "favourite animal is an otter"],
    },
  ] as const)(
    "gives the agent the kept conversation and not the rewound turn after $name",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const name = `rollback-kept-context-${scenario.driver}-${scenario.history}`;
          const cwd = yield* checkpointWorkspace(name);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const failResumeOnce = yield* Ref.make(false);
          const nativeThreadGeneration = yield* Ref.make(0);
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: scenario.instanceId,
              driver: scenario.driver,
              capabilities: scenario.capabilities,
              modelSelection: scenario.modelSelection,
              responseByRunOrdinal: { 1: "noted", 2: "noted", 3: "noted" },
              capturedTurns,
              injectedHistory,
              failResumeOnce,
              nativeThreadGeneration,
              rollback: scenario.rollback,
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const runToCompletion = Effect.fn("runToCompletion")(function* (
              ordinal: number,
              text: string,
              thread: ThreadId = threadId,
              freshContext = false,
            ) {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`${thread}:${ordinal}`),
                threadId: thread,
                messageId: MessageId.make(`${thread}:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text,
                attachments: [],
                modelSelection: scenario.modelSelection,
                ...(freshContext ? { freshContext: true } : {}),
                dispatchMode: { type: "start_immediately" },
              });
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.threadId === thread &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
              );
              yield* worker.drain();
            });
            const createThread = (thread: ThreadId) =>
              orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`${thread}:create`),
                threadId: thread,
                projectId,
                createdBy: "user",
                creationSource: "web",
                title: "Edit from here",
                modelSelection: scenario.modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
              });
            if (scenario.history === "forked_to_baseline") {
              const sourceThreadId = ThreadId.make(`${name}:source`);
              yield* createThread(sourceThreadId);
              yield* runToCompletion(
                1,
                "My home town is Oslo. Reply with only the word: noted",
                sourceThreadId,
              );
              yield* orchestrator.dispatch({
                type: "thread.fork",
                commandId: CommandId.make(`${name}:fork`),
                sourceThreadId,
                targetThreadId: threadId,
                sourcePoint: {
                  type: "run",
                  runId: (yield* orchestrator.getThreadProjection(sourceThreadId)).runs[0]!.id,
                },
                createdBy: "user",
                creationSource: "web",
              });
            } else {
              yield* createThread(threadId);
            }
            // Runs before a fresh-context run never reach a provider again.
            const first = scenario.history === "after_fresh_context" ? 2 : 1;
            if (first === 2) {
              yield* runToCompletion(1, "My home town is Oslo. Reply with only the word: noted");
            }
            yield* runToCompletion(
              first,
              "My favourite colour is teal. Reply with only the word: noted",
              threadId,
              first === 2,
            );
            yield* runToCompletion(
              first + 1,
              "My favourite animal is an otter. Reply with only the word: noted",
            );
            const beforeRollback = yield* orchestrator.getThreadProjection(threadId);
            if (scenario.history === "legacy_all_turns") {
              yield* (yield* EventSink.EventSinkV2).write({
                events: beforeRollback.attempts.map(
                  ({ nativeThreadId: _nativeThreadId, ...legacy }, index) => ({
                    id: EventId.make(`${name}:legacy-attempt:${index}`),
                    type: "run-attempt.updated" as const,
                    threadId,
                    occurredAt: beforeRollback.thread.createdAt,
                    payload: legacy,
                  }),
                ),
              });
            }
            const keptOrdinal = scenario.history === "forked_to_baseline" ? 0 : first;
            const keptCheckpoint = beforeRollback.checkpoints.find(
              (checkpoint) =>
                (checkpoint.appRunOrdinal ?? 0) === keptOrdinal && checkpoint.status === "ready",
            );
            if (keptCheckpoint === undefined) {
              return yield* Effect.die("Expected a checkpoint after the first turn.");
            }
            yield* orchestrator.dispatch({
              type: "checkpoint.rollback",
              commandId: CommandId.make(`${name}:rollback`),
              threadId,
              scopeId: keptCheckpoint.scopeId,
              checkpointId: keptCheckpoint.id,
              restoreFiles: false,
            });
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  (event.type === "run.updated" &&
                    event.payload.ordinal === first + 1 &&
                    event.payload.status === "rolled_back") ||
                  (event.type === "thread.metadata-updated" &&
                    event.payload.rollbackFailure != null),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
            assert.deepEqual(
              (yield* orchestrator.getThreadProjection(threadId)).runs.map((run) => run.status),
              scenario.history === "forked_to_baseline"
                ? ["rolled_back", "rolled_back"]
                : [...(first === 2 ? ["completed"] : []), "completed", "rolled_back"],
            );
            if (scenario.failResumeAfterRollback) {
              const providerSessionId = (yield* orchestrator.getThreadProjection(threadId))
                .providerThreads[0]?.providerSessionId;
              if (providerSessionId == null) {
                return yield* Effect.die("Expected a provider session after the rollback.");
              }
              yield* orchestrator.dispatch({
                type: "provider-session.detach",
                commandId: CommandId.make(`${name}:detach`),
                threadId,
                providerSessionId,
              });
              yield* worker.drain();
              yield* Ref.set(failResumeOnce, true);
            }
            const historyBeforeRun3 = (yield* Ref.get(injectedHistory)).length;
            yield* runToCompletion(first + 2, "What did I say first?");

            const run3 = (yield* Ref.get(capturedTurns)).at(-1);
            const delivered =
              (run3?.text ?? "") +
              (yield* encodeJson((yield* Ref.get(injectedHistory)).slice(historyBeforeRun3)));
            for (const kept of scenario.delivers) {
              assert.include(delivered, kept, "the agent's session lacks this kept turn");
            }
            for (const withheld of scenario.withholds) {
              assert.notInclude(delivered, withheld, "the session holds it or it was rewound");
            }
            if (scenario.name === "an ACP rollback that starts a fresh agent session") {
              const recoveries = (projection: OrchestrationV2ThreadProjection) =>
                projection.contextHandoffs.filter(
                  (handoff) => handoff.strategy === "full_thread_summary",
                ).length;
              const recoveriesBeforeRun4 = recoveries(
                yield* orchestrator.getThreadProjection(threadId),
              );
              const sessionsBeforeRun4 = yield* Ref.get(nativeThreadGeneration);
              yield* runToCompletion(4, "And what did I say second?");
              assert.strictEqual(
                recoveries(yield* orchestrator.getThreadProjection(threadId)),
                recoveriesBeforeRun4,
                "the recovered session holds the kept turns, so the next turn replays nothing",
              );
              assert.strictEqual(yield* Ref.get(nativeThreadGeneration), sessionsBeforeRun4);
            }
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name,
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: { type: "readOnly" },
                  },
                },
                layerRegistry,
              ),
            ),
          );
        }),
      ),
  );
});
