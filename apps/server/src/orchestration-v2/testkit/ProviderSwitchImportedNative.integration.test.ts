import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./testing/providerSwitchAdapter.ts";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
const threadId = ThreadId.make("thread:provider-switch");
const projectId = ProjectId.make("project:provider-switch");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
describe("imported native provider sessions", () => {
  const importedNativeSessionScenario = (
    scenario: "first-send" | "after-failed-switch" | "resume-fails",
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`imported-native-session-${scenario}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const claudeOrdinal = scenario === "after-failed-switch" ? 2 : 1;
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { [claudeOrdinal]: "PELICAN" },
            capturedTurns,
            failResume: scenario === "resume-fails",
          }),
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            failedRunOrdinals: new Set([1]),
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("imported-native:create"),
            threadId,
            projectId,
            createdBy: "system",
            creationSource: "server",
            title: "Imported Claude Code session",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          // The rows AgentSessionImporter writes: imported messages without a run,
          // bound to the strong native session they came from.
          const created = yield* orchestrator.getThreadProjection(threadId);
          const at = created.thread.createdAt;
          const providerThread: OrchestrationV2ProviderThread = {
            id: ProviderThreadId.make("provider-thread:imported-native"),
            driver: CLAUDE_DRIVER,
            providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: CLAUDE_DRIVER,
              nativeId: "native-session",
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: at,
            updatedAt: at,
          };
          const common = {
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            status: "completed" as const,
            title: null,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
          };
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("imported-native:thread"),
                type: "thread.metadata-updated",
                threadId,
                providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
                occurredAt: at,
                payload: {
                  ...created.thread,
                  historyOrigin: "v1_import",
                  activeProviderThreadId: providerThread.id,
                },
              },
              {
                id: EventId.make("imported-native:user"),
                type: "turn-item.updated",
                threadId,
                occurredAt: at,
                payload: {
                  ...common,
                  id: TurnItemId.make("imported-native:user"),
                  ordinal: 1,
                  createdBy: "user",
                  creationSource: "server",
                  type: "user_message",
                  messageId: MessageId.make("imported-native:user"),
                  inputIntent: "turn_start",
                  text: "Remember the code word PELICAN.",
                  attachments: [],
                },
              },
              {
                id: EventId.make("imported-native:assistant"),
                type: "turn-item.updated",
                threadId,
                occurredAt: at,
                payload: {
                  ...common,
                  id: TurnItemId.make("imported-native:assistant"),
                  ordinal: 2,
                  type: "assistant_message",
                  messageId: MessageId.make("imported-native:assistant"),
                  text: "OK",
                  streaming: false,
                },
              },
              {
                id: EventId.make("imported-native:provider-thread"),
                type: "provider-thread.updated",
                threadId,
                driver: CLAUDE_DRIVER,
                providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
                occurredAt: at,
                payload: providerThread,
              },
            ],
          });
          const send = (ordinal: number, modelSelection: ModelSelection) =>
            Effect.gen(function* () {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`imported-native:${ordinal}`),
                threadId,
                messageId: MessageId.make(`imported-native:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text: "What was the code word?",
                attachments: [],
                modelSelection,
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
          if (scenario === "after-failed-switch") yield* send(1, CODEX_MODEL_SELECTION);
          yield* send(claudeOrdinal, CLAUDE_MODEL_SELECTION);

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(projection.runs.at(-1)?.status, "completed");
          const claudeTurn = (yield* Ref.get(capturedTurns)).findLast(
            (turn) => turn.driver === CLAUDE_DRIVER,
          );
          const importHandoffTargets = projection.contextHandoffs
            .filter((handoff) => handoff.strategy === "manual_context")
            .map((handoff) => handoff.toProviderThreadId);
          if (scenario === "resume-fails") {
            // The replacement session is empty, so the recovery summary carries the import.
            assert.notEqual(claudeTurn?.nativeThreadId, "native-session");
            assert.deepEqual(
              projection.contextHandoffs.map((handoff) => handoff.strategy),
              ["full_thread_summary"],
            );
            assert.include(claudeTurn?.text ?? "", "Remember the code word PELICAN.");
            return;
          }
          assert.equal(claudeTurn?.nativeThreadId, "native-session");
          assert.notInclude(importHandoffTargets, providerThread.id);
          assert.lengthOf(importHandoffTargets, scenario === "after-failed-switch" ? 1 : 0);
          if (scenario === "first-send") assert.deepEqual(projection.contextHandoffs, []);
          assert.notInclude(claudeTurn?.text ?? "", "Remember the code word PELICAN.");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: `imported-native-session-${scenario}`,
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
    );
  it.live("resumes an imported native session without resending its history", () =>
    importedNativeSessionScenario("first-send"),
  );
  it.live("returns to an imported native session without resending its history", () =>
    importedNativeSessionScenario("after-failed-switch"),
  );
  it.live("recovers an imported native session's history when its resume fails", () =>
    importedNativeSessionScenario("resume-fails"),
  );
});
