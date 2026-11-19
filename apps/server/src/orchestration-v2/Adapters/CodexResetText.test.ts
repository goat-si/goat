import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

it.effect("retains the reset from a proxied usage-limit error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const nativeThreadId = "reset-thread",
        nativeTurnId = "reset-turn",
        prompt = "Continue.";
      const nativeFinished = DateTime.makeZonedUnsafe(
        { year: 2026, month: 11, day: 7, hour: 9 },
        { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
      );
      yield* TestClock.setTime(
        DateTime.toEpochMillis(
          DateTime.makeZonedUnsafe(
            { year: 2030, month: 1, day: 1, hour: 9 },
            { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
          ),
        ),
      );
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: "reset-text",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: {
                    ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                    completedAt: DateTime.toEpochMillis(nativeFinished) / 1000,
                    error: {
                      message: "Usage limit. Try again at 3:37 PM.",
                      codexErrorInfo: "usageLimitExceeded",
                    },
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
          attemptId: RunAttemptId.make("attempt-reset"),
          text: prompt,
        }),
      );
      yield* harness.firstTerminal;
      const terminal = harness.terminalEvents()[0];
      assert.equal(terminal?.status, "failed");
      if (terminal?.status === "failed")
        assert.equal(
          terminal.failure.resetAt,
          DateTime.formatIso(
            DateTime.makeZonedUnsafe(
              { year: 2026, month: 11, day: 7, hour: 15, minute: 38 },
              { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
            ),
          ),
        );
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
