import { assert, it } from "@effect/vitest";
import type { ProviderReplayEntry } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import {
  PROMPT_ID,
  SESSION,
  event,
  out,
  promptAccepted,
  reconnected,
  resumed,
  turnInput,
  turnItems,
} from "./OpenCode2AdapterV2.fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 adapter native todo", (it) => {
  it.effect("projects successful native todo updates into one checklist", () =>
    Effect.gen(function* () {
      const updates = [
        [
          { content: " Inspect code ", status: "completed" },
          { content: "Implement", status: "in_progress" },
          { content: "Verify", status: "pending" },
          { content: "Abandoned", status: "cancelled" },
        ],
        [{ content: "Inspect code", status: "completed" }],
        [{ content: "Abandoned", status: "cancelled" }],
        [],
        [{ content: "Follow up", status: "pending" }],
      ];
      const tool = (id: string) => ({
        sessionID: SESSION,
        assistantMessageID: "msg_assistant",
        id,
      });
      const call = (id: string, todos: unknown): ReadonlyArray<ProviderReplayEntry> => [
        event("session.tool.input.started", { ...tool(id), name: "todowrite" }),
        event("session.tool.called", { ...tool(id), input: { todos }, executed: false }),
      ];
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        ...call("call-denied", [{ content: "Not saved", status: "pending" }]),
        event(
          "session.tool.failed",
          {
            ...tool("call-denied"),
            error: { type: "unknown", message: "Unable to update todos" },
            executed: false,
          },
          undefined,
          2,
        ),
        ...call("call-malformed", [{ content: "Not saved", status: "pending" }]),
        event(
          "session.tool.success",
          {
            ...tool("call-malformed"),
            content: [{ type: "text", text: "Unrecognized todo result" }],
            metadata: { todos: [{ content: "Unknown", status: "new-status" }] },
            executed: false,
          },
          undefined,
          2,
        ),
        ...updates.flatMap((todos, index) => [
          ...call(`call-todo-${index}`, todos),
          event(
            "session.tool.success",
            {
              ...tool(`call-todo-${index}`),
              content: [{ type: "text", text: "Todos updated" }],
              metadata: { todos },
              executed: false,
            },
            undefined,
            2,
          ),
        ]),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const plans = collected.flatMap((event) =>
        event.type === "plan.updated" && event.plan.kind === "todo_list" ? [event.plan] : [],
      );
      assert.deepEqual(
        plans.map((plan) => plan.steps.map((step) => [step.text, step.status])),
        [
          [
            ["Inspect code", "completed"],
            ["Implement", "running"],
            ["Verify", "pending"],
          ],
          [["Inspect code", "completed"]],
          [],
          [],
          [["Follow up", "pending"]],
        ],
      );
      assert.equal(new Set(plans.map((plan) => plan.id)).size, 1);
      assert.equal(plans[0]?.steps[0]?.id, plans[1]?.steps[0]?.id);
      assert.deepEqual(
        plans.map((plan) => plan.status),
        ["active", "completed", "completed", "completed", "active"],
      );
      const items = collected.flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      const checklists = items.filter((item) => item.type === "todo_list");
      assert.equal(new Set(checklists.map((item) => item.id)).size, 1);
      assert.deepEqual(
        checklists.map((item) => item.steps),
        plans.map((plan) => plan.steps),
      );
      assert.deepEqual(
        checklists.map((item) => item.status),
        ["completed", "completed", "completed", "completed", "completed"],
      );
      assert.isFalse(
        items.some(
          (item) =>
            item.type === "dynamic_tool" && item.nativeItemRef?.nativeId?.startsWith("call-todo-"),
        ),
      );
      assert.deepInclude(
        items.find((item) => item.nativeItemRef?.nativeId === "call-denied"),
        { type: "dynamic_tool", status: "failed" },
      );
      assert.deepInclude(
        items.find((item) => item.nativeItemRef?.nativeId === "call-malformed"),
        { type: "dynamic_tool", status: "completed" },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("recovers native todo updates missed during reconnect", () =>
    Effect.gen(function* () {
      const todos = [{ content: "Saved during disconnect", status: "in_progress" }];
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
        promptAccepted,
        ...reconnected({}, "succeeded", {
          content: [
            {
              type: "tool",
              id: "call-todo-gap",
              name: "todowrite",
              executed: false,
              state: {
                status: "completed",
                input: { todos },
                content: [{ type: "text", text: "Todos updated" }],
                metadata: { todos },
              },
              time: { created: 2, ran: 2, completed: 2 },
            },
          ],
        }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const plans = collected.flatMap((event) =>
        event.type === "plan.updated" && event.plan.kind === "todo_list" ? [event.plan] : [],
      );
      assert.equal(plans.length, 1);
      assert.deepEqual(
        plans[0]?.steps.map((step) => [step.text, step.status]),
        [["Saved during disconnect", "running"]],
      );
      assert.include(turnItems(collected), "todo_list:completed");
    }).pipe(Effect.scoped),
  );
});
