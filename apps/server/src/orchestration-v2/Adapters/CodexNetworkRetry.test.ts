import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { RunAttemptId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodexReplayTurn, makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);

it.effect("clears retry limits while waiting for network", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scenario = "codex-provider-api-retry";
      const nativeThreadId = `native-${scenario}-thread`;
      const nativeTurnId = `native-${scenario}-turn`;
      const transcript = makeCodexReplayTranscript({
        scenario,
        entries: [
          ...codexReplayPreamble({
            nativeThreadId,
            nativeTurnId,
            prompt: "Open github.com.",
          }),
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
                  message: "Reconnecting... 2/5",
                  additionalDetails: "The response stream disconnected.",
                  codexErrorInfo: {
                    responseStreamDisconnected: { httpStatusCode: 529 },
                  },
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "error/retry/waiting-for-network",
            frame: {
              method: "error",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                willRetry: true,
                error: {
                  message: "Reconnecting... waiting for network",
                  additionalDetails: "Connection failed: error sending request",
                  codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "item/started/after-retry",
            frame: {
              method: "item/started",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                startedAtMs: 1782622445000,
                item: {
                  type: "commandExecution",
                  id: "command-after-provider-retry",
                  command: "pwd",
                  cwd: "/workspace",
                  processId: "42",
                  source: "unifiedExecStartup",
                  status: "inProgress",
                  commandActions: [{ type: "unknown", command: "pwd" }],
                  aggregatedOutput: null,
                  exitCode: null,
                  durationMs: null,
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "item/completed/after-retry",
            frame: {
              method: "item/completed",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                completedAtMs: 1782622445010,
                item: {
                  type: "commandExecution",
                  id: "command-after-provider-retry",
                  command: "pwd",
                  cwd: "/workspace",
                  processId: "42",
                  source: "unifiedExecStartup",
                  status: "completed",
                  commandActions: [{ type: "unknown", command: "pwd" }],
                  aggregatedOutput: "/workspace\n",
                  exitCode: 0,
                  durationMs: 10,
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-codex-provider-api-retry"),
          text: "Open github.com.",
        }),
      );
      yield* harness.awaitUntil(
        () => harness.terminalEvents().length === 1,
        "Codex retry recovery",
      );

      const retryItems = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "error" &&
        event.turnItem.retry !== undefined
          ? [event.turnItem]
          : [],
      );
      assert.lengthOf(retryItems, 3);
      assert.equal(retryItems[0]?.status, "running");
      assert.equal(retryItems[0]?.failure.code, "responseStreamDisconnected");
      assert.deepEqual(retryItems[0]?.retry, {
        attempt: 2,
        maxAttempts: 5,
        retryDelayMs: null,
      });
      assert.deepEqual(retryItems[1]?.retry, { attempt: 3, maxAttempts: null, retryDelayMs: null });
      assert.equal(retryItems[2]?.id, retryItems[0]?.id);
      assert.equal(retryItems[2]?.status, "completed");
      assert.equal(retryItems[2]?.title, "Provider recovered");

      const recoveredIndex = harness.events.findIndex(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.status === "completed",
      );
      const resumedCommandIndex = harness.events.findIndex(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "command_execution" &&
          event.turnItem.input === "pwd",
      );
      const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
      assert.isAtLeast(recoveredIndex, 0);
      assert.isAbove(resumedCommandIndex, recoveredIndex);
      assert.isAbove(terminalIndex, resumedCommandIndex);
    }).pipe(Effect.provide(layerAdapterTest)),
  ),
);
