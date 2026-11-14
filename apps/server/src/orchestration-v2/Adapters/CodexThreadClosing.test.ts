import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";
import { CODEX_TEST_MODEL_SELECTION, CODEX_TEST_RUNTIME_POLICY } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";

// regression: #33747 Codex refuses thread/resume until an unsubscribed thread finishes closing
it.effect.each([
  { name: "waits for thread/closed after a closing error", closedFirst: false },
  { name: "retries at once when the thread already closed", closedFirst: true },
])("$name", ({ closedFirst }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const nativeThreadId = "closing-thread";
      const params = {
        threadId: nativeThreadId,
        excludeTurns: true,
        cwd: CODEX_TEST_RUNTIME_POLICY.cwd,
        model: CODEX_TEST_MODEL_SELECTION.model,
        config: CodexAdapterV2.CODEX_THREAD_CONFIG,
      };
      const closed: CodexReplay.CodexAppServerReplayEntry = {
        type: "emit_inbound",
        label: "thread closed",
        frame: { method: "thread/closed", params: { threadId: nativeThreadId } },
      };
      const closingError: CodexReplay.CodexAppServerReplayEntry = {
        type: "emit_inbound",
        label: "resume closing error",
        frame: {
          id: 4,
          error: {
            code: -32600,
            message: `thread ${nativeThreadId} is closing; retry thread/resume after the thread is closed`,
          },
        },
      };
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: closedFirst ? "closed-first" : "closed-later",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId: "unused-turn",
              prompt: "unused-prompt",
            }).slice(0, 5),
            {
              type: "expect_outbound",
              label: "unsubscribe",
              frame: {
                id: 3,
                method: "thread/unsubscribe",
                params: { threadId: nativeThreadId },
              },
            },
            {
              type: "emit_inbound",
              label: "unsubscribe result",
              frame: { id: 3, result: { status: "unsubscribed" } },
            },
            {
              type: "expect_outbound",
              label: "resume closing thread",
              frame: { id: 4, method: "thread/resume", params },
            },
            ...(closedFirst ? [closed, closingError] : [closingError, closed]),
            {
              type: "expect_outbound",
              label: "retry identical resume",
              frame: { id: 5, method: "thread/resume", params },
            },
            {
              type: "emit_inbound",
              label: "retry result",
              frame: {
                id: 5,
                result: {
                  thread: {
                    id: nativeThreadId,
                    updatedAt: 1782622450,
                    turns: [{ type: "unknown-history-item" }],
                  },
                },
              },
            },
          ],
        }),
      );
      yield* harness.runtime.unloadThread!({ providerThread: harness.providerThread });
      const resumed = yield* harness.runtime.resumeThread({
        providerThread: harness.providerThread,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
      assert.equal(resumed.status, "idle");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          MemoryDerivedCache.layer,
        ),
      ),
    ),
  ),
);

it.effect("surfaces an older server's unsupported resume error without retrying", () =>
  Effect.gen(function* () {
    const nativeThreadId = "older-codex-thread";
    const params = {
      threadId: nativeThreadId,
      excludeTurns: true,
      cwd: CODEX_TEST_RUNTIME_POLICY.cwd,
      model: CODEX_TEST_MODEL_SELECTION.model,
      config: CodexAdapterV2.CODEX_THREAD_CONFIG,
    };
    const harness = yield* makeCodexReplayHarness(
      makeCodexReplayTranscript({
        scenario: "older-server-unsupported",
        entries: [
          ...codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "unused-turn",
            prompt: "unused-prompt",
          }).slice(0, 5),
          {
            type: "expect_outbound",
            frame: { id: 3, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
          },
          { type: "emit_inbound", frame: { id: 3, result: { status: "unsubscribed" } } },
          { type: "expect_outbound", frame: { id: 4, method: "thread/resume", params } },
          {
            type: "emit_inbound",
            frame: { id: 4, error: { code: -32601, message: "Method not found" } },
          },
        ],
      }),
    );
    yield* harness.runtime.unloadThread!({ providerThread: harness.providerThread });
    const result = yield* Effect.exit(
      harness.runtime.resumeThread({
        providerThread: harness.providerThread,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      }),
    );
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result)) assert.include(Cause.pretty(result.cause), "Method not found");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        MemoryDerivedCache.layer,
      ),
    ),
  ),
);
