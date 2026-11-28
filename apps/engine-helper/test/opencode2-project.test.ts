import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionToolFailed, SessionToolSuccess } from "@opencode/client";
import { projectTodoList, projectToolCompletion, type ToolProjectionContext } from "../src/engines/opencode2/project.ts";

const ctx: ToolProjectionContext = { turnId: "turn", sessionId: "session", assistantMessageId: "message", toolId: "call", name: "bash", input: { command: "echo ok" }, now: "2026-01-01T00:00:01Z", startedAt: "2026-01-01T00:00:00Z" };
const success = (content: SessionToolSuccess["data"]["content"], metadata?: SessionToolSuccess["data"]["metadata"]): SessionToolSuccess => ({ id: "event", created: 1, type: "session.tool.success", durable: { aggregateID: "session", seq: 1, version: 2 }, data: { id: "call", sessionID: "session", assistantMessageID: "message", executed: true, content, ...(metadata === undefined ? {} : { metadata }) } });
const failed = (type: string, message: string): SessionToolFailed => ({ id: "event", created: 1, type: "session.tool.failed", durable: { aggregateID: "session", seq: 2, version: 2 }, data: { id: "call", sessionID: "session", assistantMessageID: "message", executed: true, error: { type, message } } });
const text = (value: string): SessionToolSuccess["data"]["content"] => [{ type: "text", text: value }];
function result(event: SessionToolSuccess | SessionToolFailed, context = ctx) {
  const events = projectToolCompletion(event, context);
  assert.equal(events?.length, 1);
  const first = events![0]!;
  assert.equal(first.type, "item_completed");
  if (first.type !== "item_completed") throw new Error("expected item");
  return first.item;
}

test("shell retains identity, output and exit code, including nonzero success", () => {
  const value = result(success([{ type: "text", text: "out" }, { type: "text", text: "err" }], { exit: 7 }));
  assert.equal(value.type, "command_execution");
  if (value.type !== "command_execution") return;
  assert.deepEqual({ id: value.id, ref: value.nativeItemRef, status: value.status, input: value.input, output: value.output, exit: value.exitCode, started: value.startedAt }, { id: "call", ref: { driver: "opencode", nativeId: "call", strength: "strong" }, status: "failed", input: "echo ok", output: "out\nerr", exit: 7, started: ctx.startedAt });
  assert.equal(result(success(text("ok"), { exitCode: 0 })).status, "completed");
});

test("failed and aborted events preserve error and ignore completed metadata", () => {
  const event = { ...failed("aborted", "cancelled"), data: { ...failed("aborted", "cancelled").data, metadata: { exit: 1 } } };
  const value = result(event);
  assert.equal(value.status, "interrupted");
  assert.equal(value.type, "command_execution");
  if (value.type === "command_execution") { assert.equal(value.output, "cancelled"); assert.equal(value.exitCode, undefined); }
  assert.equal(result(failed("unknown", "bad")).status, "failed");
});

test("edit diffs, search previews and dynamic inputs and images", () => {
  const edit = result(success(text("done"), { diff: "-old\n+new" }), { ...ctx, name: "edit", input: { filePath: "x.ts", oldString: "old", newString: "new" } });
  assert.equal(edit.type, "file_change");
  if (edit.type === "file_change") assert.deepEqual([edit.fileName, edit.diffStr], ["x.ts", "-old\n+new"]);
  const badEdit = result(failed("error", "patch rejected"), { ...ctx, name: "edit", input: { path: "x.ts" } });
  if (badEdit.type === "file_change") assert.equal(badEdit.diffStr, "patch rejected"); else assert.fail();
  const search = result(success(text("x".repeat(9000))), { ...ctx, name: "webfetch", input: { url: "https://example.test" } });
  assert.equal(search.type, "web_search");
  if (search.type === "web_search") { assert.deepEqual(search.patterns, ["https://example.test"]); assert.equal(search.results?.[0]?.snippet?.length, 8000); }
  const dynamic = result(success([{ type: "text", text: "view" }, { type: "file", uri: "data:image/png;base64,YQ==", mime: "image/png" }]), { ...ctx, name: "mcp__shell", input: { arg: 3 } });
  assert.equal(dynamic.type, "dynamic_tool");
  if (dynamic.type === "dynamic_tool") { assert.deepEqual(dynamic.input, { arg: 3 }); assert.deepEqual(dynamic.output, [{ type: "text", text: "view" }, { type: "image", mimeType: "image/png", data: "YQ==" }]); }
  const fileSearch = result(success(text("match")), { ...ctx, name: "grep", input: { pattern: "x" } });
  assert.equal(fileSearch.type, "dynamic_tool");
  const read = result(success(text("<path>x</path>\n<type>file</type>\n<content>\n1: line\n</content>\nextra")), { ...ctx, name: "read", input: { path: "x" } });
  if (read.type === "dynamic_tool") assert.equal(read.output, "1: line\nextra"); else assert.fail();
});

test("todo validation, stable ids, cancellation and blank labels", () => {
  const metadata = { todos: [{ content: " first ", status: "pending" }, { content: "skip", status: "cancelled" }, { content: " ", status: "in_progress" }, { content: "done", status: "completed" }] };
  const context = { ...ctx, name: "todowrite", todoPlanId: "plan", input: {} };
  const value = result(success(text("ok"), metadata), context);
  assert.equal(value.type, "todo_list");
  if (value.type === "todo_list") assert.deepEqual([value.id, value.planId, value.steps], ["call", "plan", [{ id: "call:1", text: "first", status: "pending" }, { id: "call:3", text: "Todo 3", status: "running" }, { id: "call:4", text: "done", status: "completed" }]]);
  assert.equal(projectTodoList({ todos: [{ content: "x", status: "other" }] }, context), undefined);
  assert.equal(result(success(text("ok"), { todos: [{ content: "x", status: "other" }] }), context).type, "dynamic_tool");
  assert.equal(projectTodoList(metadata, ctx), undefined);
});

test("subagent uses caller-owned identities, terminal result and background update", () => {
  const context = { ...ctx, name: "subagent", input: { prompt: "investigate", description: "Investigate" }, subagent: { id: "node", instanceId: "instance", childThreadId: "child" } };
  const value = result(success(text("<subagent>\nanswer\n</subagent>"), { sessionID: "native-child" }), context);
  assert.equal(value.type, "subagent");
  if (value.type === "subagent") assert.deepEqual([value.subagentId, value.childThreadId, value.prompt, value.result, value.title], ["node", "child", "investigate", "answer", "Investigate"]);
  assert.deepEqual(projectToolCompletion(success(text("launched"), { status: "running" }), context), [{ type: "subagent_update", turnId: "turn", subagentId: "node", status: "running", title: "Investigate", progress: null }]);
  assert.equal(result(failed("aborted", "stopped"), context).status, "interrupted");
  assert.equal(projectToolCompletion(success(text("x")), { ...ctx, name: "subagent", input: context.input }), undefined);
});

test("rejects malformed, mismatched or non JSON input without fabricating an item", () => {
  const good = success(text("ok"));
  assert.equal(projectToolCompletion({ ...good, data: { ...good.data, id: "wrong" } }, ctx), undefined);
  assert.equal(projectToolCompletion({ ...good, data: { ...good.data, assistantMessageID: "wrong" } }, ctx), undefined);
  assert.equal(projectToolCompletion({ ...good, data: { ...good.data, content: [] } } as unknown as SessionToolSuccess, ctx), undefined);
  assert.equal(projectToolCompletion({ ...good, data: { ...good.data, content: [{ type: "text", text: 3 }] } } as unknown as SessionToolSuccess, ctx), undefined);
  assert.equal(projectToolCompletion({ ...good, data: { ...good.data, content: [{ type: "file", uri: "x" }] } } as unknown as SessionToolSuccess, ctx), undefined);
  assert.equal(projectToolCompletion(good, { ...ctx, input: { n: NaN } }), undefined);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(projectToolCompletion(good, { ...ctx, input: cyclic }), undefined);
  assert.equal(projectToolCompletion({ ...failed("bad", "x"), data: { ...failed("bad", "x").data, error: {} } } as unknown as SessionToolFailed, ctx), undefined);
});
