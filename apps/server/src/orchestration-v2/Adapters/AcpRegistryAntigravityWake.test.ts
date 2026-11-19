import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { makeProviderReplayGate } from "@goat/provider-testing/replayGate";
import {
  CLAUDE_ROOT_SESSION,
  claudeFrames,
  claudeMarker,
  openClaudeReplaySession,
} from "./AcpClaudeReplay.testkit.ts";
import { layerTest } from "./AcpRegistryAdapterV2.host.testkit.ts";

describe("AcpRegistry Antigravity wake", () => {
  it.effect.each([
    { commandPath: "/root/.local/bin/agy", offers: 1 },
    { commandPath: "C:\\tools\\agy.exe", offers: 1 },
    { commandPath: "/opt/bin/other-agent", offers: 0 },
  ])("continues late output only for agy ($commandPath)", ({ commandPath, offers }) =>
    Effect.gen(function* () {
      const gate = makeProviderReplayGate(["wake"]);
      const update = (sessionUpdate: Record<string, unknown>) =>
        claudeFrames.update(CLAUDE_ROOT_SESSION, sessionUpdate);
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
                agentInfo: { name: "Antigravity ACP Server", version: "1.5.9" },
                agentCapabilities: { loadSession: true },
                authMethods: [],
              },
            },
          },
          claudeFrames.open[2],
          claudeFrames.open[3],
          claudeFrames.prompt(1)[0],
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
              content: { type: "text", text: "Background work finished." },
            }),
            label: "wake",
          },
          // agy ends each reply with usage_update; this one ends before the continuation run starts.
          update({ sessionUpdate: "usage_update", used: 100, size: 1000 }),
          claudeMarker("late output received"),
        ],
        gate,
        true,
        { source: "local", commandPath, commandArgs: ["acp"] },
      );
      yield* session.runtime.startTurn(session.turnInput(1));
      assert.equal((yield* session.terminal).status, "completed");
      gate.release("wake");
      yield* session.throughMarker("late output received");
      assert.lengthOf(session.offers, offers, "late output must only wake agy");
      if (offers === 0) return;
      yield* session.offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* session.runtime.startTurn(session.turnInput(2, { continuation: true }));
      yield* TestClock.adjust("3 seconds");
      const continued = yield* session.until((event) => event.type === "turn.terminal");
      assert.include(JSON.stringify(continued), "Background work finished.");
      const terminal = continued.at(-1)!;
      if (terminal.type !== "turn.terminal") throw new Error("Missing continuation terminal");
      assert.equal(terminal.status, "completed");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["approval-required", "full-access"] as const)(
    "continues an agy permission request after the prompt settles (%s)",
    (runtimeMode) =>
      Effect.gen(function* () {
        const gate = makeProviderReplayGate(["wake", "reply"]);
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
                  agentInfo: { name: "Antigravity ACP Server", version: "1.5.9" },
                  agentCapabilities: { loadSession: true },
                  authMethods: [],
                },
              },
            },
            claudeFrames.open[2],
            claudeFrames.open[3],
            claudeFrames.prompt(1)[0],
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/prompt",
                result: { stopReason: "end_turn" },
              },
            },
            {
              type: "emit_inbound",
              label: "wake",
              frame: {
                kind: "request",
                method: "session/request_permission",
                params: {
                  sessionId: CLAUDE_ROOT_SESSION,
                  toolCall: {
                    toolCallId: "late-command",
                    title: "Run command",
                    kind: "execute",
                    status: "pending",
                  },
                  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
                },
              },
            },
            claudeMarker("late permission received"),
            {
              type: "expect_outbound",
              frame: {
                kind: "response",
                method: "session/request_permission",
                result: { outcome: { outcome: "selected", optionId: "allow" } },
              },
            },
            {
              ...claudeFrames.update(CLAUDE_ROOT_SESSION, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Command approved." },
              }),
              label: "reply",
            },
            claudeFrames.update(CLAUDE_ROOT_SESSION, {
              sessionUpdate: "usage_update",
              used: 100,
              size: 1000,
            }),
          ],
          gate,
          true,
          { source: "local", commandPath: "/root/.local/bin/agy", commandArgs: ["acp"] },
          undefined,
          runtimeMode,
        );
        yield* session.runtime.startTurn(session.turnInput(1));
        assert.equal((yield* session.terminal).status, "completed");
        gate.release("wake");
        yield* session.throughMarker("late permission received");
        assert.lengthOf(session.offers, 1, "a permission request must offer a continuation");
        yield* session.offers[0]!.dispatchIfCurrent!(Effect.void);
        yield* session.runtime.startTurn(session.turnInput(2, { continuation: true }));
        if (runtimeMode === "approval-required") {
          const events = yield* session.until(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          );
          const request = events.at(-1)!;
          if (request.type !== "runtime_request.updated") throw new Error("Missing approval");
          yield* TestClock.adjust("5 seconds");
          yield* session.runtime.respondToRuntimeRequest({
            requestId: request.runtimeRequest.id,
            decision: "accept",
          });
        }
        // The model can be silent longer than the finalize debounce before it goes on.
        yield* TestClock.adjust("10 seconds");
        gate.release("reply");
        const output = yield* session.until(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text === "Command approved.",
        );
        assert.isTrue(output.some((event) => event.type === "turn_item.updated"));
        assert.isFalse(output.some((event) => event.type === "turn.terminal"));
        yield* TestClock.adjust("3 seconds");
        assert.equal((yield* session.terminal).status, "completed");
      }).pipe(Effect.provide(layerTest)),
  );
});
