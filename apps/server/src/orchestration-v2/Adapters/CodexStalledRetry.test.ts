import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
          NodeCrypto.layer,
        ),
      ),
    ),
  ),
);

it.effect("bounds repeated Codex retries from the first notice", () =>
  Effect.gen(function* () {
    const nativeThreadId = "native-retry-budget-thread";
    const nativeTurnId = "native-retry-budget-turn";
    const retry = (attempt: number) => ({
      type: "emit_inbound" as const,
      label: `retry-${attempt}`,
      frame: {
        method: "error",
        params: {
          threadId: nativeThreadId,
          turnId: nativeTurnId,
          willRetry: true,
          error: {
            message: `Reconnecting... ${attempt}/5`,
            additionalDetails: `Transport failure ${attempt}`,
            codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
          },
        },
      },
    });
    const transcript = makeCodexReplayTranscript({
      scenario: "codex-repeated-retry-budget",
      entries: [
        ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Continue." }),
        retry(1),
        retry(2),
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
      ],
    });
    const first = yield* Deferred.make<void>();
    const second = yield* Deferred.make<void>();
    const sendSecond = yield* Deferred.make<void>();
    const harness = yield* makeCodexReplayHarness(
      transcript,
      (event) => {
        if (
          event.type !== "turn_item.updated" ||
          event.turnItem.type !== "error" ||
          event.turnItem.retry === undefined
        )
          return Effect.void;
        return Deferred.succeed(event.turnItem.retry.attempt === 1 ? first : second, undefined);
      },
      undefined,
      undefined,
      (entry) => (entry.label === "retry-2" ? Deferred.await(sendSecond) : Effect.void),
    );
    yield* harness.runtime.startTurn(
      makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        text: "Continue.",
        attemptId: RunAttemptId.make("attempt-codex-retry-budget"),
      }),
    );
    yield* Deferred.await(first);
    yield* TestClock.adjust("9 minutes");
    yield* Deferred.succeed(sendSecond, undefined);
    yield* Deferred.await(second);
    assert.isEmpty(harness.terminalEvents());
    yield* TestClock.adjust("1 minute");
    const terminal = harness.terminalEvents().at(-1);
    assert.equal(terminal?.status, "failed");
    if (terminal?.status !== "failed") return;
    assert.equal(terminal.failure.message, "Transport failure 2");
    assert.equal(terminal.retry?.attempt, 2);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        MemoryDerivedCache.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  ),
);

it.effect.each(["retry", "failure"] as const)(
  "orders a later provider %s after progress from the same turn",
  (tail) =>
    Effect.gen(function* () {
      const scenario = `codex-provider-later-${tail}`;
      const nativeThreadId = `native-${scenario}-thread`;
      const nativeTurnId = `native-${scenario}-turn`;
      const retryNotice = (message: string) => ({
        type: "emit_inbound" as const,
        label: `error/retry/${message}`,
        frame: {
          method: "error",
          params: {
            threadId: nativeThreadId,
            turnId: nativeTurnId,
            willRetry: true,
            error: {
              message,
              additionalDetails: "The response stream disconnected.",
              codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 529 } },
            },
          },
        },
      });
      const commandItem = (status: "inProgress" | "completed") => ({
        type: "commandExecution",
        id: "command-between-retries",
        command: "pwd",
        cwd: "/workspace",
        processId: "42",
        source: "unifiedExecStartup",
        status,
        commandActions: [{ type: "unknown", command: "pwd" }],
        aggregatedOutput: status === "completed" ? "/workspace\n" : null,
        exitCode: status === "completed" ? 0 : null,
        durationMs: status === "completed" ? 10 : null,
      });
      const transcript = makeCodexReplayTranscript({
        scenario,
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Run pwd." }),
          retryNotice("Reconnecting... 1/5"),
          {
            type: "emit_inbound",
            label: "item/started",
            frame: {
              method: "item/started",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                startedAtMs: 1782622445000,
                item: commandItem("inProgress"),
              },
            },
          },
          {
            type: "emit_inbound",
            label: "item/completed",
            frame: {
              method: "item/completed",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                completedAtMs: 1782622445010,
                item: commandItem("completed"),
              },
            },
          },
          ...(tail === "retry" ? [retryNotice("Reconnecting... 1/5")] : []),
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({
                  id: nativeTurnId,
                  status: tail === "retry" ? "completed" : "failed",
                }),
              },
            },
          },
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`attempt-${scenario}`),
          text: "Run pwd.",
        }),
      );
      yield* harness.firstTerminal;

      const items = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      const command = items.find((item) => item.type === "command_execution");
      assert.isDefined(command);
      const terminal = harness.terminalEvents()[0];
      const firstRetry = items.find((item) => item.type === "error");
      const latest =
        tail === "retry"
          ? items.findLast((item) => item.type === "error")
          : terminal?.status === "failed"
            ? { id: terminal.failureItemId, ordinal: terminal.failureItemOrdinal }
            : undefined;
      assert.isAbove(latest?.ordinal ?? 0, command?.ordinal ?? Infinity);
      // Stored positions are per row, so the later notice needs its own row to sort after.
      assert.isDefined(latest?.id);
      assert.notStrictEqual(latest?.id, firstRetry?.id);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          MemoryDerivedCache.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
);
