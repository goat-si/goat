import { claudeFrames, openClaudeReplaySession } from "./AcpClaudeReplay.testkit.ts";
import { layerTest } from "./AcpRegistryAdapterV2.host.testkit.ts";
import { makeProviderReplayGate } from "@goat/provider-testing/replayGate";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

// regression: #38599 Hermes replies on its own when a background process it started exits
it.effect.each([
  { commandPath: "hermes", commandArgs: ["acp"] },
  { commandPath: "node", commandArgs: ["hermes-acp.mjs"] },
])("does not drop Hermes background replies ($commandPath)", (launch) =>
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
      { source: "local", commandPath: launch.commandPath, commandArgs: launch.commandArgs },
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

it.effect("protects Hermes background work when a wrapper launches it on replacement", () =>
  Effect.gen(function* () {
    const gate = makeProviderReplayGate(["process-exit"]);
    const request = (method: string) => ({
      type: "expect_outbound",
      frame: { kind: "request", method, params: "<any>" },
    });
    const respond = (method: string, result: object) => ({
      type: "emit_inbound",
      frame: { kind: "response", method, result },
    });
    const open = (sessionId: string, name: string) => [
      request("initialize"),
      respond("initialize", { protocolVersion: 1, agentInfo: { name, version: "1.0.0" } }),
      request("session/new"),
      respond("session/new", { sessionId }),
    ];
    const sessionId = "hermes-replacement";
    const session = yield* openClaudeReplaySession(
      open("initial-session", "generic-agent"),
      gate,
      true,
      { source: "local", commandPath: "node", commandArgs: ["agent-wrapper.mjs"] },
      [
        ...open(sessionId, "hermes-agent"),
        request("session/prompt"),
        respond("session/prompt", { stopReason: "end_turn" }),
        {
          ...claudeFrames.update(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Background command finished" },
          }),
          label: "process-exit",
        },
      ],
    );
    const { threadId, modelSelection, runtimePolicy } = session.turnInput(1);
    const replaceThread = {
      threadId,
      modelSelection,
      runtimePolicy,
      forceNewNativeThread: true,
    };
    const pendingWork = session.runtime.hasPendingBackgroundWork ?? Effect.succeed(false);
    assert.isFalse(yield* pendingWork);
    const providerThread = yield* session.runtime.ensureThread(replaceThread);
    yield* session.runtime.startTurn({ ...session.turnInput(1), providerThread });
    assert.equal((yield* session.terminal).status, "completed");

    gate.release("process-exit");
    yield* Queue.take(session.offered);
    assert.isTrue(yield* pendingWork);
    const error = yield* session.runtime.ensureThread(replaceThread).pipe(Effect.flip);
    assert.include(String(error.cause), "background work is active");
  }).pipe(Effect.provide(layerTest)),
);
