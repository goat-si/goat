import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type ModelSelection,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { AcpProviderCapabilitiesV2 } from "@goat/provider-acp/server/adapter";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CODEX_MODEL_SELECTION, GROK_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./testing/providerSwitchAdapter.ts";
const threadId = ThreadId.make("thread:provider-switch");
const projectId = ProjectId.make("project:provider-switch");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const GROK_DRIVER = ProviderDriverKind.make("acp");

it.live.each([
  { name: "a slash command", text: "/implement do X", verbatim: true },
  { name: "a message opening with a path", text: "/usr/lib/foo is broken", verbatim: false },
] as const)(
  "a switched ACP provider gets $name with the handoff where the command allows it",
  ({ text: firstMessage, verbatim }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`slash-command-handoff-${verbatim}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const originalPrompt = "Keep the release marker violet and preserve the existing API.";
        const codexResponse = "I checked the API and found the release configuration.";
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 1: codexResponse },
            capturedTurns,
          }),
          makeTestAdapter({
            instanceId: GROK_MODEL_SELECTION.instanceId,
            driver: GROK_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            modelSelection: GROK_MODEL_SELECTION,
            responseByRunOrdinal: { 2: "Implemented.", 3: "Continued." },
            capturedTurns,
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const waitForRun = (ordinal: number) =>
            orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.threadId === threadId &&
                  event.payload.ordinal === ordinal &&
                  event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.andThen(worker.drain()),
            );
          const dispatch = (key: string, text: string, modelSelection: ModelSelection) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`command:slash-handoff:${key}`),
              threadId,
              messageId: MessageId.make(`message:slash-handoff:${key}`),
              createdBy: "user",
              creationSource: "web",
              text,
              attachments: [],
              modelSelection,
              dispatchMode: { type: "start_immediately" },
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("command:slash-handoff:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Slash command provider handoff",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* dispatch("source", originalPrompt, CODEX_MODEL_SELECTION);
          yield* waitForRun(1);
          yield* dispatch("slash", firstMessage, GROK_MODEL_SELECTION);
          yield* waitForRun(2);
          const slashTurn = (yield* Ref.get(capturedTurns)).at(-1)!;
          assert.equal(slashTurn.driver, GROK_DRIVER);
          if (!verbatim) {
            assert.include(slashTurn.text, originalPrompt);
            assert.include(slashTurn.text, `User message:\n${firstMessage}`);
            return;
          }
          assert.equal(
            slashTurn.text,
            firstMessage,
            "ACP only expands a native slash command when the prompt starts with it",
          );

          yield* dispatch("next", "Continue", GROK_MODEL_SELECTION);
          yield* waitForRun(3);
          const next = (yield* Ref.get(capturedTurns)).at(-1)!;
          assert.include(next.text, originalPrompt);
          assert.include(next.text, codexResponse);
          assert.include(next.text, "User message:\nContinue");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "slash-command-handoff",
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
