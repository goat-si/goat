import {
  CLAUDE_ROOT_SESSION,
  claudeFrames,
  openClaudeReplaySession,
  claudeMarker,
  claudeChild,
} from "./AcpClaudeReplay.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as ServerSettings from "../../serverSettings.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";

const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

const layerRegistry = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "fixture-agent",
              name: "Fixture Agent",
              version: "1.0.0",
              description: "ACP V2 adapter fixture",
              distribution: {
                binary: {
                  "darwin-aarch64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                  "linux-x86_64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                },
              },
            },
          ],
        }),
      ),
    ),
  ),
);

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
  layerRegistry,
  ServerSettings.layerTest(),
);

describe("AcpRegistryAdapterV2SubagentTools", () => {
  it.effect("retains streamed child tool output through the generic Devin route", () =>
    Effect.gen(function* () {
      const { update } = claudeFrames;
      const session = yield* openClaudeReplaySession(
        [
          ...claudeFrames.open,
          ...claudeFrames.prompt(1),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "early-tool",
            status: "in_progress",
            rawInput: { command: "echo early" },
          }),
          update("child-1", {
            sessionUpdate: "tool_call_content_chunk",
            toolCallId: "early-tool",
            content: { type: "content", content: { type: "text", text: "early" } },
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "early-tool",
            status: "completed",
          }),
          update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "tool_call_update",
            toolCallId: "spawn",
            status: "in_progress",
            _meta: { "cognition.ai/subagent_started": { agentId: "child-1", task: "Review" } },
          }),
          ...[CLAUDE_ROOT_SESSION, "child-1"].map((sessionId) =>
            update(sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId: "shared-tool",
              title: "Read package",
              kind: "execute",
              status: "in_progress",
              rawInput: { command: "cat package.json" },
              ...(sessionId === "child-1"
                ? { content: [{ type: "content", content: { type: "text", text: "one" } }] }
                : {}),
            }),
          ),
          update("child-1", {
            sessionUpdate: "tool_call_content_chunk",
            toolCallId: "shared-tool",
            content: { type: "content", content: { type: "text", text: "two" } },
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            status: "completed",
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            content: [{ type: "content", content: { type: "text", text: "replacement" } }],
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            content: [],
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            rawOutput: { stdout: "structured", stderr: "" },
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            content: [{ type: "content", content: { type: "text", text: "display" } }],
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            rawOutput: { type: "Text", text: "vendor" },
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            content: [{ type: "content", content: { type: "text", text: "display" } }],
          }),
          claudeMarker("tools complete"),
          claudeFrames.idle("end_turn"),
          claudeFrames.closeRequest,
          claudeFrames.closed,
        ],
        undefined,
        false,
        "devin",
      );
      yield* session.runtime.startTurn(session.turnInput(1));
      const events = yield* session.throughMarker("tools complete");
      const child = events.find((event) => event.type === "subagent.updated");
      if (child?.type !== "subagent.updated") throw new Error("Missing child");
      const tools = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem]
          : [],
      );
      const childTools = tools.filter((item) => item.threadId === child.subagent.childThreadId);
      assert.deepEqual(
        childTools.map((item) => item.output),
        [
          [{ type: "content", content: { type: "text", text: "one" } }],
          [{ type: "content", content: { type: "text", text: "onetwo" } }],
          [{ type: "content", content: { type: "text", text: "onetwo" } }],
          [{ type: "content", content: { type: "text", text: "replacement" } }],
          [],
          { stdout: "structured", stderr: "" },
          { stdout: "structured", stderr: "" },
          { type: "Text", text: "vendor" },
          { type: "Text", text: "vendor" },
        ],
      );
      assert.equal(new Set(childTools.map((item) => item.id)).size, 1);
      assert.equal(childTools.at(-1)?.nativeItemRef?.nativeId, "child-1:tool:shared-tool");
      assert.equal(childTools.at(-1)?.status, "completed");
      assert.deepEqual(childTools.at(-1)?.input, { command: "cat package.json" });
      const parentTools = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "command_execution" &&
        event.turnItem.threadId === session.turnInput(1).threadId &&
        event.turnItem.nativeItemRef?.nativeId === "shared-tool"
          ? [event.turnItem]
          : [],
      );
      assert.lengthOf(parentTools, 1);
      assert.isUndefined(parentTools[0]?.output);
      assert.isFalse(
        events.some(
          (event) => event.type === "message.updated" && event.message.text.includes("onetwo"),
        ),
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps stopped child tools interrupted when a late output chunk arrives", () =>
    Effect.gen(function* () {
      const { update } = claudeFrames;
      const session = yield* openClaudeReplaySession(
        [
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
          update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "tool_call_update",
            toolCallId: "spawn",
            status: "in_progress",
            _meta: { "cognition.ai/subagent_started": { agentId: "child-1", task: "Review" } },
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "stopped-tool",
            status: "in_progress",
          }),
          claudeMarker("before cancel"),
          {
            type: "expect_outbound",
            frame: {
              kind: "notification",
              method: "session/cancel",
              params: { sessionId: CLAUDE_ROOT_SESSION },
            },
          },
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "stopped-tool",
            status: "failed",
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "stopped-tool",
            content: [{ type: "content", content: { type: "text", text: "stopping" } }],
          }),
          update("child-1", {
            sessionUpdate: "tool_call_content_chunk",
            toolCallId: "stopped-tool",
            content: { type: "content", content: { type: "text", text: "cancelled" } },
          }),
          claudeMarker("late output"),
          update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "tool_call_update",
            toolCallId: "spawn",
            status: "failed",
            _meta: { "cognition.ai/subagent_completed": { agentId: "child-1", success: false } },
          }),
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "session/prompt",
              result: { stopReason: "cancelled" },
            },
          },
          claudeFrames.closeRequest,
          claudeFrames.closed,
        ],
        undefined,
        false,
        "devin",
      );
      const starting = yield* session.runtime
        .startTurn(session.turnInput(1))
        .pipe(Effect.forkScoped);
      const started = yield* session.throughMarker("before cancel");
      const running = started.findLast((event) => event.type === "provider_turn.updated");
      if (running?.type !== "provider_turn.updated") throw new Error("Missing active turn");
      const closing = yield* session.runtime
        .interruptTurn({
          providerThread: session.providerThread,
          providerTurnId: running.providerTurn.id,
        })
        .pipe(Effect.forkScoped);
      const events = yield* session.throughMarker("late output");
      yield* Fiber.join(closing);
      yield* Fiber.join(starting);
      const tools = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        tools.map((item) => item.status),
        ["interrupted", "interrupted", "interrupted"],
      );
      assert.deepEqual(tools.at(-1)?.output, [
        { type: "content", content: { type: "text", text: "stoppingcancelled" } },
      ]);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps native child tools interrupted after idle and late output", () =>
    Effect.gen(function* () {
      const { update, childState } = claudeFrames;
      const session = yield* openClaudeReplaySession([
        ...claudeFrames.open,
        ...claudeFrames.prompt(1),
        ...claudeChild.slice(0, -1),
        update("child-1", {
          sessionUpdate: "tool_call_update",
          toolCallId: "unfinished",
          status: "in_progress",
        }),
        childState(CLAUDE_ROOT_SESSION, "child-1", "idle"),
        update("child-1", {
          sessionUpdate: "tool_call_content_chunk",
          toolCallId: "unfinished",
          content: { type: "content", content: { type: "text", text: "late" } },
        }),
        claudeMarker("late native output"),
        claudeFrames.idle("end_turn"),
        claudeFrames.closeRequest,
        claudeFrames.closed,
      ]);
      yield* session.runtime.startTurn(session.turnInput(1));
      const events = yield* session.throughMarker("late native output");
      const tools = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        tools.map((tool) => tool.status),
        ["running", "interrupted", "interrupted"],
      );
      assert.deepEqual(tools.at(-1)?.output, [
        { type: "content", content: { type: "text", text: "late" } },
      ]);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
