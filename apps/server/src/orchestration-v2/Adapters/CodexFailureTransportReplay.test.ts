import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

it.effect.each([
  { message: "connection lost", expected: "transport_error" },
  { message: "other failure", expected: "provider_error" },
] as const)("preserves matching connection evidence for $message", ({ message, expected }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const nativeThreadId = "transport-thread",
        nativeTurnId = "transport-turn";
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: `transport-${expected}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Work." }),
            {
              type: "emit_inbound",
              frame: {
                method: "item/started",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { type: "webSearch", id: "started", query: "x", action: null },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "error",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  willRetry: false,
                  error: {
                    message: "connection lost",
                    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
                    additionalDetails: null,
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: {
                    ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                    error: { message, codexErrorInfo: "other" },
                  },
                },
              },
            },
          ],
        }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`transport-${expected}`),
          text: "Work.",
        }),
      );
      yield* harness.firstTerminal;
      const terminal = harness.terminalEvents()[0];
      assert.equal(terminal?.status, "failed");
      if (terminal?.status === "failed") assert.equal(terminal.failure.class, expected);
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
