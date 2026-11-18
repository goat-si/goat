import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./testing/providerSwitchAdapter.ts";

it.live.each([
  { target: "opencode", nativeGoals: false },
  { target: "opencode", nativeGoals: true },
  { target: "codex", nativeGoals: true },
] as const)(
  "$target goal defers provider-switch history only with native support: $nativeGoals",
  ({ target, nativeGoals }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`goal-handoff-${target}-${nativeGoals}`);
        const turns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const selection = { instanceId: ProviderInstanceId.make("opencode-goal"), model: "test" };
        const initialSelection = target === "codex" ? selection : CODEX_MODEL_SELECTION;
        const targetSelection = target === "codex" ? CODEX_MODEL_SELECTION : selection;
        const registry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: ProviderDriverKind.make("codex"),
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: target === "codex" ? {} : { 1: "Original partial work" },
            capturedTurns: turns,
          }),
          makeTestAdapter({
            instanceId: selection.instanceId,
            driver: ProviderDriverKind.make("opencode"),
            capabilities: {
              ...CodexProviderCapabilitiesV2,
              turns: { ...CodexProviderCapabilitiesV2.turns, supportsNativeGoals: nativeGoals },
            },
            modelSelection: selection,
            responseByRunOrdinal: target === "codex" ? { 1: "Original partial work" } : {},
            capturedTurns: turns,
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make(`thread:goal-handoff-${target}-${nativeGoals}`);
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:goal-handoff"),
            createdBy: "user",
            creationSource: "web",
            title: "Goal handoff",
            modelSelection: initialSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          const send = (ordinal: number, text: string, modelSelection: typeof selection) =>
            Effect.gen(function* () {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`command:${ordinal}`),
                threadId,
                messageId: MessageId.make(`message:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text,
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
                Effect.andThen(worker.drain()),
              );
            });
          yield* send(1, "Original request with constraints", initialSelection);
          yield* send(2, "/goal all tests pass", targetSelection);
          const goal = (yield* Ref.get(turns)).at(-1)!.text;
          assert.equal(goal.includes("Original request with constraints"), !nativeGoals);
          if (nativeGoals) {
            assert.equal(goal, "/goal all tests pass");
            yield* send(3, "Continue", targetSelection);
            assert.include(
              (yield* Ref.get(turns)).at(-1)!.text,
              "Original request with constraints",
            );
          }
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: `goal-handoff-${target}-${nativeGoals}`,
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
