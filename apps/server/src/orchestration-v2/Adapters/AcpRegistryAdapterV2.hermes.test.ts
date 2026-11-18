import { claudeFrames, openClaudeReplaySession } from "./AcpClaudeReplay.testkit.ts";
import { layerTest } from "./AcpRegistryAdapterV2.host.testkit.ts";
import { makeProviderReplayGate } from "@goat/provider-testing/replayGate";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

// regression: #38599 Hermes replies on its own when a background process it started exits
it.effect("does not drop Hermes' reply after a background process finishes", () =>
  Effect.gen(function* () {
    const gate = makeProviderReplayGate(["process-exit"]);
    const sessionId = "hermes-session";
    const update = (sessionUpdate: Record<string, unknown>) =>
      claudeFrames.update(sessionId, sessionUpdate);
    const session = yield* openClaudeReplaySession(
      [
        {
          type: "expect_outbound",
          frame: { kind: "request", method: "initialize", params: "<any>" },
        },
        {
          type: "emit_inbound",
          frame: {
            kind: "response",
            method: "initialize",
            result: {
              protocolVersion: 1,
              agentInfo: { name: "hermes-agent", version: "0.23.1" },
              agentCapabilities: { loadSession: true },
              authMethods: [],
            },
          },
        },
        {
          type: "expect_outbound",
          frame: { kind: "request", method: "session/new", params: "<any>" },
        },
        {
          type: "emit_inbound",
          frame: { kind: "response", method: "session/new", result: { sessionId } },
        },
        {
          type: "expect_outbound",
          frame: { kind: "request", method: "session/prompt", params: "<any>" },
        },
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Started it in the background." },
        }),
        {
          type: "emit_inbound",
          frame: {
            kind: "response",
            method: "session/prompt",
            result: { stopReason: "end_turn" },
          },
        },
        {
          ...update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "The background command printed DONE" },
          }),
          label: "process-exit",
        },
        update({ sessionUpdate: "session_info_update", title: "after completion reply" }),
      ],
      gate,
      true,
      { source: "local", commandPath: "hermes", commandArgs: ["acp"] },
    );
    yield* session.runtime.startTurn(session.turnInput(1));
    const foreground = yield* session.until((event) => event.type === "turn.terminal");
    assert.include(JSON.stringify(foreground.at(-1)), '"status":"completed"');
    gate.release("process-exit");
    yield* Queue.take(session.offered);
    yield* session.throughMarker("after completion reply");
    yield* session.offers[0]!.dispatchIfCurrent!(Effect.void);
    yield* session.runtime.startTurn(session.turnInput(2, { continuation: true }));
    yield* TestClock.adjust("10 seconds");
    const continuation = yield* session.until((event) => event.type === "turn.terminal");
    assert.include(JSON.stringify(continuation), "printed DONE");
    assert.include(JSON.stringify(continuation.at(-1)), '"status":"completed"');
  }).pipe(Effect.provide(layerTest)),
);
