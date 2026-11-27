import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as CodexReplay from "effect-codex-app-server/replay";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { CODEX_TEST_MODEL_SELECTION, CODEX_TEST_RUNTIME_POLICY } from "./CodexAdapterV2.testkit.ts";
import { makeCodexReplayTurn, makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);
const nativeThreadId = "goal-thread";
const codexGoal = (status: string, tokensUsed: number) => ({
  threadId: nativeThreadId,
  objective: "Ship the feature",
  status,
  tokenBudget: null,
  tokensUsed,
  timeUsedSeconds: 3,
  createdAt: 1782622440,
  updatedAt: 1782622450,
});
const notification = (
  label: string,
  method: string,
  params: unknown,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label,
  frame: { method, params },
});
const request = (id: number, method: string, params: unknown, result: unknown) =>
  [
    { type: "expect_outbound", label: method, frame: { id, method, params } },
    { type: "emit_inbound", label: method, frame: { id, result } },
  ] satisfies Array<CodexReplay.CodexAppServerReplayEntry>;
const sessionStart = codexReplayPreamble({
  nativeThreadId,
  nativeTurnId: "unused",
  prompt: "unused",
}).slice(0, 5);

it.effect.each(["decoded", "undecodable"] as const)(
  "pauses a goal turn Codex starts on a resumed thread whose response is %s",
  (resumeResponse) =>
    Effect.gen(function* () {
      const transcript = makeCodexReplayTranscript({
        scenario: "goal-turn-after-resume",
        entries: [
          ...sessionStart,
          ...request(
            3,
            "thread/resume",
            {
              threadId: nativeThreadId,
              excludeTurns: true,
              config: CodexAdapterV2.CODEX_THREAD_CONFIG,
            },
            resumeResponse === "decoded"
              ? { thread: { id: nativeThreadId, updatedAt: 1782622450 } }
              : { thread: { id: nativeThreadId } },
          ),
          notification("goal resumed", "thread/goal/updated", {
            threadId: nativeThreadId,
            turnId: null,
            goal: codexGoal("active", 10),
          }),
          notification("goal continuation", "turn/started", {
            threadId: nativeThreadId,
            turn: makeCodexReplayTurn({ id: "orphan-goal-turn", status: "inProgress" }),
          }),
          ...request(
            4,
            "thread/goal/set",
            { threadId: nativeThreadId, status: "paused" },
            { goal: codexGoal("paused", 10) },
          ),
          ...request(
            5,
            "turn/interrupt",
            { threadId: nativeThreadId, turnId: "orphan-goal-turn" },
            {},
          ),
          notification("interrupted", "turn/completed", {
            threadId: nativeThreadId,
            turn: makeCodexReplayTurn({ id: "orphan-goal-turn", status: "interrupted" }),
          }),
        ],
      });
      const requests: Array<[string, unknown]> = [];
      const interrupted = yield* Deferred.make<void>();
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method, params) =>
          Effect.sync(() => {
            requests.push([method, params]);
          }).pipe(
            Effect.andThen(
              method === "turn/interrupt" ? Deferred.succeed(interrupted, undefined) : Effect.void,
            ),
          ),
      );
      const resumed = yield* harness.runtime
        .resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isSuccess(resumed), resumeResponse === "decoded");
      yield* Deferred.await(interrupted);
      const goalStatuses = () =>
        harness.events.flatMap((event) =>
          event.type === "provider_thread.updated"
            ? [event.providerThread.goal?.status ?? null]
            : [],
        );
      yield* harness.awaitUntil(() => goalStatuses().length > 0, "goal update");
      assert.deepEqual(goalStatuses(), ["active"]);
      assert.deepEqual(requests.slice(-2), [
        ["thread/goal/set", { threadId: nativeThreadId, status: "paused" }],
        ["turn/interrupt", { threadId: nativeThreadId, turnId: "orphan-goal-turn" }],
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
);
