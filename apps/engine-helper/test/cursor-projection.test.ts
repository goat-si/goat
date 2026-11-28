import { test } from "node:test";
import assert from "node:assert/strict";
import type { InteractionUpdate } from "@cursor/sdk";
import type { EngineEvent } from "../src/protocol.ts";
import { CursorProjection } from "../src/engines/cursor/projection.ts";

function setup() {
  const events: EngineEvent[] = [];
  const projection = new CursorProjection("turn", "session", "instance", {
    emit: event => events.push(event), now: () => "2026-01-01T00:00:00Z", log: () => {}, fail: () => {},
  });
  const update = (type: string, callId: string, toolCall: unknown) =>
    projection.update({ type, callId, toolCall, modelCallId: "model" } as InteractionUpdate);
  return { events, projection, update, items: () => events.flatMap(e => e.type === "item_completed" ? [e.item] : []) };
}

test("projects shell, edit and dynamic results without inventing missing fields", () => {
  const { update, items } = setup();
  update("tool-call-completed", "shell", { type: "shell", args: { command: "cmd" }, result: { status: "success", value: { stdout: "out", stderr: "err", exitCode: 2 } } });
  update("tool-call-completed", "edit", { type: "edit", args: { path: "a" }, result: { status: "success", value: { diffString: "diff", linesAdded: 2, linesRemoved: 1 } } });
  update("tool-call-completed", "mcp", { type: "mcp", args: { providerIdentifier: "server", toolName: "tool", args: {} }, result: { status: "success", value: { content: [{ text: { text: "bad" } }], isError: true } } });
  update("tool-call-completed", "missing", { type: "edit", args: { path: "b" } });
  const [shell, edit, mcp, missing] = items();
  assert.ok(shell && edit && mcp && missing);
  assert.equal(shell.type, "command_execution"); if (shell.type !== "command_execution") return;
  assert.equal(shell.output, "out\nerr"); assert.equal(shell.exitCode, 2); assert.equal(shell.status, "failed");
  assert.equal(edit.type, "file_change"); if (edit.type !== "file_change") return;
  assert.deepEqual([edit.diffStr, edit.additions, edit.deletions], ["diff", 2, 1]);
  assert.equal(mcp.type, "dynamic_tool"); if (mcp.type !== "dynamic_tool") return;
  assert.equal(mcp.status, "failed"); assert.deepEqual(mcp.output, { content: [{ text: { text: "bad" } }], isError: true });
  assert.equal(missing.type, "file_change"); if (missing.type !== "file_change") return;
  assert.equal("diffStr" in missing, false); assert.equal("additions" in missing, false);
});

test("projects plans, todos, task results and hides SDK errors", () => {
  const { update, items, events } = setup();
  update("tool-call-completed", "plan", { type: "createPlan", args: { plan: "Do it" } });
  update("tool-call-completed", "todos", { type: "updateTodos", args: { todos: [{ content: "first", status: "inProgress" }, { content: "skip", status: "cancelled" }] } });
  update("tool-call-completed", "task", { type: "task", args: { agentId: "agent", description: "Work", prompt: "Do work" }, result: { status: "success", value: { resultSuffix: "done" } } });
  update("tool-call-completed", "error", { type: "mcp", args: { toolName: "t" }, result: { status: "error", error: { message: "secret" } } });
  const [plan, todos, task, error] = items();
  assert.ok(plan && todos && task && error);
  assert.equal(plan.type, "proposed_plan"); if (plan.type === "proposed_plan") assert.equal(plan.markdown, "Do it");
  assert.equal(todos.type, "todo_list"); if (todos.type === "todo_list") assert.deepEqual(todos.steps, [{ id: "todo-1", text: "first", status: "running" }]);
  assert.equal(task.type, "subagent"); if (task.type === "subagent") assert.equal(task.result, "done");
  assert.equal(error.status, "failed"); assert.equal(JSON.stringify(error).includes("secret"), false);
  assert.equal(events.filter(e => e.type === "subagent_update").at(-1)?.status, "completed");
});

test("finalizes unfinished calls and tasks only once", () => {
  const { projection, update, items, events } = setup();
  update("tool-call-started", "task", { type: "task", args: { description: "Investigate", prompt: "Look", agentId: "agent" } });
  update("tool-call-started", "shell", { type: "shell", args: { command: "cmd" } });
  projection.finalize("interrupted"); projection.finalize("interrupted");
  assert.deepEqual(items().map(i => i.status), ["interrupted", "interrupted"]);
  assert.deepEqual(events.filter(e => e.type === "subagent_update").map(e => e.status), ["running", "interrupted"]);
});

test("uses streamed shell output when the final result contains none", () => {
  const { projection, update, items } = setup();
  update("tool-call-started", "shell", { type: "shell", args: { command: "cmd" } });
  projection.update({ type: "shell-output-delta", event: { toolCallId: "shell", case: "stdout", value: { data: "streamed" } } } as InteractionUpdate);
  update("tool-call-completed", "shell", { type: "shell", args: { command: "cmd" }, result: { status: "success", value: { stdout: "", stderr: "", exitCode: 0 } } });
  const item = items()[0];
  assert.ok(item && item.type === "command_execution");
  assert.equal(item.output, "streamed");
});

test("preserves assistant messages from task conversation steps", () => {
  const { update, items } = setup();
  update("tool-call-completed", "task", { type: "task", args: { description: "Work", prompt: "Go" }, result: { status: "success", value: { conversationSteps: [{ type: "assistantMessage", message: { text: "first" } }, { assistantMessage: { text: "second" } }], resultSuffix: "done" } } });
  const task = items()[0];
  assert.ok(task && task.type === "subagent");
  assert.equal(task.result, "first\nsecond\ndone");
});
