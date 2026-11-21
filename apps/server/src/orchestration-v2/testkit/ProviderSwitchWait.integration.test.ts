import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderTurnId,
  ThreadId,
} from "@goat/contracts";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./testing/providerSwitchAdapter.ts";

it.live.each(["running", "before-session", "stopped", "goal"] as const)(
  "provider-changing steer against %s non-restartable turn",
  (phase) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`provider-switch-wait-${phase}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const sessionGate = yield* Deferred.make<void>();
        if (phase !== "before-session") yield* Deferred.succeed(sessionGate, undefined);
        const threadId = ThreadId.make("thread:provider-switch-wait");
        const projectId = ProjectId.make("project:provider-switch-wait");
        const claudeDriver = ProviderDriverKind.make("claudeAgent");
        const codexDriver = ProviderDriverKind.make("codex");
        const claude = makeTestAdapter({
          instanceId: CLAUDE_MODEL_SELECTION.instanceId,
          driver: claudeDriver,
          capabilities: ClaudeProviderCapabilitiesV2,
          modelSelection: CLAUDE_MODEL_SELECTION,
          responseByRunOrdinal: { 1: "Claude finished" },
          capturedTurns,
          holdFirstTurn: started,
          releaseFirstTurn: release,
        });
        const registry = ProviderAdapterRegistry.layerFromAdapters([
          {
            ...claude,
            openSession: (input: Parameters<typeof claude.openSession>[0]) =>
              Deferred.await(sessionGate).pipe(Effect.andThen(claude.openSession(input))),
          },
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: codexDriver,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 2: "Codex finished" },
            capturedTurns,
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sink = yield* EventSink.EventSinkV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("switch-wait:create"),
            threadId,
            projectId,
            title: "Switch",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("switch-wait:first"),
            threadId,
            messageId: MessageId.make("switch-wait:first"),
            text: "Current Claude turn",
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          if (phase !== "before-session") yield* Deferred.await(started);

          const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          if (phase !== "before-session") {
            const now = yield* DateTime.now;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("switch-wait:turn"),
                  type: "provider-turn.updated",
                  threadId,
                  runId: first.id,
                  nodeId: first.rootNodeId!,
                  driver: claudeDriver,
                  providerInstanceId: first.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    id: ProviderTurnId.make(`provider-turn:${claudeDriver}:${threadId}:1`),
                    providerThreadId: first.providerThreadId!,
                    nodeId: first.rootNodeId!,
                    runAttemptId: first.activeAttemptId!,
                    nativeTurnRef: null,
                    ordinal: 1,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  },
                },
              ],
            });
          }
          const switchCommand = {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("switch-wait:second"),
            threadId,
            messageId: MessageId.make("switch-wait:second"),
            text: phase === "goal" ? "/goal all tests pass" : "Continue with Codex",
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            ...(phase === "goal" ? {} : { deliveryIntent: "steer" as const }),
            dispatchMode:
              phase === "goal"
                ? { type: "steer_active" as const, targetRunId: first.id }
                : { type: "start_immediately" as const },
          } as const;
          if (phase === "stopped") {
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("switch-wait:stop"),
              threadId,
              runId: first.id,
            });
            const result = yield* Effect.result(orchestrator.dispatch(switchCommand));
            assert.equal(result._tag, "Failure");
            assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
            yield* Deferred.succeed(release, undefined);
            return;
          }
          yield* orchestrator.dispatch(switchCommand);
          const current = yield* orchestrator.getThreadProjection(threadId);
          if (phase === "goal") {
            assert.isTrue(
              current.turnItems.some(
                (item) => item.type === "run_interrupt_request" && item.runId === first.id,
              ),
            );
            assert.equal(current.runs[1]?.status, "queued");
            yield* Deferred.succeed(release, undefined);
            return;
          }
          const queued = current.runs;
          assert.equal(queued[0]?.status, phase === "before-session" ? "starting" : "running");
          assert.equal(queued[1]?.status, "queued");
          assert.equal(queued[1]?.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
          yield* Deferred.succeed(sessionGate, undefined);
          yield* Deferred.await(started);
          yield* Deferred.succeed(release, undefined);
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.threadId === threadId &&
                event.payload.ordinal === 2 &&
                event.payload.status === "completed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            after.runs.map((run) => run.status),
            ["completed", "completed"],
          );
          const turn = (yield* Ref.get(capturedTurns)).at(-1)!;
          assert.include(turn.text, "Current Claude turn");
          assert.include(turn.text, "Claude finished");
          assert.include(turn.text, "Continue with Codex");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "provider-switch-wait",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              registry,
            ),
          ),
        );
      }),
    ),
);
