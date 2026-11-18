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
