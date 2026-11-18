import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./testing/providerSwitchAdapter.ts";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const threadId = ThreadId.make("thread:provider-switch");
const projectId = ProjectId.make("project:provider-switch");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

it.live.each(
  (
    [
      ["failed", false, false, false],
      ["failed", true, true, true],
      ["interrupted", false, true, false],
      ["interrupted", true, false, true],
      ["cancelled", false, false, false],
      ["cancelled", true, true, false],
    ] as const
  ).map(
    ([status, queued, returning, native]) =>
      [
        `${status} context ${queued ? "through the queue" : "immediately"} to ${returning ? "a returning" : "a new"} provider via ${native ? "native history" : "text"}`,
        { status, queued, returning, native },
      ] as const,
  ),
)("hands off %s", ([, { status, queued, returning, native }]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`handoff-${status}-${queued}-${returning}`);
      const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const sourceOrdinal = returning ? 2 : 1;
      const sourceSelection = returning ? CLAUDE_MODEL_SELECTION : CODEX_MODEL_SELECTION;
      const targetSelection = returning ? CODEX_MODEL_SELECTION : CLAUDE_MODEL_SELECTION;
      const originalPrompt = "Keep the release marker violet and preserve the existing API.";
      const partialResponse = "I checked the API and found the release configuration.";
      const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(
        (
          [
            [CODEX_MODEL_SELECTION, CODEX_DRIVER, CodexProviderCapabilitiesV2],
            [CLAUDE_MODEL_SELECTION, CLAUDE_DRIVER, ClaudeProviderCapabilitiesV2],
          ] as const
        ).map(([modelSelection, driver, capabilities]) =>
          makeTestAdapter({
            instanceId: modelSelection.instanceId,
            driver,
            capabilities,
            modelSelection,
            responseByRunOrdinal: { [sourceOrdinal]: partialResponse },
            capturedTurns,
            ...(native && modelSelection.instanceId === targetSelection.instanceId
              ? { injectedHistory }
              : {}),
            ...(modelSelection.instanceId === sourceSelection.instanceId
              ? {
                  failedRunOrdinals: new Set(status === "failed" ? [sourceOrdinal] : []),
                  interruptedRunOrdinals: new Set(status === "interrupted" ? [sourceOrdinal] : []),
                  cancelledRunOrdinals: new Set(status === "cancelled" ? [sourceOrdinal] : []),
                  holdRunOrdinal: sourceOrdinal,
                  holdFirstTurn: started,
                  releaseFirstTurn: release,
                }
              : {}),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const waitForRun = (
          ordinal: number,
          expectedStatus: "completed" | "failed" | "interrupted" | "cancelled",
        ) =>
          orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.threadId === threadId &&
                event.payload.ordinal === ordinal &&
                event.payload.status === expectedStatus,
            ),
            Stream.runHead,
            Effect.andThen(worker.drain()),
          );
        const dispatch = (
          key: string,
          text: string,
          modelSelection: ModelSelection,
          queue = false,
        ) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`command:handoff:${key}`),
            threadId,
            messageId: MessageId.make(`message:handoff:${key}`),
            createdBy: "user",
            creationSource: "web",
            text,
            attachments: [],
            modelSelection,
            dispatchMode: { type: queue ? "queue_after_active" : "start_immediately" },
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:handoff:create"),
          threadId,
          projectId,
          createdBy: "user",
          creationSource: "web",
          title: "Interrupted provider handoff",
          modelSelection: CODEX_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        if (returning) {
          yield* dispatch("initial", "Earlier successful request.", CODEX_MODEL_SELECTION);
          yield* waitForRun(1, "completed");
        }
        yield* dispatch("source", originalPrompt, sourceSelection);
        yield* Deferred.await(started);
        if (queued) {
          yield* dispatch("target", "Continue", targetSelection, true);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
            "queued",
          );
        }
        yield* Deferred.succeed(release, undefined);
        yield* waitForRun(sourceOrdinal, status);
        if (!queued) {
          yield* dispatch("target", "Continue", targetSelection);
        }
        yield* waitForRun(sourceOrdinal + 1, "completed");
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const targetRun = projection.runs.at(-1)!;
        const handoff = projection.contextHandoffs.find(
          (candidate) => candidate.id === targetRun.contextHandoffId,
        );
        assert.isDefined(handoff);
        assert.equal(
          handoff?.strategy,
          returning ? "delta_since_target_last_seen" : "full_thread_summary",
        );
        assert.deepEqual(handoff?.coveredRunOrdinals, {
          from: sourceOrdinal,
          to: sourceOrdinal,
        });
        const delivered = (yield* Ref.get(capturedTurns)).at(-1)!;
        const history = yield* Ref.get(injectedHistory);
        const deliveredHistory = native ? yield* encodeJson(history) : delivered.text;
        assert.include(deliveredHistory, originalPrompt);
        assert.include(deliveredHistory, partialResponse);
        assert.include(deliveredHistory, `run-status=${status}`);
        if (native) {
          assert.equal(delivered.text, "Continue");
          assert.notInclude(deliveredHistory, '"text":"Continue"');
          assert.include(deliveredHistory, '"role":"assistant"');
          assert.include(deliveredHistory, '"role":"user"');
          assert.equal(handoff?.delivery?.status, "injected");
        } else {
          assert.include(delivered.text, "User message:\nContinue");
          assert.equal(handoff?.delivery?.status, "inline");
        }
        assert.notInclude(deliveredHistory, "Earlier successful request.");
        yield* dispatch("back", "Finish the remaining work", sourceSelection);
        yield* waitForRun(sourceOrdinal + 2, "completed");
        const back = (yield* Ref.get(capturedTurns)).at(-1)!;
        assert.notInclude(back.text, originalPrompt);
        assert.notInclude(back.text, partialResponse);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name: `handoff-${status}-${queued}-${returning}`,
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
