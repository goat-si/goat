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
import {
  CODEX_TEST_MODEL_SELECTION,
  makeCodexTestTurnInput,
  withReplayRequestId,
} from "./CodexAdapterV2.testkit.ts";
import * as Predicate from "effect/Predicate";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

it.effect.each([
  { reply: { result: {} }, label: "accepted" },
  { reply: { error: { code: -32601, message: "Method not found" } }, label: "unsupported" },
] as const)("steers after a $label live speed update", ({ reply, label }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const nativeThreadId = `tier-${label}`,
        nativeTurnId = `turn-${label}`;
      const nextTurn = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: `next-${label}`,
        prompt: "Next.",
      })
        .slice(5)
        .map((entry) => withReplayRequestId(entry, 6))
        .map((entry) =>
          entry.type === "expect_outbound" &&
          Predicate.isObject(entry.frame) &&
          Predicate.isObject(entry.frame.params)
            ? {
                ...entry,
                frame: { ...entry.frame, params: { ...entry.frame.params, serviceTier: "fast" } },
              }
            : entry,
        );
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: `tier-${label}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Work." }),
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "thread/settings/update",
                params: { threadId: nativeThreadId, serviceTier: "fast" },
              },
            },
            { type: "emit_inbound", frame: { id: 4, ...reply } },
            {
              type: "expect_outbound",
              frame: {
                id: 5,
                method: "turn/steer",
                params: {
                  threadId: nativeThreadId,
                  expectedTurnId: nativeTurnId,
                  input: [{ type: "text", text: "Hurry up." }],
                },
              },
            },
            { type: "emit_inbound", frame: { id: 5, result: { turnId: nativeTurnId } } },
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
            ...nextTurn,
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: `next-${label}`, status: "completed" }),
                },
              },
            },
          ],
        }),
      );
      const turnInput = makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make(`tier-${label}`),
        text: "Work.",
      });
      yield* harness.runtime.startTurn(turnInput);
      yield* harness.awaitUntil(
        () =>
          harness.events.some(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.nativeTurnRef?.nativeId === nativeTurnId,
          ),
        "native turn registered",
      );
      const providerTurnId = harness.events.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0];
      assert.isDefined(providerTurnId);
      if (providerTurnId === undefined) return;
      yield* harness.runtime.steerTurn({
        ...turnInput,
        providerTurnId,
        modelSelection: {
          ...CODEX_TEST_MODEL_SELECTION,
          options: [{ id: "serviceTier", value: "fast" }],
        },
        message: { ...turnInput.message, text: "Hurry up." },
      });
      yield* harness.firstTerminal;
      assert.equal(harness.terminalEvents()[0]?.status, "completed");
      yield* harness.runtime.startTurn({
        ...turnInput,
        providerTurnOrdinal: turnInput.providerTurnOrdinal + 1,
        modelSelection: {
          ...CODEX_TEST_MODEL_SELECTION,
          options: [{ id: "serviceTier", value: "fast" }],
        },
        message: { ...turnInput.message, text: "Next." },
      });
      yield* harness.awaitUntil(() => harness.terminalEvents().length === 2, "next turn completed");
      assert.equal(harness.terminalEvents()[1]?.status, "completed");
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
