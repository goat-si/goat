import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

it.effect.each([
  { outcome: "completed", item: "cancelled" },
  { outcome: "failed", item: "failed" },
  { outcome: "interrupted", item: "interrupted" },
] as const)("settles unfinished searches on $outcome", ({ outcome, item }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const nativeThreadId = `search-${outcome}`,
        nativeTurnId = `turn-${outcome}`;
      const search = { type: "webSearch", id: "search-open", query: "GOAT", action: null };
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: `search-${outcome}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Search." }),
            {
              type: "emit_inbound",
              frame: {
                method: "item/started",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { ...search, id: "search-done" },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { ...search, id: "search-done" },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "item/started",
                params: { threadId: nativeThreadId, turnId: nativeTurnId, item: search },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: {
                    ...makeCodexReplayTurn({ id: nativeTurnId, status: outcome }),
                    ...(outcome === "failed"
                      ? { error: { message: "failed", codexErrorInfo: "other" } }
                      : {}),
                  },
                },
              },
            },
          ],
        }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`search-${outcome}`),
          text: "Search.",
        }),
      );
      yield* harness.firstTerminal;
      const statuses = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "web_search" &&
        event.turnItem.nativeItemRef?.nativeId === "search-open"
          ? [event.turnItem.status]
          : [],
      );
      assert.deepEqual(statuses, ["running", item]);
      assert.deepEqual(
        harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "web_search" &&
          event.turnItem.nativeItemRef?.nativeId === "search-done"
            ? [event.turnItem.status]
            : [],
        ),
        ["running", "completed"],
      );
    }),
  ).pipe(
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
