import { waitForIdle } from "./providerSwitchWaitForIdle.ts";
import { importedFailureScenario } from "./providerSwitchImportedFailure.ts";
import { refusalCases } from "./providerRefusalCases.testkit.ts";
import { vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type ChatAttachment,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  ProviderDriverKind,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CommandPolicyCapabilityUnsupportedError } from "../CommandPolicy.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import {
  CodexProviderCapabilitiesV2,
  canReuseCodexContextUsage,
} from "../Adapters/CodexAdapterV2.ts";
import { AcpProviderCapabilitiesV2 } from "@goat/provider-acp/server/adapter";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { ContextHandoffBudgetError, makeProviderFailure } from "@goat/provider-core/server/failure";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  GROK_MODEL_SELECTION,
} from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./testing/providerSwitchAdapter.ts";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const threadId = ThreadId.make("thread:provider-switch");
const projectId = ProjectId.make("project:provider-switch");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const GROK_DRIVER = ProviderDriverKind.make("acp");

describe("orchestration v2 provider switching", () => {
  it.live.each([
    "compact-native",
    "compact-legacy",
    "large-current-input",
    "screenshot-fallback",
    "screenshot-reported-capacity-native",
    "screenshot-option-change-retry-native",
    "screenshot-exhausted-target-native",
    "screenshot-exhausted-target-reused-native",
    "screenshot-exhausted-target-fallback",
    "screenshot-exhausted-target-estimate-native",
    "screenshot-exhausted-target-oversized-native",
    "screenshot-exhausted-target-tight-native",
    "screenshot-exhausted-target-background-native",
    "screenshot-exhausted-target-subagent-native",
    "prior-images-reasoning-change-replacement-small-native",
    "imported-prior-images-fallback",
    "prior-images-telemetry-native",
    "prior-images-unsent-native",
    "prior-images-unsent-tight-native",
    "prior-images-legacy-replacement-native",
    "delivery-write-failure",
  ] as const)("preserves handoffs through %s", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`handoff-${scenario}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const reasoningScenario = scenario.includes("reasoning-change");
        const turnUsageScenario = reasoningScenario || scenario.includes("turn-usage");
        const modelScenario =
          scenario.includes("model") || scenario.includes("option-change") || reasoningScenario;
        const failStartOnce = yield* Ref.make(false);
        const failResumeOnce = yield* Ref.make(false);
        const generation = yield* Ref.make(0);
        const pendingBackgroundWork = yield* Ref.make(false);
        const priorImages = scenario.includes("prior-images");
        const exhaustedTarget = scenario.includes("exhausted-target");
        const reusedNative = scenario.includes("target-reused");
        const replaceNative = scenario.includes("replacement");
        const capacityScenario = modelScenario || scenario.includes("reported-capacity");
        const returning =
          scenario === "large-current-input" ||
          scenario.includes("-change-") ||
          priorImages ||
          exhaustedTarget;
        const targetSelection: ModelSelection = !modelScenario
          ? CLAUDE_MODEL_SELECTION
          : {
              ...CLAUDE_MODEL_SELECTION,
              ...(reasoningScenario
                ? { options: [{ id: "reasoningEffort", value: "low" }] }
                : scenario.includes("option-change")
                  ? { options: [{ id: "contextWindow", value: "1m" }] }
                  : { model: `${CLAUDE_MODEL_SELECTION.model}-large` }),
            };
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
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: scenario.includes("target-estimate")
              ? { 2: "x".repeat(64_000) }
              : {},
            capturedTurns,
            ...(scenario.includes("retry") || scenario.includes("unsent") ? { failStartOnce } : {}),
            ...(replaceNative ? { failResumeOnce, nativeThreadGeneration: generation } : {}),
            ...(exhaustedTarget && !reusedNative ? { nativeThreadGeneration: generation } : {}),
            ...(scenario.includes("target-background") || scenario.includes("target-subagent")
              ? {
                  pendingBackgroundWork,
                  subagentOnlyBackgroundWork: scenario.includes("target-subagent"),
                }
              : {}),
            ...(scenario.includes("reported-capacity")
              ? { initialContextUsage: { usedTokens: 999_999, maxTokens: 1_000_000 } }
              : {}),
            ...(turnUsageScenario
              ? {
                  canReuseContextUsage: canReuseCodexContextUsage,
                  tokenUsageByRunOrdinal: {
                    2: {
                      usedTokens: replaceNative ? 30_000 : 37_321,
                      maxTokens: replaceNative
                        ? scenario.includes("small")
                          ? 32_000
                          : 64_000
                        : 258_400,
                    },
                  },
                }
              : modelScenario
                ? {
                    getModelContextWindow: (selection: ModelSelection) =>
                      selection.model.endsWith("-large") ||
                      selection.options?.some(
                        (option) => option.id === "contextWindow" && option.value === "1m",
                      )
                        ? 1_000_000
                        : 32_000,
                  }
                : scenario === "large-current-input" || priorImages || exhaustedTarget
                  ? {
                      getModelContextWindow: () =>
                        scenario.includes("target-tight")
                          ? 25_121
                          : scenario === "prior-images-unsent-native"
                            ? 48_000
                            : 32_000,
                    }
                  : {}),
            ...(scenario.endsWith("-native") || scenario === "large-current-input"
              ? { injectedHistory }
              : {}),
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const screenshot: ChatAttachment = {
            type: "image",
            id: "screenshot",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 100_000,
          };
          const screenshots = Array.from(
            {
              length:
                scenario.includes("eight") || capacityScenario
                  ? 8
                  : scenario.includes("pair")
                    ? 2
                    : 1,
            },
            (_, index) => ({ ...screenshot, id: `screenshot-${index}` }),
          );
          const targetOrdinal = returning ? 4 : 2;
          const dispatch = (ordinal: number, text: string, selection: ModelSelection) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`regression:${ordinal}`),
              threadId,
              messageId: MessageId.make(`regression:${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text,
              attachments:
                turnUsageScenario && ordinal === 2
                  ? Array.from({ length: 8 }, (_, index) => ({
                      ...screenshot,
                      id: `prior-${index}`,
                    }))
                  : turnUsageScenario && ordinal >= targetOrdinal
                    ? [screenshot, { ...screenshot, id: "current-2" }]
                    : scenario.startsWith("screenshot") &&
                        ordinal >= targetOrdinal &&
                        (!exhaustedTarget || ordinal === targetOrdinal)
                      ? screenshots
                      : priorImages && ordinal === (scenario.startsWith("imported") ? 1 : 2)
                        ? [screenshot]
                        : [],
              modelSelection: selection,
              dispatchMode: { type: "start_immediately" },
            });
          const wait = (ordinal: number) =>
            orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.payload.ordinal === ordinal &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
              Effect.andThen(worker.drain()),
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("regression:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Handoff regression",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* dispatch(1, "Original request with constraints", CODEX_MODEL_SELECTION);
          yield* wait(1);
          const write = eventSink.write;
          const spy =
            scenario === "delivery-write-failure"
              ? vi.spyOn(eventSink, "write").mockImplementation((input) =>
                  input.events.some(
                    (event) =>
                      event.type === "context-handoff.updated" &&
                      event.payload.delivery?.status === "inline",
                  )
                    ? Effect.fail(
                        new EventSink.EventSinkWriteError({
                          eventCount: input.events.length,
                          cause: "bookkeeping unavailable",
                        }),
                      )
                    : write(input),
                )
              : undefined;
          yield* Effect.addFinalizer(() => Effect.sync(() => spy?.mockRestore()));
          const current = scenario.startsWith("compact")
            ? "/compact"
            : scenario.includes("target-oversized")
              ? "x".repeat(40_000)
              : capacityScenario && !turnUsageScenario
                ? "x".repeat(70_000)
                : scenario === "large-current-input"
                  ? "x".repeat(9_000)
                  : "Continue work";
          if (returning) {
            if (scenario.includes("unsent")) yield* Ref.set(failStartOnce, true);
            yield* dispatch(
              2,
              turnUsageScenario
                ? "x".repeat(27_460)
                : scenario.includes("target-estimate")
                  ? "x".repeat(12_000)
                  : "Establish target",
              CLAUDE_MODEL_SELECTION,
            );
            yield* wait(2);
            if (exhaustedTarget) {
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                "completed",
              );
            }
            if (exhaustedTarget && !scenario.includes("target-estimate")) {
              const target = (yield* orchestrator.getThreadProjection(
                threadId,
              )).providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make("exhausted-target-usage"),
                    type: "provider-thread.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: { ...target, contextUsage: { usedTokens: 30_000, maxTokens: 32_000 } },
                  },
                ],
              });
            }
            if (modelScenario && !turnUsageScenario) {
              const target = (yield* orchestrator.getThreadProjection(
                threadId,
              )).providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make("old-model-usage"),
                    type: "provider-thread.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: {
                      ...target,
                      contextUsage: {
                        usedTokens: 30_000,
                        maxTokens: 32_000,
                        autoCompactThreshold: 31_000,
                      },
                    },
                  },
                ],
              });
            }
            if (scenario.includes("legacy-replacement")) {
              const existing = yield* orchestrator.getThreadProjection(threadId);
              yield* eventSink.write({
                events: existing.attempts.map(
                  ({ nativeThreadId: _nativeThreadId, ...legacy }, index) => ({
                    id: EventId.make(`legacy-attempt:${index}`),
                    type: "run-attempt.updated" as const,
                    threadId,
                    occurredAt: existing.thread.createdAt,
                    payload: legacy,
                  }),
                ),
              });
            }
            if (scenario.includes("telemetry")) {
              const target = (yield* orchestrator.getThreadProjection(
                threadId,
              )).providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make("compacted-context-usage"),
                    type: "provider-thread.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: { ...target, contextUsage: { usedTokens: 100, maxTokens: 32_000 } },
                  },
                ],
              });
            }
            yield* dispatch(
              3,
              priorImages && !replaceNative
                ? "New source constraint " + "q".repeat(9_000)
                : "New source constraint",
              CODEX_MODEL_SELECTION,
            );
            yield* wait(3);
          }
          if (replaceNative) {
            // Switching back to Codex already released Claude's session.
            yield* Ref.set(failResumeOnce, true);
          }
          if (scenario.includes("retry")) yield* Ref.set(failStartOnce, true);
          if (scenario.includes("target-background") || scenario.includes("target-subagent"))
            yield* Ref.set(pendingBackgroundWork, true);
          const beforeRecovery = reusedNative
            ? yield* orchestrator.getThreadProjection(threadId)
            : undefined;
          const historyBeforeRecovery = yield* Ref.get(injectedHistory);
          yield* dispatch(targetOrdinal, current, targetSelection);
          yield* wait(targetOrdinal);
          if (beforeRecovery !== undefined) {
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const latestRun = projection.runs.at(-1)!;
            const throughSequence = yield* eventSink.latestSequence();
            const events = yield* orchestrator.streamStoredEvents.pipe(
              Stream.takeUntil(({ sequence }) => sequence === throughSequence),
              Stream.filter(({ event }) => event.runId === latestRun.id),
              Stream.runCollect,
            );
            assert.isEmpty(
              events.filter(
                ({ event }) =>
                  (event.type === "context-handoff.updated" &&
                    event.payload.strategy === "full_thread_summary") ||
                  (event.type === "context-transfer.updated" &&
                    event.payload.createdBy === "system"),
              ),
            );
            assert.equal(latestRun.status, "failed");
            const failure = projection.turnItems.findLast((item) => item.type === "error");
            assert.equal(
              failure?.type === "error" ? failure.failure.message : null,
              new ContextHandoffBudgetError().message,
            );
            assert.deepEqual(
              projection.providerThreads.map((thread) => [thread.id, thread.nativeThreadRef]),
              beforeRecovery.providerThreads.map((thread) => [thread.id, thread.nativeThreadRef]),
            );
            assert.deepEqual(yield* Ref.get(injectedHistory), historyBeforeRecovery);
            assert.lengthOf(yield* Ref.get(capturedTurns), 3);
            assert.deepEqual(projection.messages.slice(0, -1), beforeRecovery.messages);
            assert.equal(projection.messages.at(-1)!.text, current);
            assert.deepEqual(projection.messages.at(-1)!.attachments, screenshots);
            return;
          }
          if (scenario.includes("retry")) {
            const failed = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(failed.runs.at(-1)?.status, "failed");
            const failedUsage = failed.providerThreads.find(
              (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            )!.contextUsage;
            if (reasoningScenario || scenario.includes("turn-usage")) {
              assert.deepEqual(failedUsage, { usedTokens: 37_321, maxTokens: 258_400 });
            } else {
              assert.deepEqual(failedUsage, { usedTokens: 30_000, maxTokens: 1_000_000 });
            }
            if (reasoningScenario) {
              const target = failed.providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* orchestrator.dispatch({
                type: "provider-session.detach",
                commandId: CommandId.make("detach-before-reasoning-retry"),
                threadId,
                providerSessionId: target.providerSessionId!,
              });
              yield* worker.drain();
            }
            yield* dispatch(targetOrdinal + 1, current, targetSelection);
            yield* wait(targetOrdinal + 1);
          }
          if (reasoningScenario && replaceNative) {
            const replaced = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(
              replaced.runs.at(-1)?.status,
              scenario.includes("small") ? "failed" : "completed",
            );
            const target = replaced.providerThreads.find(
              (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            )!;
            assert.isNull(target.contextUsage);
            assert.equal(yield* Ref.get(generation), 2);
            assert.equal(
              (yield* Ref.get(capturedTurns)).at(-1)!.driver,
              scenario.includes("small") ? CODEX_DRIVER : CLAUDE_DRIVER,
            );
            return;
          }
          if (replaceNative) {
            if (scenario.includes("legacy-replacement")) {
              const recovered = yield* orchestrator.getThreadProjection(threadId);
              const handoff = recovered.contextHandoffs.at(-1)!;
              const { history: _history, ...legacyHandoff } = handoff;
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make("legacy-replacement-handoff"),
                    type: "context-handoff.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: {
                      ...legacyHandoff,
                      delivery: {
                        nativeThreadId: handoff.delivery!.nativeThreadId,
                        status: handoff.delivery!.status,
                        itemIds: [],
                      },
                    },
                  },
                ],
              });
            }
            yield* dispatch(
              targetOrdinal + 1,
              "Continue after native replacement",
              CLAUDE_MODEL_SELECTION,
            );
            yield* wait(targetOrdinal + 1);
            yield* dispatch(
              targetOrdinal + 2,
              "Another source constraint " + "q".repeat(9_000),
              CODEX_MODEL_SELECTION,
            );
            yield* wait(targetOrdinal + 2);
            yield* dispatch(targetOrdinal + 3, current, CLAUDE_MODEL_SELECTION);
            yield* wait(targetOrdinal + 3);
          }
          const projection = yield* orchestrator.getThreadProjection(threadId);
          if (
            scenario.includes("target-oversized") ||
            scenario.includes("target-tight") ||
            scenario.includes("target-background") ||
            scenario.includes("target-subagent")
          ) {
            assert.equal(projection.runs.at(-1)?.status, "failed");
            assert.equal(yield* Ref.get(generation), 1);
            assert.equal(projection.messages.at(-1)!.text, current);
            assert.deepEqual(projection.messages.at(-1)!.attachments, screenshots);
            if (scenario.includes("target-background") || scenario.includes("target-subagent")) {
              assert.isTrue(yield* Ref.get(pendingBackgroundWork));
              const failure = projection.turnItems.findLast((item) => item.type === "error");
              assert.equal(
                failure?.type === "error" ? failure.failure.message : null,
                "The target provider still has background work running. Wait for it to finish or stop it before retrying the handoff.",
              );
            }
            return;
          }
          assert.equal(projection.runs.at(-1)?.status, "completed");
          if (exhaustedTarget) {
            assert.equal(yield* Ref.get(generation), 2);
            const turns = (yield* Ref.get(capturedTurns)).filter(
              (turn) => turn.driver === CLAUDE_DRIVER,
            );
            assert.notEqual(turns[0]!.nativeThreadId, turns[1]!.nativeThreadId);
            const latestRun = projection.runs.at(-1)!;
            assert.equal(
              projection.attempts.find((attempt) => attempt.id === latestRun.activeAttemptId)!
                .nativeThreadId,
              turns[1]!.nativeThreadId,
            );
            const context = scenario.endsWith("-native")
              ? yield* encodeJson(yield* Ref.get(injectedHistory))
              : turns[1]!.text;
            assert.include(context, "Original request with constraints");
            assert.include(context, "Original partial work");
            assert.include(context, "New source constraint");
            assert.include(turns[1]!.text, current);
            assert.deepEqual(turns[1]!.attachments, screenshots);
            const historyBeforeFollowup = yield* Ref.get(injectedHistory);
            yield* dispatch(5, "Continue after automatic recovery", CLAUDE_MODEL_SELECTION);
            yield* wait(5);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
              "completed",
            );
            assert.equal(yield* Ref.get(generation), 2);
            assert.equal(
              (yield* Ref.get(capturedTurns)).at(-1)!.text,
              "Continue after automatic recovery",
            );
            assert.deepEqual(yield* Ref.get(injectedHistory), historyBeforeFollowup);
            if (scenario.includes("target-estimate")) {
              yield* dispatch(6, "Another source turn", CODEX_MODEL_SELECTION);
              yield* wait(6);
              yield* dispatch(7, "Return after recovery", CLAUDE_MODEL_SELECTION);
              yield* wait(7);
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                "completed",
              );
              assert.equal(yield* Ref.get(generation), 2);
            }
            return;
          }
          if (priorImages) {
            const handoff = projection.contextHandoffs.at(-1)!;
            const context = scenario.endsWith("-native")
              ? yield* encodeJson(yield* Ref.get(injectedHistory))
              : (yield* Ref.get(capturedTurns)).at(-1)!.text;
            const shouldFit =
              turnUsageScenario ||
              scenario.startsWith("imported") ||
              scenario.includes("telemetry") ||
              (scenario.includes("unsent") && !scenario.includes("unsent-tight")) ||
              replaceNative;
            const sourceText =
              `${replaceNative ? "Another" : "New"} source constraint ` + "q".repeat(9_000);
            const sourceItem = projection.turnItems.find(
              (item) => item.type === "user_message" && item.text === sourceText,
            )!;
            assert.isDefined(sourceItem);
            if (shouldFit) {
              assert.include(context, sourceText);
              assert.include(
                projection.contextHandoffs
                  .filter(
                    (record) =>
                      record.targetRunId ===
                      (scenario.includes("retry")
                        ? projection.runs.find((run) => run.ordinal === targetOrdinal)!.id
                        : projection.runs.at(-1)!.id),
                  )
                  .flatMap((record) => record.delivery?.itemIds ?? []),
                sourceItem.id,
              );
            } else {
              assert.notInclude(context, "q".repeat(9_000));
              if (scenario.includes("unsent-tight")) {
                assert.include(
                  projection.contextHandoffs.flatMap(
                    (record) => record.delivery?.omittedItemIds ?? [],
                  ),
                  sourceItem.id,
                );
              } else {
                assert.isAbove(handoff.delivery!.omittedItemIds!.length, 0);
              }
            }
            const latestRun = projection.runs.at(-1)!;
            const latestAttempt = projection.attempts.find(
              (attempt) => attempt.id === latestRun.activeAttemptId,
            )!;
            const target = projection.providerThreads.find(
              (thread) => thread.id === latestAttempt.providerThreadId,
            )!;
            assert.equal(latestAttempt.nativeThreadId, target.nativeThreadRef!.nativeId);
            if (turnUsageScenario) {
              if (replaceNative) assert.isNull(target.contextUsage);
              else
                assert.deepEqual(target.contextUsage, { usedTokens: 37_321, maxTokens: 258_400 });
              assert.lengthOf((yield* Ref.get(capturedTurns)).at(-1)!.attachments, 2);
            }
            if (scenario.includes("unsent")) {
              assert.deepEqual((yield* Ref.get(capturedTurns)).at(-1)?.attachments, [screenshot]);
            }
            if (replaceNative) assert.equal(yield* Ref.get(generation), 2);
            return;
          }
          const handoff = projection.contextHandoffs.at(-1)!;
          if (scenario.startsWith("screenshot")) {
            assert.deepEqual((yield* Ref.get(capturedTurns)).at(-1)!.attachments, screenshots);
          }
          if (scenario === "compact-legacy") {
            const { history: _history, ...legacyHandoff } = handoff;
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("legacy-handoff-shape"),
                  type: "context-handoff.updated",
                  threadId,
                  runId: handoff.targetRunId,
                  occurredAt: yield* DateTime.now,
                  payload: legacyHandoff,
                },
              ],
            });
            assert.isUndefined(handoff.delivery);
            yield* dispatch(3, "Continue after compact", CLAUDE_MODEL_SELECTION);
            yield* wait(3);
            assert.include(
              (yield* Ref.get(capturedTurns)).at(-1)!.text,
              "Original request with constraints",
            );
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).contextHandoffs.at(-1)?.delivery
                ?.status,
              "inline",
            );
          } else if (
            scenario === "delivery-write-failure" ||
            (scenario.startsWith("screenshot") && scenario.endsWith("fallback"))
          ) {
            assert.equal(
              handoff.delivery?.status,
              scenario.startsWith("screenshot") ? "inline" : "pending",
            );
            assert.include(
              (yield* Ref.get(capturedTurns)).at(-1)!.text,
              "Original request with constraints",
            );
          } else {
            assert.equal(handoff.delivery?.status, "injected");
            assert.equal((yield* Ref.get(capturedTurns)).at(-1)!.text, current);
            assert.include(
              yield* encodeJson(yield* Ref.get(injectedHistory)),
              "Original request with constraints",
            );
          }
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: `handoff-${scenario}`,
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
  it.live("keeps a native session whose stored prose is far below an unreported window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("handoff-estimate-headroom");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const generation = yield* Ref.make(0);
        // About 112 KB of ordinary English is about 25k tokens: a quarter of a 128k window.
        const prose = "The quick brown fox jumps over the lazy dog. ".repeat(2_500);
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 2: "Source work" },
            capturedTurns,
          }),
          // No window and no usage, like an ACP registry agent that sends no usage_update.
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 1: prose },
            capturedTurns,
            nativeThreadGeneration: generation,
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const dispatch = (ordinal: number, text: string, selection: ModelSelection) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`headroom:${ordinal}`),
              threadId,
              messageId: MessageId.make(`headroom:${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text,
              attachments: [],
              modelSelection: selection,
              dispatchMode: { type: "start_immediately" },
            });
          const wait = (ordinal: number) =>
            orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.payload.ordinal === ordinal &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
              Effect.andThen(worker.drain()),
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("headroom:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Handoff estimate headroom",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* dispatch(1, "Write the long report", CLAUDE_MODEL_SELECTION);
          yield* wait(1);
          yield* dispatch(2, "Continue elsewhere", CODEX_MODEL_SELECTION);
          yield* wait(2);
          yield* dispatch(3, "Back to the first provider", CLAUDE_MODEL_SELECTION);
          yield* wait(3);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
            "completed",
          );
          // A second generation means T3 discarded the native session as full.
          assert.equal(yield* Ref.get(generation), 1);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "handoff-estimate-headroom",
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

  it.live.each(["native", "legacy"] as const)(
    "starts a replacement native thread as new after the resume fallback with %s attempts",
    (attempts) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("resume-fallback-native-turns");
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const failResumeOnce = yield* Ref.make(false);
          const generation = yield* Ref.make(0);
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              failResumeOnce,
              nativeThreadGeneration: generation,
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const runToCompletion = Effect.fn("runToCompletion")(function* (ordinal: number) {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`resume-fallback:${ordinal}`),
                threadId,
                messageId: MessageId.make(`resume-fallback:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text: `Request ${ordinal}`,
                attachments: [],
                modelSelection: CLAUDE_MODEL_SELECTION,
                dispatchMode: { type: "start_immediately" },
              });
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
              );
              yield* worker.drain();
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                "completed",
              );
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("resume-fallback:create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Resume fallback",
              modelSelection: CLAUDE_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* runToCompletion(1);
            const providerThread = (yield* orchestrator.getThreadProjection(
              threadId,
            )).providerThreads.at(0);
            if (providerThread === undefined || providerThread.providerSessionId === null) {
              return yield* Effect.die("Expected a provider session after the first turn.");
            }
            yield* orchestrator.dispatch({
              type: "provider-session.detach",
              commandId: CommandId.make("resume-fallback:detach"),
              threadId,
              providerSessionId: providerThread.providerSessionId,
            });
            yield* worker.drain();
            if (attempts === "legacy") {
              const existing = yield* orchestrator.getThreadProjection(threadId);
              yield* (yield* EventSink.EventSinkV2).write({
                events: existing.attempts.map(
                  ({ nativeThreadId: _nativeThreadId, ...legacy }, index) => ({
                    id: EventId.make(`resume-fallback-legacy-attempt:${index}`),
                    type: "run-attempt.updated" as const,
                    threadId,
                    occurredAt: existing.thread.createdAt,
                    payload: legacy,
                  }),
                ),
              });
            }
            yield* Ref.set(failResumeOnce, true);
            yield* runToCompletion(2);
            yield* runToCompletion(3);

            const turns = yield* Ref.get(capturedTurns);
            assert.equal(turns.length, 3);
            assert.equal(yield* Ref.get(generation), 2);
            assert.notEqual(turns[1]?.nativeThreadId, turns[0]?.nativeThreadId);
            assert.isAbove(turns[1]?.providerTurnOrdinal ?? 0, 1);
            assert.isFalse(turns[1]?.nativeThreadHasTurns);
            assert.equal(turns[2]?.nativeThreadId, turns[1]?.nativeThreadId);
            assert.isTrue(turns[2]?.nativeThreadHasTurns);
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const run2 = projection.runs[1]!;
            const handoff = projection.contextHandoffs.find(
              (candidate) => candidate.targetRunId === run2.id,
            );
            assert.deepEqual(
              projection.turnItems
                .filter((item) => item.runId === run2.id)
                .toSorted((left, right) => left.ordinal - right.ordinal)
                .slice(0, 2)
                .map((item) => (item.type === "handoff" ? item.contextHandoffId : item.type)),
              [handoff?.id, "user_message"],
            );
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: "resume-fallback-native-turns",
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

  it.live.each(["an older handoff", "a missed request"] as const)(
    "keeps the latest turn when a resume fallback also delivers %s",
    (older) =>
      Effect.scoped(
        Effect.gen(function* () {
          // A run that fails before its provider turn starts is retried as a missed request.
          const missed = older === "a missed request";
          const name = `resume-fallback-handoff-order${missed ? "-missed" : ""}`;
          const cwd = yield* checkpointWorkspace(name);
          const failStartOnce = yield* Ref.make(false);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const oldResult = `old result ${"o".repeat(2_500)}`;
          const latestResult = `latest result ${"l".repeat(2_500)}`;
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: { 1: oldResult, 3: latestResult },
              capturedTurns,
              injectedHistory,
              failResume: true,
              ...(missed ? { failStartOnce } : { failedRunOrdinals: new Set([2]) }),
              nativeThreadGeneration: yield* Ref.make(0),
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const runAfterDetach = Effect.fn("runAfterDetach")(function* (
              ordinal: number,
              text: string,
            ) {
              const providerSessionId = (yield* orchestrator.getThreadProjection(threadId))
                .providerThreads[0]?.providerSessionId;
              if (providerSessionId != null) {
                yield* orchestrator.dispatch({
                  type: "provider-session.detach",
                  commandId: CommandId.make(`handoff-order:detach:${ordinal}`),
                  threadId,
                  providerSessionId,
                });
                yield* worker.drain();
              }
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`handoff-order:${ordinal}`),
                threadId,
                messageId: MessageId.make(`handoff-order:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text,
                attachments: [],
                modelSelection: CLAUDE_MODEL_SELECTION,
                dispatchMode: { type: "start_immediately" },
              });
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
              );
              yield* worker.drain();
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("handoff-order:create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Resume fallback handoff order",
              modelSelection: CLAUDE_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* runAfterDetach(1, `Original brief ${"b".repeat(9_000)}`);
            yield* Ref.set(failStartOnce, missed);
            yield* runAfterDetach(2, missed ? `Request 2 ${"r".repeat(6_000)}` : "Request 2");
            yield* runAfterDetach(3, "Request 3");
            const historyBeforeRun4 = (yield* Ref.get(injectedHistory)).length;
            yield* runAfterDetach(4, "Request 4");

            const projection = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(
              projection.runs.map((run) => run.status),
              ["completed", "failed", "completed", "completed"],
            );
            const run4NativeThreadId = (yield* Ref.get(capturedTurns)).at(-1)?.nativeThreadId;
            assert.notEqual(
              projection.contextHandoffs.find(
                (handoff) => handoff.targetRunId === projection.runs[1]?.id,
              )?.delivery?.nativeThreadId,
              run4NativeThreadId,
            );
            const run4History = yield* encodeJson(
              (yield* Ref.get(injectedHistory)).slice(historyBeforeRun4),
            );
            assert.include(run4History, "Original brief");
            assert.include(run4History, latestResult);
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

  it.live.each(refusalCases)(
    "keeps the native session after turns refused for %s",
    ([, refusalCause, recovery]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("refused-start-keeps-native");
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const failResumeOnce = yield* Ref.make(false);
          const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const refuseStarts = yield* Ref.make(0);
          const generation = yield* Ref.make(0);
          const registry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              refuseStarts,
              refusalCause,
              refuseAfterSubmitFence: recovery === "ambiguous",
              failResumeOnce,
              ...(recovery === "inject" ? { injectedHistory } : {}),
              nativeThreadGeneration: generation,
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const missedImage: ChatAttachment = {
              type: "image",
              id: "refused-start-image",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 100_000,
            };
            const acceptedImage = { ...missedImage, id: "accepted-start-image" };
            const run = Effect.fn("run")(function* (ordinal: number) {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`refused-start:${ordinal}`),
                threadId,
                messageId: MessageId.make(`refused-start:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text: `Request ${ordinal}`,
                attachments: ordinal === 1 ? [acceptedImage] : ordinal === 2 ? [missedImage] : [],
                modelSelection: CLAUDE_MODEL_SELECTION,
                dispatchMode: { type: "start_immediately" },
              });
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
              );
              yield* worker.drain();
              return (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status;
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("refused-start:create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Refused start",
              modelSelection: CLAUDE_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            assert.equal(yield* run(1), "completed");
            const recoveredAt = recovery === "ambiguous" ? 3 : 4;
            yield* Ref.set(refuseStarts, recoveredAt - 2);
            assert.equal(yield* run(2), "failed");
            if (recoveredAt === 4) assert.equal(yield* run(3), "failed");
            if (recovery === "lost") {
              const sessionId = (yield* orchestrator.getThreadProjection(threadId))
                .providerThreads[0]?.providerSessionId;
              assert.isNotNull(sessionId);
              assert.isDefined(sessionId);
              yield* orchestrator.dispatch({
                type: "provider-session.detach",
                commandId: CommandId.make("refused-start:detach"),
                threadId,
                providerSessionId: sessionId!,
              });
              yield* worker.drain();
              yield* Ref.set(failResumeOnce, true);
            }
            assert.equal(yield* run(recoveredAt), "completed");

            const turns = yield* Ref.get(capturedTurns);
            assert.equal(turns.length, 2);
            assert.equal(yield* Ref.get(generation), recovery === "lost" ? 2 : 1);
            if (recovery !== "lost")
              assert.equal(turns[1]?.nativeThreadId, turns[0]?.nativeThreadId);
            const delivered = `${turns[1]?.text}${JSON.stringify(yield* Ref.get(injectedHistory))}`;
            if (recovery === "ambiguous") {
              assert.notInclude(delivered, "Request 2");
              assert.deepEqual(turns[1]?.attachments, []);
            } else {
              assert.include(delivered, "Request 2");
              assert.include(delivered, "Request 3");
              assert.deepEqual(turns[1]?.attachments, [missedImage]);
            }
            assert.equal(yield* run(recoveredAt + 1), "completed");
            assert.deepEqual((yield* Ref.get(capturedTurns)).at(-1)?.attachments, []);
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: "refused-start-keeps-native",
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

  it.live("checks the queued provider's capability while the current provider stays running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const scenario of [
          { activeSupportsQueue: false, selectedSupportsQueue: true },
          { activeSupportsQueue: true, selectedSupportsQueue: false },
        ]) {
          const key = `active-${scenario.activeSupportsQueue}-selected-${scenario.selectedSupportsQueue}`;
          const cwd = yield* checkpointWorkspace(`queued-capability-${key}`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const started = yield* Deferred.make<void>();
          const scenarioThreadId = ThreadId.make(`thread:queued-capability:${key}`);
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: {
                ...CodexProviderCapabilitiesV2,
                turns: {
                  ...CodexProviderCapabilitiesV2.turns,
                  supportsQueuedMessages: scenario.activeSupportsQueue,
                },
              },
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              holdFirstTurn: started,
            }),
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: {
                ...ClaudeProviderCapabilitiesV2,
                turns: {
                  ...ClaudeProviderCapabilitiesV2.turns,
                  supportsQueuedMessages: scenario.selectedSupportsQueue,
                },
              },
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-capability:create:${key}`),
              threadId: scenarioThreadId,
              projectId: ProjectId.make(`project:queued-capability:${key}`),
              title: "Queued capability",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-capability:first:${key}`),
              threadId: scenarioThreadId,
              messageId: MessageId.make(`message:queued-capability:first:${key}`),
              text: "Current Codex turn",
              attachments: [],
              modelSelection: CODEX_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            });
            yield* Deferred.await(started);
            yield* worker.drain();
            const queue = orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-capability:claude:${key}`),
              threadId: scenarioThreadId,
              messageId: MessageId.make(`message:queued-capability:claude:${key}`),
              text: "Queued Claude turn",
              attachments: [],
              modelSelection: CLAUDE_MODEL_SELECTION,
              dispatchMode: { type: "queue_after_active" },
            });
            if (scenario.selectedSupportsQueue) {
              yield* queue;
            } else {
              const error = yield* queue.pipe(Effect.flip);
              assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
              assert.instanceOf(error.cause, CommandPolicyCapabilityUnsupportedError);
              assert.equal(error.cause.capability, "queued_messages");
            }
            const projection = yield* orchestrator.getThreadProjection(scenarioThreadId);
            assert.deepEqual(
              projection.runs.map((run) => run.status),
              scenario.selectedSupportsQueue ? ["running", "queued"] : ["running"],
            );
            assert.deepEqual(projection.thread.modelSelection, CODEX_MODEL_SELECTION);
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: `queued-capability-${key}`,
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
        }
      }),
    ),
  );

  it.live("hands completed Grok steering context to earlier queued Codex and later Claude", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-steer-provider-switch");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 2: "Codex queued response" },
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 3: "Claude queued response" },
            capturedTurns,
          }),
          makeTestAdapter({
            instanceId: GROK_MODEL_SELECTION.instanceId,
            driver: GROK_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            modelSelection: GROK_MODEL_SELECTION,
            responseByRunOrdinal: { 1: "Grok steered response" },
            capturedTurns,
          }),
        ]);
        const queuedThreadId = ThreadId.make("thread:queued-steer-provider-switch");
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const dispatch = (
            key: string,
            modelSelection: ModelSelection,
            dispatchMode: Extract<
              OrchestrationV2Command,
              { readonly type: "message.dispatch" }
            >["dispatchMode"],
          ) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-steer-provider-switch:${key}`),
              threadId: queuedThreadId,
              messageId: MessageId.make(`message:queued-steer-provider-switch:${key}`),
              text: `Prompt ${key}`,
              attachments: [],
              modelSelection,
              dispatchMode,
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-steer-provider-switch:create"),
            threadId: queuedThreadId,
            projectId: ProjectId.make("project:queued-steer-provider-switch"),
            title: "Queued steer provider switch",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* dispatch("first", CODEX_MODEL_SELECTION, { type: "start_immediately" });
          yield* Deferred.await(started);
          yield* worker.drain();
          yield* dispatch("codex-queued", CODEX_MODEL_SELECTION, { type: "queue_after_active" });
          yield* dispatch("claude-queued", CLAUDE_MODEL_SELECTION, { type: "queue_after_active" });
          const beforeSteer = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(
            beforeSteer.runs.map((run) => run.status),
            ["running", "queued", "queued"],
          );
          assert.equal(beforeSteer.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
          assert.lengthOf(beforeSteer.contextHandoffs, 0);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-steer-provider-switch:first-turn-running"),
                type: "provider-turn.updated",
                threadId: queuedThreadId,
                runId: beforeSteer.runs[0]!.id,
                nodeId: beforeSteer.runs[0]!.rootNodeId!,
                driver: CODEX_DRIVER,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make("provider-turn:queued-steer-provider-switch:first"),
                  providerThreadId: beforeSteer.runs[0]!.providerThreadId!,
                  nodeId: beforeSteer.runs[0]!.rootNodeId!,
                  runAttemptId: beforeSteer.runs[0]!.activeAttemptId!,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              },
            ],
          });
          const queuedClaudeCompleted = yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === beforeSteer.runs[2]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
          yield* dispatch("grok-steer", GROK_MODEL_SELECTION, {
            type: "steer_active",
            targetRunId: beforeSteer.runs[0]!.id,
          });
          const afterSteer = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(afterSteer.thread.modelSelection, GROK_MODEL_SELECTION);
          const interruptedTurn = afterSteer.providerTurns.find(
            (turn) => turn.runAttemptId === beforeSteer.runs[0]?.activeAttemptId,
          )!;
          const interruptedAttempt = afterSteer.attempts.find(
            (attempt) => attempt.id === beforeSteer.runs[0]?.activeAttemptId,
          )!;
          const interruptedAt = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-steer-provider-switch:first-turn-interrupted"),
                type: "provider-turn.updated",
                threadId: queuedThreadId,
                runId: beforeSteer.runs[0]!.id,
                nodeId: beforeSteer.runs[0]!.rootNodeId!,
                driver: CODEX_DRIVER,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: interruptedAt,
                payload: {
                  ...interruptedTurn,
                  status: "interrupted",
                  completedAt: interruptedAt,
                },
              },
              {
                id: EventId.make("event:queued-steer-provider-switch:first-attempt-interrupted"),
                type: "run-attempt.updated",
                threadId: queuedThreadId,
                runId: beforeSteer.runs[0]!.id,
                nodeId: beforeSteer.runs[0]!.rootNodeId!,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: interruptedAt,
                payload: {
                  ...interruptedAttempt,
                  status: "interrupted",
                  completedAt: interruptedAt,
                },
              },
            ],
          });
          yield* worker.drain();
          yield* Fiber.join(queuedClaudeCompleted);
          return yield* orchestrator.getThreadProjection(queuedThreadId);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "queued-steer-provider-switch",
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
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [GROK_MODEL_SELECTION.instanceId, "completed"],
            [CODEX_MODEL_SELECTION.instanceId, "completed"],
            [CLAUDE_MODEL_SELECTION.instanceId, "completed"],
          ],
        );
        const turns = yield* Ref.get(capturedTurns);
        assert.deepEqual(
          turns.map((turn) => turn.driver),
          [CODEX_DRIVER, GROK_DRIVER, CODEX_DRIVER, CLAUDE_DRIVER],
        );
        assert.include(turns[2]?.text ?? "", "Grok steered response");
        assert.include(turns[3]?.text ?? "", "Grok steered response");
        assert.include(turns[3]?.text ?? "", "Codex queued response");
        assert.deepEqual(
          projection.contextHandoffs.map((handoff) => handoff.targetRunId),
          [projection.runs[0]?.id, projection.runs[1]?.id, projection.runs[2]?.id],
        );
      }),
    ),
  );

  it.live("resumes a queued account switch without requiring a portable handoff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-account-switch");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const alternateSelection: ModelSelection = {
          ...CODEX_MODEL_SELECTION,
          instanceId: ProviderInstanceId.make("codex-alternate"),
        };
        const alternateCapabilities = {
          ...CodexProviderCapabilitiesV2,
          canConsumeHandoffSummaries: false,
        };
        const adapters = [
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: alternateSelection.instanceId,
            driver: CODEX_DRIVER,
            capabilities: alternateCapabilities,
            modelSelection: alternateSelection,
            responseByRunOrdinal: { 2: "Alternate account complete" },
            capturedTurns,
          }),
        ];
        const layerRegistry = Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            get: (instanceId) => {
              const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
              return adapter === undefined
                ? Effect.fail(
                    new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
                  )
                : Effect.succeed(adapter);
            },
            list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
            getMetadata: (instanceId) => {
              const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
              return adapter === undefined
                ? Effect.fail(
                    new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
                  )
                : Effect.succeed({
                    driver: CODEX_DRIVER,
                    continuationKey: "codex:shared-native-account-history",
                    enabled: true,
                    capabilities:
                      instanceId === alternateSelection.instanceId
                        ? alternateCapabilities
                        : CodexProviderCapabilitiesV2,
                  });
            },
          }),
        );
        const queuedThreadId = ThreadId.make("thread:queued-account-switch");
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-account-switch:create"),
            threadId: queuedThreadId,
            projectId: ProjectId.make("project:queued-account-switch"),
            title: "Queued account switch",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-account-switch:first"),
            threadId: queuedThreadId,
            messageId: MessageId.make("message:queued-account-switch:first"),
            text: "First account turn",
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          yield* Deferred.await(started);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-account-switch:second"),
            threadId: queuedThreadId,
            messageId: MessageId.make("message:queued-account-switch:second"),
            text: "Alternate account turn",
            attachments: [],
            modelSelection: alternateSelection,
            dispatchMode: { type: "queue_after_active" },
          });
          const queued = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(
            queued.runs.map((run) => run.status),
            ["running", "queued"],
          );
          assert.equal(queued.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
          const sourceNativeRef = queued.providerThreads.find(
            (providerThread) => providerThread.id === queued.runs[0]?.providerThreadId,
          )?.nativeThreadRef;
          assert.isNotNull(sourceNativeRef);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-account-switch:first-complete"),
                type: "run.updated",
                threadId: queuedThreadId,
                runId: queued.runs[0]!.id,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: { ...queued.runs[0]!, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.resumeQueuedRuns;
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === queued.runs[1]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const delivered = yield* orchestrator.getThreadProjection(queuedThreadId);
          const targetNativeRef = delivered.providerThreads.find(
            (providerThread) => providerThread.id === delivered.runs[1]?.providerThreadId,
          )?.nativeThreadRef;
          assert.deepEqual(targetNativeRef, sourceNativeRef);
          return delivered;
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "queued-account-switch",
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
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [CODEX_MODEL_SELECTION.instanceId, "completed"],
            [alternateSelection.instanceId, "completed"],
          ],
        );
        assert.lengthOf(projection.contextHandoffs, 0);
        assert.deepEqual(
          (yield* Ref.get(capturedTurns)).map((turn) => turn.text),
          ["First account turn", "Alternate account turn"],
        );
      }),
    ),
  );

  it.live("finishes earlier queued Codex turns before handing context to queued Claude", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-provider-switch");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("codex"),
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {
              1: "Codex current turn complete",
              2: "Codex first queued turn complete",
              3: "Codex second queued turn complete",
            },
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 4: "Claude turn complete" },
            capturedTurns,
          }),
        ]);
        const queuedThreadId = ThreadId.make("thread:queued-provider-switch");
        const layerDatabase = SqlitePersistence.layerMemory;
        const layerOutboxProvided = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
          const dispatch = (ordinal: number, modelSelection: ModelSelection) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-provider-switch:${ordinal}`),
              threadId: queuedThreadId,
              messageId: MessageId.make(`message:queued-provider-switch:${ordinal}`),
              text: `Prompt ${ordinal}`,
              attachments: [],
              modelSelection,
              dispatchMode: {
                type: ordinal === 1 ? "start_immediately" : "queue_after_active",
              },
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-provider-switch:create"),
            threadId: queuedThreadId,
            projectId: ProjectId.make("project:queued-provider-switch"),
            title: "Queued provider switch",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* dispatch(1, CODEX_MODEL_SELECTION);
          yield* Deferred.await(started);
          yield* dispatch(2, CODEX_MODEL_SELECTION);
          yield* dispatch(3, CODEX_MODEL_SELECTION);
          yield* dispatch(4, CLAUDE_MODEL_SELECTION);
          const queued = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(
            queued.runs.map((run) => run.status),
            ["running", "queued", "queued", "queued"],
          );
          assert.equal(queued.thread.activeProviderThreadId, queued.runs[0]?.providerThreadId);
          assert.equal(queued.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
          assert.lengthOf(queued.contextHandoffs, 0);
          const activeSession = queued.providerSessions.find(
            (session) => session.providerInstanceId === CODEX_MODEL_SELECTION.instanceId,
          );
          assert.isDefined(activeSession);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              ...(["stopped", "error"] as const).map((status) => ({
                id: EventId.make(`event:queued-provider-switch:dead-session:${status}`),
                type: "provider-session.updated" as const,
                threadId: queuedThreadId,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  ...activeSession!,
                  id: ProviderSessionId.make(`provider-session:queued-provider-switch:${status}`),
                  status,
                },
              })),
              {
                id: EventId.make("event:queued-provider-switch:first-response"),
                type: "turn-item.updated",
                threadId: queuedThreadId,
                runId: queued.runs[0]!.id,
                nodeId: queued.runs[0]!.rootNodeId!,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("turn-item:queued-provider-switch:first-response"),
                  threadId: queuedThreadId,
                  runId: queued.runs[0]!.id,
                  nodeId: queued.runs[0]!.rootNodeId!,
                  providerThreadId: queued.runs[0]!.providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 101,
                  status: "completed",
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "assistant_message",
                  messageId: MessageId.make("message:queued-provider-switch:first-response"),
                  text: "Codex current turn complete",
                  streaming: false,
                },
              },
              {
                id: EventId.make("event:queued-provider-switch:first-complete"),
                type: "run.updated",
                threadId: queuedThreadId,
                runId: queued.runs[0]!.id,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: { ...queued.runs[0]!, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.resumeQueuedRuns;
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === queued.runs[3]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const detachEvents = yield* eventSink.stream({ threadId: queuedThreadId }).pipe(
            Stream.filter((stored) => stored.event.type === "provider-session.detached"),
            Stream.take(1),
            Stream.runCollect,
          );
          assert.equal(
            detachEvents[0]?.event.type === "provider-session.detached"
              ? detachEvents[0].event.payload.providerSessionId
              : null,
            activeSession?.id,
          );
          const startCommandId = CommandId.make(
            `command:system:start-queued:${queued.runs[3]!.id}`,
          );
          const detachEffects = (yield* effectOutbox.listByCommandId(startCommandId)).filter(
            (effect) => effect.request.type === "provider-session.detach",
          );
          assert.deepEqual(
            detachEffects.map((effect) =>
              effect.request.type === "provider-session.detach"
                ? effect.request.providerSessionId
                : null,
            ),
            [activeSession?.id],
          );
          return yield* orchestrator.getThreadProjection(queuedThreadId);
        }).pipe(
          Effect.provide(
            Layer.merge(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: "queued-provider-switch",
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
                { databaseLayer: layerDatabase },
              ),
              layerOutboxProvided,
            ),
          ),
        );
        const turns = yield* Ref.get(capturedTurns);
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            ["codex", "completed"],
            ["codex", "completed"],
            ["codex", "completed"],
            ["claudeAgent", "completed"],
          ],
        );
        assert.deepEqual(
          turns.map((turn) => [turn.driver, turn.text.includes("Prompt 4")]),
          [
            ["codex", false],
            ["codex", false],
            ["codex", false],
            ["claudeAgent", true],
          ],
        );
        assert.lengthOf(projection.contextHandoffs, 1);
        assert.equal(projection.contextHandoffs[0]?.targetRunId, projection.runs[3]?.id);
        const handoffItem = projection.turnItems.find(
          (item) => item.type === "handoff" && item.runId === projection.runs[3]?.id,
        );
        assert.equal(
          handoffItem?.type === "handoff" ? handoffItem.contextHandoffId : null,
          projection.contextHandoffs[0]?.id,
        );
        const queuedUserItem = projection.turnItems.find(
          (item) => item.type === "user_message" && item.runId === projection.runs[3]?.id,
        );
        assert.isBelow(handoffItem?.ordinal ?? Infinity, queuedUserItem?.ordinal ?? -Infinity);
        assert.include(
          handoffItem?.type === "handoff" ? handoffItem.summary : "",
          "Codex second queued turn complete",
        );
        assert.include(turns[3]?.text ?? "", "Codex current turn complete");
        assert.include(turns[3]?.text ?? "", "Codex first queued turn complete");
        assert.include(turns[3]?.text ?? "", "Codex second queued turn complete");
      }),
    ),
  );

  it.live.each([
    ["automatic", "Claude"],
    ["queue.resume", "compatible Codex"],
  ] as const)(
    "delivers a queued PR update on the current provider through %s (%s)",
    ([delivery, target]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace(`pr-wake-${delivery}`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const compatible = target === "compatible Codex";
          const selection = {
            ...(compatible
              ? { ...CODEX_MODEL_SELECTION, instanceId: ProviderInstanceId.make("codex-alternate") }
              : CLAUDE_MODEL_SELECTION),
            options: [{ id: "reasoningEffort", value: "low" }],
          };
          const targetCapabilities = compatible
            ? {
                ...CodexProviderCapabilitiesV2,
                context: {
                  ...CodexProviderCapabilitiesV2.context,
                  canConsumeHandoffSummaries: false,
                },
              }
            : ClaudeProviderCapabilitiesV2;
          const adapters = [
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: CodexProviderCapabilitiesV2,
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              holdFirstTurn: started,
              releaseFirstTurn: release,
              failedRunOrdinals: new Set([1]),
              failure: makeProviderFailure({
                message: "Usage limit reached",
                class: "usage_limit",
                code: "usage_limit",
              }),
            }),
            makeTestAdapter({
              instanceId: selection.instanceId,
              driver: compatible ? CODEX_DRIVER : CLAUDE_DRIVER,
              capabilities: targetCapabilities,
              modelSelection: selection,
              responseByRunOrdinal: {},
              capturedTurns,
            }),
          ];
          const layerRegistry = compatible
            ? Layer.succeed(
                ProviderAdapterRegistry.ProviderAdapterRegistryV2,
                ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
                  get: (instanceId) => {
                    const adapter = adapters.find(
                      (candidate) => candidate.instanceId === instanceId,
                    );
                    return adapter === undefined
                      ? Effect.fail(
                          new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({
                            instanceId,
                          }),
                        )
                      : Effect.succeed(adapter);
                  },
                  list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
                  getMetadata: (instanceId) =>
                    Effect.succeed({
                      driver: CODEX_DRIVER,
                      continuationKey: "codex:shared-native-account-history",
                      enabled: true,
                      capabilities:
                        instanceId === selection.instanceId
                          ? targetCapabilities
                          : CodexProviderCapabilitiesV2,
                    }),
                }),
              )
            : ProviderAdapterRegistry.layerFromAdapters(adapters);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const dispatch = (text: string, modelSelection: ModelSelection) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(text),
                messageId: MessageId.make(text),
                threadId,
                text,
                modelSelection,
                attachments: [],
                createdBy: "user",
                creationSource: "web",
                dispatchMode: { type: "start_immediately" },
              });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "PR wake",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* dispatch("Original work", CODEX_MODEL_SELECTION);
            yield* Deferred.await(started);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("wake"),
              messageId: MessageId.make("wake"),
              threadId,
              text: "Review the new PR comments",
              attachments: [],
              createdBy: "agent",
              creationSource: "server",
              dispatchMode: { type: "queue_after_active" },
              notification: {
                source: { kind: "monitor" },
                outcome: "updated",
                summary: "New PR comments",
              },
            });
            const [active, wake] = (yield* orchestrator.getThreadProjection(threadId)).runs;
            assert.isDefined(active);
            assert.isDefined(wake);
            assert.equal(wake.status, "queued");
            yield* Deferred.succeed(release, undefined);
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.runId === active.id &&
                  event.payload.status === "failed",
              ),
              Stream.runHead,
            );
            yield* worker.drain();

            if (delivery === "automatic") {
              yield* dispatch("Take over the work", selection);
            } else {
              yield* orchestrator.dispatch({
                type: "thread.model-selection.set",
                commandId: CommandId.make("select"),
                threadId,
                modelSelection: selection,
              });
              yield* orchestrator.dispatch({
                type: "queue.resume",
                commandId: CommandId.make("resume"),
                threadId,
              });
            }
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.runId === wake.id &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
            const after = yield* orchestrator.getThreadProjection(threadId);
            const turns = yield* Ref.get(capturedTurns);
            assert.lengthOf(turns, delivery === "automatic" ? 3 : 2);
            const executed = turns.at(-1)!;
            assert.equal(executed.driver, compatible ? CODEX_DRIVER : CLAUDE_DRIVER);
            assert.include(executed.text, "Review the new PR comments");
            assert.deepEqual(executed.modelSelection, selection);
            assert.deepEqual(after.thread.modelSelection, selection);
            const delivered = after.runs.find((run) => run.id === wake.id)!;
            assert.equal(delivered.status, "completed");
            assert.deepEqual(delivered.modelSelection, selection);
            assert.equal(delivered.providerInstanceId, selection.instanceId);
            assert.equal(delivered.providerThreadId, executed.providerThreadId);
            assert.equal(after.thread.activeProviderThreadId, delivered.providerThreadId);
            if (delivery === "automatic") {
              assert.equal(executed.providerThreadId, turns[1]!.providerThreadId);
              assert.equal(executed.nativeThreadId, turns[1]!.nativeThreadId);
            }
            if (compatible) {
              assert.equal(executed.nativeThreadId, turns[0]!.nativeThreadId);
              assert.isEmpty(after.contextHandoffs);
            }
            assert.equal(
              after.providerThreads.find((entry) => entry.id === delivered.providerThreadId)
                ?.providerInstanceId,
              selection.instanceId,
            );
            assert.equal(
              after.turnItems.find(
                (entry) => entry.type === "notification" && entry.runId === wake.id,
              )?.providerThreadId,
              delivered.providerThreadId,
            );
            const attempt = after.attempts.find((entry) => entry.id === delivered.activeAttemptId);
            const root = after.nodes.find((entry) => entry.id === delivered.rootNodeId);
            assert.equal(attempt?.providerInstanceId, selection.instanceId);
            assert.equal(attempt?.providerThreadId, delivered.providerThreadId);
            assert.equal(root?.providerThreadId, delivered.providerThreadId);
            assert.equal(
              after.checkpointScopes.find((entry) => entry.id === root?.checkpointScopeId)
                ?.providerThreadId,
              delivered.providerThreadId,
            );
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                { name: `pr-wake-${delivery}`, runtimePolicyOverride: { cwd } },
                layerRegistry,
              ),
            ),
          );
        }),
      ),
  );

  it.live("fails an unsupported queued handoff and advances to the next queued provider", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-handoff-rejection");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const rejectedThreadId = ThreadId.make("thread:queued-handoff-rejection");
        const rejectedMessageId = MessageId.make("message:queued-handoff-rejection:claude");
        const unsupportedClaudeCapabilities = {
          ...ClaudeProviderCapabilitiesV2,
          context: {
            ...ClaudeProviderCapabilitiesV2.context,
            canConsumeHandoffSummaries: false,
          },
        };
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 3: "Later Codex queued turn complete" },
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: unsupportedClaudeCapabilities,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
          }),
        ]);
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-handoff-rejection:create"),
            threadId: rejectedThreadId,
            projectId: ProjectId.make("project:queued-handoff-rejection"),
            title: "Queued handoff rejection",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-handoff-rejection:first"),
            threadId: rejectedThreadId,
            messageId: MessageId.make("message:queued-handoff-rejection:first"),
            text: "First Codex turn",
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          yield* Deferred.await(started);
          const active = yield* orchestrator.getThreadProjection(rejectedThreadId);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-handoff-rejection:existing-item"),
                type: "turn-item.updated",
                threadId: rejectedThreadId,
                runId: active.runs[0]!.id,
                nodeId: active.runs[0]!.rootNodeId!,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("turn-item:queued-handoff-rejection:existing-item"),
                  threadId: rejectedThreadId,
                  runId: active.runs[0]!.id,
                  nodeId: active.runs[0]!.rootNodeId!,
                  providerThreadId: active.runs[0]!.providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 150,
                  status: "completed",
                  title: null,
                  inputIntent: "turn_start",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "user_message",
                  messageId: rejectedMessageId,
                  text: "Unsupported Claude turn",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                },
              },
            ],
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-handoff-rejection:claude"),
            threadId: rejectedThreadId,
            messageId: rejectedMessageId,
            text: "Unsupported Claude turn",
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "queue_after_active" },
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-handoff-rejection:later"),
            threadId: rejectedThreadId,
            messageId: MessageId.make("message:queued-handoff-rejection:later"),
            text: "Later Codex turn",
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "queue_after_active" },
          });
          const queued = yield* orchestrator.getThreadProjection(rejectedThreadId);
          assert.deepEqual(
            queued.runs.map((run) => run.status),
            ["running", "queued", "queued"],
          );
          const queuedItem = queued.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === rejectedMessageId,
          );
          assert.equal(queuedItem?.runId, queued.runs[1]?.id);
          assert.equal(queuedItem?.providerThreadId, queued.runs[1]?.providerThreadId);
          assert.equal(queuedItem?.status, "pending");
          assert.isNull(queuedItem?.startedAt);
          assert.isNull(queuedItem?.completedAt);
          assert.isFalse(queued.visibleTurnItems.some((row) => row.item.id === queuedItem?.id));
          const queuedSequence = yield* eventSink.latestSequence({ threadId: rejectedThreadId });
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-handoff-rejection:first-complete"),
                type: "run.updated",
                threadId: rejectedThreadId,
                runId: queued.runs[0]!.id,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: { ...queued.runs[0]!, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.resumeQueuedRuns;
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === queued.runs[2]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          // Clients whose bounded snapshot omitted the hidden queued item must
          // receive it while the run is still queued, before it fails.
          const throughSequence = yield* eventSink.latestSequence({ threadId: rejectedThreadId });
          const failureEvents = yield* eventSink
            .stream({ threadId: rejectedThreadId, afterSequence: queuedSequence })
            .pipe(
              Stream.takeUntil((stored) => stored.sequence === throughSequence),
              Stream.map(({ event }) => event),
              Stream.filter((event) => event.runId === queued.runs[1]!.id),
              Stream.runCollect,
            );
          const republished = failureEvents.findIndex(
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.type === "user_message" &&
              event.payload.messageId === rejectedMessageId,
          );
          assert.isAtLeast(republished, 0);
          const restored = failureEvents[republished];
          assert.equal(restored?.type, "turn-item.updated");
          if (restored?.type === "turn-item.updated") {
            assert.deepEqual(restored.payload, {
              ...queuedItem,
              ordinal: 2_000_001,
              status: "failed",
              completedAt: restored.occurredAt,
              updatedAt: restored.occurredAt,
            });
          }
          assert.isBelow(
            republished,
            failureEvents.findIndex(
              (event) => event.type === "run.updated" && event.payload.status === "failed",
            ),
          );
          return yield* orchestrator.getThreadProjection(rejectedThreadId);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "queued-handoff-rejection",
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
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["completed", "failed", "completed"],
        );
        assert.equal(projection.runs[1]?.queuePosition, null);
        assert.equal(
          projection.attempts.find((attempt) => attempt.runId === projection.runs[1]?.id)?.status,
          "failed",
        );
        assert.equal(
          projection.nodes.find((node) => node.runId === projection.runs[1]?.id)?.status,
          "failed",
        );
        assert.equal(projection.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
        assert.lengthOf(projection.contextHandoffs, 1);
        assert.include((yield* Ref.get(capturedTurns)).at(-1)!.text, "Unsupported Claude turn");
        const failureItem = projection.turnItems.find(
          (item) => item.type === "error" && item.runId === projection.runs[1]?.id,
        );
        assert.equal(
          failureItem?.type === "error" ? failureItem.failure.code : null,
          "context_handoff_unsupported",
        );
        assert.isTrue(
          projection.visibleTurnItems.some(
            ({ item }) => item.type === "user_message" && item.messageId === rejectedMessageId,
          ),
        );
        assert.deepEqual(
          (yield* Ref.get(capturedTurns)).map((turn) => turn.driver),
          [CODEX_DRIVER, CODEX_DRIVER],
        );
      }),
    ),
  );

  it.live(
    "reissues imported v1 context when a queued provider starts after the first provider fails",
    () => importedFailureScenario(true),
  );

  it.live.each([
    "immediately",
    "behind a running turn",
    "after a cancelled queued switch",
  ] as const)(
    "hands a portable fork's inherited conversation to a provider switched %s",
    (variant) =>
      Effect.gen(function* () {
        const queued = variant !== "immediately";
        const cancelled = variant === "after a cancelled queued switch";
        const key = cancelled ? "cancelled" : queued ? "queued" : "immediate";
        const cwd = yield* checkpointWorkspace(`fork-switch-history-${key}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 1: "The release marker is violet." },
            capturedTurns,
          }),
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            ...(queued ? { holdFirstTurn: started, releaseFirstTurn: release } : {}),
          }),
        ]);
        const sourceThreadId = ThreadId.make(`thread:fork-switch-history:${key}:source`);
        const forkThreadId = ThreadId.make(`thread:fork-switch-history:${key}:fork`);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const send = (threadId: ThreadId, name: string, modelSelection: ModelSelection) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:fork-switch-history:${key}:${name}`),
              threadId,
              messageId: MessageId.make(`message:fork-switch-history:${key}:${name}`),
              text: `Prompt ${name}`,
              attachments: [],
              modelSelection,
              dispatchMode: { type: "start_immediately" },
            });
          const settle = (threadId: ThreadId) =>
            worker.drain().pipe(
              Effect.andThen(waitForIdle(threadId)),
              Effect.tap(() => worker.drain()),
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:fork-switch-history:${key}:create`),
            threadId: sourceThreadId,
            projectId,
            title: "Fork switch history",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* send(sourceThreadId, "source", CODEX_MODEL_SELECTION);
          const source = yield* settle(sourceThreadId);
          yield* orchestrator.dispatch({
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:fork-switch-history:${key}:fork`),
            sourceThreadId,
            targetThreadId: forkThreadId,
            sourcePoint: { type: "run", runId: source.runs[0]!.id },
            title: "Fork",
          });
          // A first turn on another provider resolves the fork through portable context.
          yield* send(forkThreadId, "fork-claude", CLAUDE_MODEL_SELECTION);
          if (queued) {
            yield* Deferred.await(started);
            yield* send(
              forkThreadId,
              cancelled ? "fork-codex-cancelled" : "fork-codex",
              CODEX_MODEL_SELECTION,
            );
            if (cancelled) {
              // The cancelled run leaves its reserved Codex row behind without a native thread.
              const pending = (yield* orchestrator.getThreadProjection(forkThreadId)).runs.at(-1)!;
              yield* orchestrator.dispatch({
                type: "queued-run.cancel",
                commandId: CommandId.make(`command:fork-switch-history:${key}:cancel`),
                threadId: forkThreadId,
                runId: pending.id,
              });
            }
            yield* Deferred.succeed(release, undefined);
            if (cancelled) {
              yield* settle(forkThreadId);
              yield* send(forkThreadId, "fork-codex", CODEX_MODEL_SELECTION);
            }
          } else {
            yield* settle(forkThreadId);
            yield* send(forkThreadId, "fork-codex", CODEX_MODEL_SELECTION);
          }
          yield* settle(forkThreadId);
          yield* send(forkThreadId, "fork-claude-again", CLAUDE_MODEL_SELECTION);
          yield* settle(forkThreadId);

          const turns = yield* Ref.get(capturedTurns);
          const turnFor = (name: string) =>
            turns.find((turn) => turn.text.endsWith(`Prompt ${name}`))!.text;
          const switched = turnFor("fork-codex");
          // The switched provider gets the conversation the fork shows, oldest first.
          assert.include(switched, "Prompt source");
          const positions = ["Prompt source", "release marker is violet", "Prompt fork-claude"].map(
            (text) => switched.indexOf(text),
          );
          assert.deepEqual(
            positions,
            positions.toSorted((a, b) => a - b),
          );
          // Claude already saw the inherited rows, so its return only carries the Codex run.
          const returned = turnFor("fork-claude-again");
          assert.include(returned, "Prompt fork-codex");
          assert.notInclude(returned, "Prompt source");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: `fork-switch-history-${key}`,
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
