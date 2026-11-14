import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { RunAttemptId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { makeCodexReplayTurn, makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";

it.effect("fails a stalled 429 provider retry as a usage limit and stops the Codex turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scenario = "codex-provider-retry-stall";
      const nativeThreadId = `native-${scenario}-thread`;
      const nativeTurnId = `native-${scenario}-turn`;
      const transcript = makeCodexReplayTranscript({
        scenario,
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Continue." }),
          {
            type: "emit_inbound",
            label: "error/retry",
            frame: {
              method: "error",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                willRetry: true,
                error: {
                  message: "Reconnecting... 1/5",
                  additionalDetails: "exceeded retry limit, last status: 429 Too Many Requests",
                  codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } },
                },
              },
            },
          },
          {
            type: "expect_outbound",
            label: "turn/interrupt",
            frame: {
              id: 4,
              method: "turn/interrupt",
              params: { threadId: nativeThreadId, turnId: nativeTurnId },
            },
          },
          { type: "emit_inbound", label: "turn/interrupt", frame: { id: 4, result: {} } },
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "interrupted" }),
              },
            },
          },
        ],
      });
      const retryShown = yield* Deferred.make<void>();
      const interruptSent = yield* Deferred.make<void>();
      const harness = yield* makeCodexReplayHarness(
        transcript,
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "error"
            ? Deferred.succeed(retryShown, undefined)
            : Effect.void,
        (method) =>
          method === "turn/interrupt" ? Deferred.succeed(interruptSent, undefined) : Effect.void,
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          text: "Continue.",
          attemptId: RunAttemptId.make(`attempt-${scenario}`),
        }),
      );
      yield* Deferred.await(retryShown);
      yield* TestClock.adjust("9 minutes");
      assert.isEmpty(harness.terminalEvents());
      yield* TestClock.adjust("1 minute");
      assert.lengthOf(harness.terminalEvents(), 1);
      yield* harness.firstTerminal;
      yield* Deferred.await(interruptSent);
      const terminal = harness.terminalEvents()[0];
      assert.equal(terminal?.status, "failed");
      if (terminal?.status !== "failed") return;
      assert.equal(terminal.failure.class, "usage_limit");
      assert.equal(terminal.failure.code, "responseStreamDisconnected");
      assert.equal(
        terminal.failure.message,
        "exceeded retry limit, last status: 429 Too Many Requests",
      );
      assert.equal(terminal.retry?.attempt, 1);
      assert.equal(terminal.threadDisposition, "reusable");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          MemoryDerivedCache.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
        ),
      ),
    ),
  ),
);
