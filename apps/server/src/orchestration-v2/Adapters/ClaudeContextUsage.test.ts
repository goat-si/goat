import { RunAttemptId, type ProviderApprovalDecision } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { CLAUDE_TEST_MODEL_SELECTION, makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  claudeSdkFrame,
  makeResultFrame,
  WAKE_NATIVE_SESSION,
} from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

vi.mock("effect/Queue", async (importOriginal) => {
  const actual = await importOriginal<typeof Queue>();
  return {
    ...actual,
    take: <A, E>(queue: Queue.Dequeue<A, E>) =>
      Effect.gen(function* () {
        const capture = yield* CaptureEventQueue;
        if (capture !== undefined && actual.isEnqueue<unknown, never>(queue)) {
          yield* capture((marker) => actual.offer(queue, marker));
        }
        return yield* actual.take(queue);
      }),
  };
});

const zeroUsage = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
};
const usageStreamFrame = (event: unknown, parentToolUseId: string | null = null) =>
  claudeSdkFrame({
    type: "stream_event",
    event,
    parent_tool_use_id: parentToolUseId,
    session_id: WAKE_NATIVE_SESSION,
    uuid: "usage-stream-frame",
  });
const usageSnapshotFrame = (id: string, uuid: string, usage: unknown) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
    parent_tool_use_id: null,
    uuid,
    session_id: WAKE_NATIVE_SESSION,
  });
const reportedContextTokens = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) =>
    event.type === "provider_turn.updated" && event.providerTurn.tokenUsage !== undefined
      ? [event.providerTurn.tokenUsage.usedTokens]
      : [],
  );

describe("ClaudeAdapterV2 context usage", () => {
  it("dates cache expiry from the request start, not the response end", () => {
    const usage = ClaudeAdapterV2.claudeProviderTurnTokenUsage(
      {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 300 },
      },
      CLAUDE_TEST_MODEL_SELECTION,
      "2026-08-29T00:03:00.000Z",
      "",
      DateTime.makeUnsafe("2026-08-29T00:00:00.000Z"),
    );
    assert.strictEqual(usage.promptCacheExpiresAt, "2026-08-29T00:05:00.000Z");
  });

  it.effect("measures Claude context from the last main-model pass in an advisor response", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-advisor-context"),
          text: "Continue.",
          attachments: [],
        }),
      );
      const usage = {
        input_tokens: 4,
        cache_read_input_tokens: 1087272,
        cache_creation_input_tokens: 1222,
        output_tokens: 711,
        iterations: [
          {
            type: "message",
            input_tokens: 2,
            cache_read_input_tokens: 543529,
            cache_creation_input_tokens: 214,
            output_tokens: 268,
          },
          { type: "advisor_message", input_tokens: 545497, output_tokens: 3144 },
          {
            type: "message",
            input_tokens: 2,
            cache_read_input_tokens: 543743,
            cache_creation_input_tokens: 1008,
            output_tokens: 443,
          },
        ],
      };
      for (const frame of [
        usageStreamFrame({
          type: "message_start",
          message: { id: "msg_advisor", usage: zeroUsage },
        }),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage,
        }),
        usageSnapshotFrame("msg_snapshot_only", "00000000-0000-4000-8000-000000000690", {
          ...zeroUsage,
          iterations: [
            ...usage.iterations,
            { type: "advisor_message", input_tokens: 547000, output_tokens: 25 },
          ],
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000691", result: "Done." }),
      ])
        yield* Queue.offer(harness.sdkMessages, frame);
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
      assert.deepEqual(reportedContextTokens(harness.events), [545196, 545196]);
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
  );
});

describe("ClaudeAdapterV2 approval cancellation", () => {
  it.effect("observes an approval signal that was already aborted", () =>
    Effect.gen(function* () {
      const decision = yield* Deferred.make<{
        decision: ProviderApprovalDecision;
        feedback?: string;
      }>();
      const result = yield* ClaudeAdapterV2.awaitClaudeApprovalDecision(
        decision,
        AbortSignal.abort(),
      );

      assert.deepEqual(result, { decision: "cancel" });
    }),
  );
});
