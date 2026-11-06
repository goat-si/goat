import type { ProviderApprovalDecision } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { CLAUDE_TEST_MODEL_SELECTION } from "./ClaudeTestInput.testkit.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

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
