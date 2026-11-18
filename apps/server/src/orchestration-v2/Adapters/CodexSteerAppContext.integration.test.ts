import { assert, it } from "@effect/vitest";
import { RunAttemptId } from "@goat/contracts";
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
import { makeCodexReplayTurn, makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";
// regression: #38541 an MCP app note that changes mid-turn reaches the next steer, once.
it.effect("steers carry MCP app notes Codex has not been sent", () =>
  Effect.gen(function* () {
    const nativeThreadId = "steer-app-context-thread";
    const nativeTurnId = "steer-app-context-turn";
    const note = "<external_mcp_app_item-1>Pressed: blue</external_mcp_app_item-1>";
    const steerFrame = (id: number, input: ReadonlyArray<string>) =>
      [
        {
          type: "expect_outbound",
          label: "turn/steer",
          frame: {
            id,
            method: "turn/steer",
            params: {
              threadId: nativeThreadId,
              expectedTurnId: nativeTurnId,
              input: input.map((text) => ({ type: "text", text })),
            },
          },
        },
        { type: "emit_inbound", frame: { id, result: { turnId: nativeTurnId } } },
      ] as const;
    const harness = yield* makeCodexReplayHarness(
      makeCodexReplayTranscript({
        scenario: "steer-app-context",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Work." }),
          ...steerFrame(4, [note, "What did the app report?"]),
          ...steerFrame(5, ["And now?"]),
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
        ],
      }),
    );
    const turnInput = makeCodexTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("steer-app-context-attempt"),
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
      "native turn",
    );
    const providerTurnId = harness.events.flatMap((event) =>
      event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
    )[0];
    assert.isDefined(providerTurnId);
    if (providerTurnId === undefined) return;
    const appContext = [{ key: "mcp_app_item-1", text: "Pressed: blue" }];
    yield* harness.runtime.steerTurn({
      ...turnInput,
      providerTurnId,
      appContext,
      message: { ...turnInput.message, text: "What did the app report?" },
    });
    yield* harness.runtime.steerTurn({
      ...turnInput,
      providerTurnId,
      appContext,
      message: { ...turnInput.message, text: "And now?" },
    });
    yield* harness.firstTerminal;
    assert.equal(harness.terminalEvents()[0]?.status, "completed");
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
