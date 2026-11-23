import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ThreadId,
  ProviderDriverKind,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  CURSOR_MODEL_SELECTION,
} from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./testing/providerSwitchAdapter.ts";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const threadId = ThreadId.make("thread:provider-switch");
const projectId = ProjectId.make("project:provider-switch");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

describe("provider handoff retry", () => {
  it.live.each([
    "turn-start",
    "injection",
    "large-missed-request",
    "exhausted-target-retry",
    "cursor-dropped",
  ] as const)(
    "recovers %s failure without duplicating history in the same native thread",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace(`handoff-retry-${failure}`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const failOnce = yield* Ref.make(true);
          const generation = yield* Ref.make(0);
          const targetSelection =
            failure === "cursor-dropped" ? CURSOR_MODEL_SELECTION : CLAUDE_MODEL_SELECTION;
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: CodexProviderCapabilitiesV2,
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: { 1: "Original partial work" },
              capturedTurns,
            }),
            makeTestAdapter({
              instanceId: targetSelection.instanceId,
              driver:
                failure === "cursor-dropped" ? ProviderDriverKind.make("cursor") : CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: targetSelection,
              responseByRunOrdinal: {},
              capturedTurns,
              ...(failure === "cursor-dropped"
                ? { failedRunOrdinals: new Set([2]), unacceptedRunOrdinals: new Set([2]) }
                : { injectedHistory }),
              nativeThreadGeneration: generation,
              getModelContextWindow: () => 32_000,
              ...(failure === "cursor-dropped"
                ? {}
                : failure !== "injection"
                  ? { failStartOnce: failOnce }
                  : { failInjectionOnce: failOnce }),
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const dispatch = (ordinal: number, text: string, selection: ModelSelection) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`retry:${ordinal}`),
                threadId,
                messageId: MessageId.make(`retry:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "start_immediately" },
              });
            const wait = (ordinal: number, status: "failed" | "completed") =>
              orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
                Effect.andThen(worker.drain()),
                Effect.andThen(
                  Effect.gen(function* () {
                    assert.equal(
                      (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                      status,
                    );
                  }),
                ),
              );
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("retry:create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Handoff retry",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* dispatch(1, "Original request with constraints", CODEX_MODEL_SELECTION);
            yield* wait(1, "completed");
            yield* dispatch(
              2,
              failure === "large-missed-request" ? "x".repeat(7_000) : "First target request",
              targetSelection,
            );
            yield* wait(2, "failed");
            const failed = yield* orchestrator.getThreadProjection(threadId);
            const failedHandoff = failed.contextHandoffs.at(-1)!;
            assert.equal(
              failedHandoff.delivery?.status,
              failure === "cursor-dropped" || failure === "injection" ? "pending" : "injected",
            );
            if (failure === "cursor-dropped") {
              yield* dispatch(3, "Retry target request", targetSelection);
              yield* wait(3, "completed");
              const last = (yield* Ref.get(capturedTurns)).at(-1)!;
              assert.include(last.text, "Original request with constraints");
              assert.include(last.text, "Retry target request");
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).contextHandoffs.at(-1)?.delivery
                  ?.status,
                "inline",
              );
              return;
            }
            const historyBeforeRetry = (yield* Ref.get(injectedHistory)).length;
            if (failure === "exhausted-target-retry") {
              const target = failed.providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* (yield* EventSink.EventSinkV2).write({
                events: [
                  {
                    id: EventId.make("exhausted-retry-usage"),
                    type: "provider-thread.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: { ...target, contextUsage: { usedTokens: 30_000, maxTokens: 32_000 } },
                  },
                ],
              });
            }
            const retryText =
              failure === "large-missed-request" ? "y".repeat(10_000) : "Retry target request";
            yield* dispatch(3, retryText, CLAUDE_MODEL_SELECTION);
            yield* wait(3, "completed");
            const retried = yield* orchestrator.getThreadProjection(threadId);
            const lastTurn = (yield* Ref.get(capturedTurns)).at(-1)!;
            assert.equal(lastTurn.text, retryText);
            if (failure !== "injection" && failure !== "exhausted-target-retry") {
              const delta = yield* encodeJson(
                (yield* Ref.get(injectedHistory)).slice(historyBeforeRetry),
              );
              if (failure === "large-missed-request") {
                assert.include(delta, "omitted 1 items");
                const missedRequest = retried.turnItems.find(
                  (item) => item.type === "user_message" && item.text === "x".repeat(7_000),
                )!;
                const delivery = retried.contextHandoffs.at(-1)!.delivery!;
                assert.include(delivery.omittedItemIds ?? [], missedRequest.id);
                assert.notInclude(delivery.itemIds, missedRequest.id);
              } else assert.include(delta, "First target request");
              assert.notInclude(delta, "Original request with constraints");
              assert.notInclude(delta, "Original partial work");
              assert.equal(yield* Ref.get(generation), 1);
            } else {
              assert.equal(yield* Ref.get(generation), 2);
              assert.notEqual(
                retried.contextHandoffs.at(-1)?.delivery?.nativeThreadId,
                failedHandoff.delivery?.nativeThreadId,
              );
              const newHistory = yield* encodeJson(
                (yield* Ref.get(injectedHistory)).slice(historyBeforeRetry),
              );
              assert.include(newHistory, "Original request with constraints");
              assert.include(newHistory, "Original partial work");
              assert.notInclude(newHistory, "Retry target request");
            }
            const beforeFollowup = yield* Ref.get(injectedHistory);
            const followup = "z".repeat(6_000);
            yield* dispatch(4, followup, CLAUDE_MODEL_SELECTION);
            yield* wait(4, "completed");
            assert.equal((yield* Ref.get(capturedTurns)).at(-1)!.text, followup);
            assert.deepEqual(yield* Ref.get(injectedHistory), beforeFollowup);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).contextHandoffs.length,
              retried.contextHandoffs.length,
            );
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: `handoff-retry-${failure}`,
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
