import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Fixture from "../adapter.test.ts";
import { FAKE_SESSION_FILE } from "./fakePi.ts";

export function registerTokenUsageChecks({
  makeFakePi,
  openRuntime,
  startTurn,
  THREAD_ID,
  modelSelection,
  runtimePolicy,
  layerTest,
}: {
  makeFakePi: typeof import("./fakePi.ts").makeFakePi;
  openRuntime: typeof Fixture.openRuntime;
  startTurn: typeof Fixture.startTurn;
  THREAD_ID: typeof Fixture.THREAD_ID;
  modelSelection: typeof Fixture.modelSelection;
  runtimePolicy: typeof Fixture.runtimePolicy;
  layerTest: typeof Fixture.layerTest;
}) {
  it.effect("reports cached input as a share of input in live and completed token usage", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueState({
        sessionFile: FAKE_SESSION_FILE,
        model: { provider: "anthropic", id: "large", contextWindow: 1_000_000 },
      });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      // Pi's message usage counts uncached input, cache reads and cache writes separately.
      const usage = { input: 6, cacheRead: 40_101, cacheWrite: 10_561, output: 123 };
      // Session stats total every message in the session, not this turn.
      fake.queueStats({
        tokens: {
          input: 1_206,
          cacheRead: 90_202,
          cacheWrite: 60_622,
          output: 250,
          total: 152_280,
        },
        contextUsage: { tokens: 50_791, contextWindow: 1_000_000 },
      });
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        usage: { ...usage, totalTokens: 50_791 },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" },
      });
      const live = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.tokenUsage !== undefined,
      );
      assert.deepInclude(
        live.type === "provider_turn.updated" ? live.providerTurn.tokenUsage : undefined,
        { inputTokens: 50_668, cachedInputTokens: 40_101 },
      );
      yield* fake.emit({ type: "agent_settled" });
      const completed = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.deepInclude(
        completed.type === "provider_turn.updated" ? completed.providerTurn.tokenUsage : undefined,
        { inputTokens: 50_668, cachedInputTokens: 40_101 },
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
}
