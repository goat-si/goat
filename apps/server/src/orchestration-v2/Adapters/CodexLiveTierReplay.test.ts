import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { buildCodexDevelopmentContext } from "../../provider/CodexDeveloperInstructions.ts";
import { CODEX_TEST_MODEL_SELECTION, makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

it.effect.each([
  { result: { result: {} }, tier: true, label: "accepted" },
  {
    result: { error: { code: -32601, message: "Method not found" } },
    tier: false,
    label: "unsupported",
  },
] as const)(
  "picker update $label preserves the pinned model on a capacity retry",
  ({ result, tier, label }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = `picker-retry-${label}`;
        const nativeTurnId = `picker-turn-${label}`;
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: `picker-retry-${label}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Work." }),
              {
                type: "expect_outbound",
                frame: {
                  id: 4,
                  method: "thread/settings/update",
                  params: { threadId: nativeThreadId, serviceTier: "fast" },
                },
              },
              { type: "emit_inbound", frame: { id: 4, ...result } },
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: {
                      ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                      error: {
                        message: "Selected model is at capacity.",
                        codexErrorInfo: "serverOverloaded",
                      },
                    },
                  },
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  id: 5,
                  method: "turn/start",
                  params: {
                    threadId: nativeThreadId,
                    input: [],
                    cwd: "/workspace",
                    model: "gpt-5.4",
                    collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                    additionalContext: buildCodexDevelopmentContext(),
                    approvalPolicy: "never",
                    approvalsReviewer: "user",
                    sandboxPolicy: { type: "dangerFullAccess" },
                    summary: "auto",
                    ...(tier ? { serviceTier: "fast" } : {}),
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  id: 5,
                  result: { turn: makeCodexReplayTurn({ id: "retry-turn", status: "inProgress" }) },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/started",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: "retry-turn", status: "inProgress" }),
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: "retry-turn", status: "completed" }),
                  },
                },
              },
            ],
          }),
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        );
        const input = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`picker-${label}`),
          text: "Work.",
        });
        yield* harness.runtime.startTurn(input);
        yield* harness.awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === nativeTurnId,
            ),
          "native turn registered",
        );
        assert.isDefined(harness.runtime.applyModelSelection);
        if (harness.runtime.applyModelSelection === undefined) return;
        yield* harness.runtime.applyModelSelection({
          providerThread: harness.providerThread,
          modelSelection: {
            ...CODEX_TEST_MODEL_SELECTION,
            model: "gpt-different",
            options: [{ id: "serviceTier", value: "fast" }],
          },
        });
        yield* harness.awaitSleep(30_000);
        yield* TestClock.adjust(30_000);
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          MemoryDerivedCache.layer,
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
);
