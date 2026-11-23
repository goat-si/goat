import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";

it.effect("updates a live Codex thread's native name when its GOAT title changes", () =>
  Effect.gen(function* () {
    const threadId = "name-thread";
    const requests: unknown[] = [];
    const harness = yield* makeCodexReplayHarness(
      makeCodexReplayTranscript({
        scenario: "thread-name",
        entries: [
          ...codexReplayPreamble({
            nativeThreadId: threadId,
            nativeTurnId: "unused",
            prompt: "unused",
          }).slice(0, 5),
          {
            type: "expect_outbound",
            frame: { id: 3, method: "thread/name/set", params: { threadId, name: "Renamed" } },
          },
          {
            type: "emit_inbound",
            frame: { id: 3, error: { code: -32601, message: "Method not found" } },
          },
          {
            type: "expect_outbound",
            frame: { id: 4, method: "thread/name/set", params: { threadId, name: "Renamed" } },
          },
          { type: "emit_inbound", frame: { id: 4, result: {} } },
        ],
      }),
      undefined,
      (method, params) =>
        Effect.sync(() => {
          if (method === "thread/name/set") requests.push(params);
        }),
    );
    const apply = harness.runtime.applyThreadTitle;
    assert.isDefined(apply);
    if (apply === undefined) return;
    yield* apply({ providerThread: harness.providerThread, title: "Renamed" });
    yield* apply({ providerThread: harness.providerThread, title: "Renamed" });
    yield* apply({ providerThread: harness.providerThread, title: "Renamed" });
    assert.deepEqual(requests, [
      { threadId, name: "Renamed" },
      { threadId, name: "Renamed" },
    ]);
  }).pipe(
    Effect.scoped,
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
