import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  CLAUDE_ROOT_SESSION,
  claudeFrames,
  claudeMarker,
  openClaudeReplaySession,
} from "./AcpClaudeReplay.testkit.ts";
import { layerTest } from "./AcpRegistryAdapterV2.host.testkit.ts";

describe("ACP registry local command flavors", () => {
  it.effect("counts per-turn usage for a local glm command", () =>
    Effect.gen(function* () {
      const session = yield* openClaudeReplaySession(
        [
          // GLM reports per-turn usage on the v1 prompt response.
          ...claudeFrames.open.map((entry) =>
            entry.frame.method === "initialize" && entry.type === "emit_inbound"
              ? {
                  ...entry,
                  frame: {
                    ...entry.frame,
                    result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
                  },
                }
              : entry,
          ),
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "session/prompt", params: "<any>" },
          },
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "session/prompt",
              result: {
                stopReason: "end_turn",
                usage: { totalTokens: 3_000, inputTokens: 2_500, outputTokens: 500 },
              },
            },
          },
          claudeFrames.closeRequest,
          claudeFrames.closed,
        ],
        undefined,
        false,
        { source: "local", commandPath: "/opt/glm/bin/glm" },
      );
      yield* session.runtime.startTurn(session.turnInput(1)).pipe(Effect.forkScoped);
      const events = yield* session.until((event) => event.type === "turn.terminal");
      const completed = events.findLast(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.deepEqual(
        completed?.type === "provider_turn.updated" ? completed.providerTurn.turnTokenUsage : null,
        {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 2_500,
          outputTokens: 500,
        },
      );
      const terminal = events.at(-1)!;
      if (terminal.type !== "turn.terminal") throw new Error("Missing terminal");
      assert.equal(terminal.status, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("surfaces Mistral's retry notice for a local vibe command", () =>
    Effect.gen(function* () {
      const session = yield* openClaudeReplaySession(
        [
          ...claudeFrames.open,
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "session/prompt", params: "<any>" },
          },
          claudeFrames.update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "user_message",
            messageId: "user-1",
            content: [{ type: "text", text: "test prompt" }],
          }),
          claudeFrames.update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "state_update",
            state: "running",
          }),
          {
            type: "emit_inbound",
            frame: {
              kind: "notification",
              method: "_session/retrying",
              params: {
                sessionId: CLAUDE_ROOT_SESSION,
                category: "rate_limited",
                detail: "Backing off for 30s",
              },
            },
          },
          claudeMarker("retry noticed"),
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "session/prompt",
              result: { stopReason: "end_turn" },
            },
          },
          claudeFrames.idle("end_turn"),
          claudeFrames.closeRequest,
          claudeFrames.closed,
        ],
        undefined,
        false,
        { source: "local", commandPath: "/opt/vibe/bin/vibe-acp" },
      );
      yield* session.runtime.startTurn(session.turnInput(1));
      const events = yield* session.throughMarker("retry noticed");
      const retry = events.find(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      if (retry?.type !== "turn_item.updated" || retry.turnItem.type !== "error")
        throw new Error("Missing provider retry item");
      assert.equal(retry.turnItem.title, "Provider retry");
      assert.equal(retry.turnItem.failure.class, "usage_limit");
      assert.equal(retry.turnItem.retry?.attempt, 1);
      const terminal = yield* session.terminal;
      assert.equal(terminal.status, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
