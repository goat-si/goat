import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import {
  SESSION,
  event,
  out,
  promptAccepted,
  resumed,
  turnInput,
} from "./OpenCode2AdapterV2.fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode 2 shell exit", (it) => {
  it.effect("stores a shell command that exits non-zero as failed", () =>
    Effect.gen(function* () {
      const tool = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-exit" };
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.tool.input.started", { ...tool, name: "shell" }),
        event("session.tool.called", { ...tool, input: { command: "vp test" }, executed: false }),
        {
          type: "emit_inbound",
          frame: {
            type: "sdk.event",
            event: {
              id: "evt_toolsuccess_call-exit",
              created: 1,
              type: "session.tool.success",
              data: {
                ...tool,
                content: [{ type: "text", text: "1 failed\n" }],
                metadata: { status: "completed", truncated: false, exit: 1 },
                executed: false,
              },
              durable: { aggregateID: SESSION, seq: 1, version: 2 },
            },
          },
        },
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const item = collected
        .flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []))
        .findLast((item) => item.nativeItemRef?.nativeId?.endsWith(tool.id));
      assert.equal(item?.type, "command_execution");
      assert.equal(item?.status, "failed");
      assert.equal(item?.type === "command_execution" ? item.exitCode : null, 1);
      assert.equal(
        collected
          .flatMap((event) => (event.type === "node.updated" ? [event.node] : []))
          .findLast((node) => node.id === item?.nodeId)?.status,
        "failed",
      );
    }).pipe(Effect.scoped),
  );
});
