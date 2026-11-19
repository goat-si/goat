import { EnvironmentId, ProviderInstanceId, RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import { claudeSdkFrame, WAKE_NATIVE_SESSION } from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

vi.mock("effect/Queue", async (importOriginal) => {
  const actual = await importOriginal<typeof Queue>();
  return {
    ...actual,
    take: <A, E>(queue: Queue.Dequeue<A, E>) =>
      Effect.gen(function* () {
        const capture = yield* CaptureEventQueue;
        if (capture !== undefined && actual.isEnqueue<unknown, never>(queue))
          yield* capture((marker) => actual.offer(queue, marker));
        return yield* actual.take(queue);
      }),
  };
});

it.effect("defers an active goal only while delegated work can wake it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("environment-goal-wake"),
        threadId: harness.threadId,
        providerSessionId: "mcp-session-goal-wake",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer test-secret",
        browserToolsAvailable: true,
        hasPendingWake: Effect.succeed(true),
      });
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("goal-wake-attempt"),
          text: "/goal Finish review",
          attachments: [],
        }),
      );
      const stop = Effect.promise(() =>
        Promise.all(
          (harness.getOpenedOptions()?.hooks?.Stop ?? []).flatMap((matcher) =>
            matcher.hooks.map((hook) =>
              hook(
                {
                  hook_event_name: "Stop",
                  stop_hook_active: true,
                  session_id: WAKE_NATIVE_SESSION,
                  transcript_path: "/transcript.jsonl",
                  cwd: "/workspace",
                },
                undefined,
                { signal: new AbortController().signal },
              ),
            ),
          ),
        ),
      );
      assert.deepEqual(yield* stop, [{}]);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "assistant",
          message: {
            model: "<synthetic>",
            id: "goal-set",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Goal set: Finish review" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          uuid: "goal-set",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      assert.deepEqual(yield* stop, [{ continue: false }]);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
