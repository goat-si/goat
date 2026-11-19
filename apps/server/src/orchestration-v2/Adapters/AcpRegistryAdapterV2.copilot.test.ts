import { claudeFrames, openClaudeReplaySession } from "./AcpClaudeReplay.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import { makeAcpRegistryAdapterV2 } from "@goat/provider-acp-registry/testing";
import {
  decodeAcpRegistryAdapterSettings,
  layerInjectedRuntimeCatalog,
  layerTest,
} from "./AcpRegistryAdapterV2.host.testkit.ts";

describe("AcpRegistryAdapterV2 Copilot", () => {
  // Copilot wakes its root agent when a background subagent finishes, after the run settled.
  it.effect("does not drop Copilot's root reply when a finished background agent wakes it", () =>
    Effect.gen(function* () {
      const sessionId = "copilot-session";
      const sessionEvent = (type: string) => ({
        type: "emit_inbound",
        frame: {
          kind: "notification",
          method: "github.com/copilot/sessionEvent",
          params: { sessionId, type, data: {} },
        },
      });
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
                agentInfo: { name: "Copilot", version: "1.0.112" },
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
          sessionEvent("assistant.turn_start"),
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Agents are still working." },
          }),
          sessionEvent("assistant.idle"),
          update({ sessionUpdate: "session_info_update", title: "after foreground idle" }),
          // The background agent finishes; Copilot reads it and starts a new root turn.
          sessionEvent("assistant.turn_start"),
          update({
            sessionUpdate: "tool_call",
            toolCallId: "read-agent-1",
            title: "read_agent",
            kind: "other",
            status: "completed",
            rawInput: { agent_id: "agent-1" },
          }),
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Agent 1 finished" },
          }),
          sessionEvent("assistant.idle"),
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "session/prompt",
              result: { stopReason: "end_turn" },
            },
          },
          update({ sessionUpdate: "session_info_update", title: "after wake idle" }),
        ],
        undefined,
        true,
        "github-copilot-cli",
      );
      yield* session.runtime.startTurn(session.turnInput(1));
      const foreground = yield* session.throughMarker("after foreground idle");
      assert.isDefined(foreground.find((event) => event.type === "turn.terminal"));
      const wake = yield* session.throughMarker("after wake idle");
      assert.isTrue(
        session.offers.length > 0 || JSON.stringify(wake).includes("Agent 1 finished"),
        "the woken root reply is shown or opens a continuation run",
      );
      yield* session.runtime.startTurn(session.turnInput(2, { continuation: true }));
      const continuation = yield* session.until((event) => event.type === "turn.terminal");
      assert.include(JSON.stringify(continuation), "Agent 1 finished");
      assert.include(JSON.stringify(continuation.at(-1)), '"status":"completed"');
    }).pipe(Effect.provide(layerTest)),
  );

  const wakeSessionId = "copilot-wake-regression";
  const wakeEvent = (type: string) => ({
    type: "emit_inbound",
    frame: {
      kind: "notification",
      method: "github.com/copilot/sessionEvent",
      params: { sessionId: wakeSessionId, type, data: {} },
    },
  });
  const wakeUpdate = (update: Record<string, unknown>) =>
    claudeFrames.update(wakeSessionId, update);
  const wakeText = (type: "agent_message_chunk" | "agent_thought_chunk", text: string) =>
    wakeUpdate({ sessionUpdate: type, content: { type: "text", text } });
  const wakeMarker = (title: string) => wakeUpdate({ sessionUpdate: "session_info_update", title });
  const wakePrompt = {
    type: "expect_outbound",
    frame: { kind: "request", method: "session/prompt", params: "<any>" },
  };
  const wakePromptFinished = {
    type: "emit_inbound",
    frame: { kind: "response", method: "session/prompt", result: { stopReason: "end_turn" } },
  };
  const openWakeReplay = (frames: ReadonlyArray<unknown>) =>
    openClaudeReplaySession(
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
              agentInfo: { name: "Copilot", version: "1.0.112" },
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
          frame: { kind: "response", method: "session/new", result: { sessionId: wakeSessionId } },
        },
        wakePrompt,
        wakeEvent("assistant.turn_start"),
        wakeText("agent_message_chunk", "Agents are still working."),
        wakeEvent("assistant.idle"),
        wakeMarker("foreground idle"),
        wakePromptFinished,
        ...frames,
      ],
      undefined,
      true,
      "github-copilot-cli",
    );

  it.effect("discards an unclaimed Copilot thought at idle below the wake buffer cap", () =>
    Effect.gen(function* () {
      const session = yield* openWakeReplay([
        wakeEvent("assistant.turn_start"),
        wakeText("agent_thought_chunk", "Unclaimed wake thought."),
        wakeEvent("assistant.idle"),
        wakeText("agent_message_chunk", "Late text from the original prompt."),
        wakeEvent("assistant.turn_start"),
        wakeText("agent_message_chunk", "Native wake answer."),
        wakeEvent("assistant.idle"),
        wakeMarker("wake idle"),
      ]);
      yield* session.runtime.startTurn(session.turnInput(1));
      yield* session.throughMarker("wake idle");
      assert.lengthOf(session.offers, 1);
      yield* session.runtime.startTurn(session.turnInput(2, { continuation: true }));
      const continuation = yield* session.until((event) => event.type === "turn.terminal");
      const replayed = JSON.stringify(continuation);
      assert.include(replayed, "Native wake answer.");
      assert.notInclude(replayed, "Unclaimed wake thought.");
      assert.notInclude(replayed, "Late text from the original prompt.");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("discards a prior unclaimed Copilot wake when a new ordinary prompt starts", () =>
    Effect.gen(function* () {
      const session = yield* openWakeReplay([
        wakeEvent("assistant.turn_start"),
        wakeText("agent_thought_chunk", "Thought before the ordinary prompt."),
        wakeMarker("before ordinary prompt"),
        wakePrompt,
        wakeEvent("assistant.turn_start"),
        wakeText("agent_message_chunk", "Ordinary prompt answer."),
        wakeEvent("assistant.idle"),
        wakePromptFinished,
        wakeText("agent_message_chunk", "Late text before the next wake."),
        wakeEvent("assistant.turn_start"),
        wakeText("agent_message_chunk", "Native wake answer."),
        wakeEvent("assistant.idle"),
        wakeMarker("wake idle"),
      ]);
      yield* session.runtime.startTurn(session.turnInput(1));
      yield* session.throughMarker("before ordinary prompt");
      assert.lengthOf(session.offers, 0);
      yield* session.runtime.startTurn(session.turnInput(2));
      const beforeWake = yield* session.throughMarker("wake idle");
      assert.include(JSON.stringify(beforeWake), "Ordinary prompt answer.");
      assert.lengthOf(session.offers, 1);
      yield* session.runtime.startTurn(session.turnInput(3, { continuation: true }));
      const continuation = yield* session.until((event) => event.type === "turn.terminal");
      const replayed = JSON.stringify(continuation);
      assert.include(replayed, "Native wake answer.");
      assert.notInclude(replayed, "Thought before the ordinary prompt.");
      assert.notInclude(replayed, "Late text before the next wake.");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("retains a queued Copilot answer through a full wake buffer before admission", () =>
    Effect.gen(function* () {
      const session = yield* openWakeReplay([
        wakeEvent("assistant.turn_start"),
        wakeText("agent_message_chunk", "Queued native answer."),
        wakeMarker("continuation requested before burst"),
        ...Array.from({ length: 300 }, (_, index) =>
          wakeText("agent_thought_chunk", `<queued-wake-thought-${index}>`),
        ),
        wakeEvent("assistant.idle"),
        wakeMarker("burst drained before admission"),
      ]);
      yield* session.runtime.startTurn(session.turnInput(1));
      yield* session.throughMarker("continuation requested before burst");
      assert.lengthOf(session.offers, 1);
      yield* session.throughMarker("burst drained before admission");
      assert.lengthOf(session.offers, 1);
      yield* session.runtime.startTurn(session.turnInput(2, { continuation: true }));
      const continuation = yield* session.until((event) => event.type === "turn.terminal");
      const replayed = JSON.stringify(continuation);
      assert.include(replayed, "Queued native answer.");
      assert.notInclude(replayed, "<queued-wake-thought-0>");
      assert.include(replayed, "<queued-wake-thought-299>");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("never steers Copilot by cancelling its prompt", () =>
    Effect.gen(function* () {
      const steering = Effect.fn("steering")(function* (config: Record<string, unknown>) {
        const instanceId = ProviderInstanceId.make("acp-registry-steering");
        const adapter = yield* makeAcpRegistryAdapterV2({
          selfInvocation: yield* resolveSelfInvocation(),
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings(config),
          environment: {},
        }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
        const { turns } = yield* adapter.getCapabilities();
        return {
          supportsInterrupt: turns.supportsInterrupt,
          supportsActiveSteering: turns.supportsActiveSteering,
          supportsSteeringByInterruptRestart: turns.supportsSteeringByInterruptRestart,
        };
      });
      const copilot = {
        supportsInterrupt: true,
        supportsActiveSteering: false,
        supportsSteeringByInterruptRestart: false,
      };

      assert.deepEqual(yield* steering({ agentId: "github-copilot-cli" }), copilot);
      assert.deepEqual(
        yield* steering({ source: "local", commandPath: "C:\\tools\\copilot.cmd" }),
        copilot,
      );
      assert.deepEqual(yield* steering({ agentId: "gemini" }), {
        ...copilot,
        supportsSteeringByInterruptRestart: true,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("settles Copilot's reply on assistant.idle while an async shell holds the prompt", () =>
    Effect.gen(function* () {
      const sessionId = "copilot-session";
      const sessionEvent = (type: string) => ({
        type: "emit_inbound",
        frame: {
          kind: "notification",
          method: "github.com/copilot/sessionEvent",
          params: { sessionId, type, data: {} },
        },
      });
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
                agentInfo: { name: "Copilot", version: "1.0.110" },
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
          // A previous prompt's idle can land before this prompt's turn starts.
          sessionEvent("assistant.idle"),
          update({ sessionUpdate: "session_info_update", title: "after stale idle" }),
          sessionEvent("assistant.turn_start"),
          update({
            sessionUpdate: "tool_call",
            toolCallId: "shell-1",
            title: "sleep 120",
            kind: "execute",
            status: "completed",
            rawInput: { command: "sleep 120", mode: "async", detach: false },
          }),
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }),
          sessionEvent("assistant.idle"),
          update({ sessionUpdate: "session_info_update", title: "after foreground idle" }),
          // The shell never exits, so the first session/prompt is never answered.
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "session/prompt", params: "<any>" },
          },
          sessionEvent("assistant.turn_start"),
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two" } }),
          sessionEvent("assistant.idle"),
          update({ sessionUpdate: "session_info_update", title: "after second idle" }),
        ],
        undefined,
        false,
        "github-copilot-cli",
      );
      yield* session.runtime.startTurn(session.turnInput(1));
      const stale = yield* session.throughMarker("after stale idle");
      assert.isFalse(stale.some((event) => event.type === "turn.terminal"));
      const foreground = yield* session.throughMarker("after foreground idle");
      const terminal = foreground.find((event) => event.type === "turn.terminal");
      assert.isDefined(terminal, "the run settles once Copilot's foreground work is idle");
      assert.equal(terminal?.type === "turn.terminal" ? terminal.status : null, "completed");
      yield* session.runtime.startTurn(session.turnInput(2));
      const second = yield* session.throughMarker("after second idle");
      const secondTerminal = second.find((event) => event.type === "turn.terminal");
      assert.equal(secondTerminal?.type === "turn.terminal" ? secondTerminal.runOrdinal : null, 2);
    }).pipe(Effect.provide(layerTest)),
  );
});
