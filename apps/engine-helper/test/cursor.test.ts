import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCursorRejection } from "../src/engines/cursor/rejections.ts";
import { classifyRejection, containRejections } from "../src/rejections.ts";

test("Cursor rejection classifier contains only known SDK failures", () => {
  const closed = Object.assign(new Error("WritableIterable is closed"), { name: "WriteIterableClosedError" });
  const cause = Object.assign(new Error("closed"), { code: "ERR_STREAM_WRITE_AFTER_END" });
  const connect = Object.assign(new Error("failed", { cause }), { name: "ConnectError", code: 10 });
  const abort = Object.assign(new Error("aborted"), {
    name: "AbortError", stack: "AbortError\n    at onStall (/tmp/node_modules/@cursor/sdk/dist/index.js:1:1)",
  });
  const unregister = containRejections(classifyCursorRejection);
  try {
    assert.equal(classifyRejection(closed), "Cursor SDK wrote to a closed exec stream.");
    assert.equal(classifyRejection(connect), "Cursor SDK wrote to an ended request stream.");
    assert.equal(classifyRejection(abort), "Cursor SDK aborted a stalled request.");
    assert.equal(classifyRejection(Object.assign(new Error("other"), { name: "AbortError" })), undefined);
    assert.equal(classifyRejection({ name: "WriteIterableClosedError", message: "WritableIterable is closed" }), undefined);
  } finally {
    unregister();
  }
  assert.equal(classifyRejection(closed), undefined);
});

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const fake = fileURLToPath(new URL("./fakes/cursor-sdk.ts", import.meta.url));
const init = { protocol: 1, engine: "cursor", threadId: "t", cwd: "/tmp", resume: null,
  modelSelection: { instanceId: "cursor", model: "auto" }, runtimeMode: "full-access",
  mcp: { url: "http://127.0.0.1:9/mcp", bearerToken: "fake-mcp" }, instructions: null, launch: null };
const settings = { modelSelection: init.modelSelection, runtimeMode: init.runtimeMode };
function helper() {
  const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH, HOME: "/nonexistent", GOAT2_ENGINE_HELPER_SDK_CURSOR: fake, CURSOR_API_KEY: "fake-key" }, stdio: ["pipe", "pipe", "pipe"] });
  const lines: any[] = [];
  const waiters: Array<() => void> = [];
  createInterface({ input: child.stdout }).on("line", line => { lines.push(JSON.parse(line)); for (const w of waiters.splice(0)) w(); });
  const waitFor = async (predicate: (line: any) => boolean) => {
    for (;;) {
      const found = lines.find(predicate); if (found) return found;
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`timeout: ${JSON.stringify(lines)}`)), 3000); waiters.push(() => { clearTimeout(timer); resolve(); }); });
    }
  };
  let next = 0;
  const request = async (method: string, params: unknown) => { const id = ++next; child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); return waitFor(l => l.id === id); };
  return { child, lines, waitFor, request };
}
const input = (text: string) => [{ inputId: "i", text, attachments: [] }];

test("Cursor helper streams a turn, projects tools, steers, interrupts and resumes", async () => {
  const h = helper();
  try {
    assert.equal((await h.request("initialize", init)).result.engineRef, "cursor-new");
    const first = (await h.request("turn.start", { inputs: input("plain"), settings })).result;
    assert.equal(first.status, "accepted");
    await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === first.turnId);
    const events = h.lines.map(l => l.event).filter(Boolean);
    assert.equal(events.filter(e => e.type === "text_delta").map(e => e.text).join(""), "hello world");
    assert.equal(events.find(e => e.type === "item_completed" && e.item.type === "dynamic_tool").item.toolName, "mcp__goat__goat_describe");
    const second = (await h.request("turn.start", { inputs: input("hang"), settings })).result;
    assert.equal((await h.request("turn.steer", { turnId: second.turnId, inputs: input("more") })).result.status, "accepted");
    assert.equal((await h.request("turn.steer", { turnId: second.turnId, inputs: input("refuse") })).result.status, "declined");
    await h.request("turn.interrupt", { turnId: second.turnId });
    assert.equal((await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === second.turnId)).event.outcome.type, "interrupted");
    await h.request("shutdown", {});
  } finally { h.child.kill(); }
  const resumed = helper();
  try {
    assert.equal((await resumed.request("initialize", { ...init, resume: "original-id" })).result.engineRef, "original-id");
    assert.equal((await resumed.request("turn.start", { inputs: input("reject"), settings })).result.status, "declined");
    const failed = (await resumed.request("turn.start", { inputs: input("fail"), settings })).result;
    assert.equal((await resumed.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === failed.turnId)).event.outcome.type, "failed");
    await resumed.request("shutdown", {});
  } finally { resumed.child.kill(); }
});

test("Cursor probe discovers models without a turn", async () => {
  const h = helper();
  try {
    const p = (await h.request("probe", { protocol: 1, engine: "cursor", cwd: null, launch: null })).result;
    assert.equal(p.status, "ready"); assert.equal(p.auth.status, "authenticated"); assert.equal(p.models[0].slug, "test-model");
  } finally { h.child.kill(); }
});

test("Cursor model catalog preserves v1 parameter mapping and defaults", async () => {
  const { cursorCatalog } = await import("../src/engines/cursor/catalog.ts");
  const models = cursorCatalog([{ id: "m", displayName: "Model", parameters: [
    { id: "fast", values: [{ value: "false" }, { value: "true" }] },
    { id: "context", values: [{ value: "128k" }, { value: "256k" }] },
  ], variants: [{ displayName: "Default", isDefault: true, params: [{ id: "fast", value: "false" }, { id: "context", value: "128k" }] }] }]);
  assert.deepEqual(models[0]?.capabilities?.optionDescriptors, [
    { type: "select", id: "contextWindow", label: "Contextwindow", options: [{ id: "128k", label: "128k", isDefault: true }, { id: "256k", label: "256k" }] },
    { type: "boolean", id: "fastMode", label: "Fastmode", currentValue: false },
  ]);
});

test("Cursor failure classes follow SDK error codes", async () => {
  const { cursorFailure } = await import("../src/engines/cursor/errors.ts");
  assert.equal(cursorFailure({ code: "PRO_USER_USAGE_LIMIT" }).kind, "usage_limit");
  assert.equal(cursorFailure({ status: 429 }).kind, "usage_limit");
  assert.equal(cursorFailure({ name: "AuthenticationError" }).auth, true);
  assert.equal(cursorFailure({ code: "unavailable" }).kind, "transport_error");
});

test("Cursor projects reasoning, commands, edits, todos and subagent lifecycle", async () => {
  const h = helper();
  try {
    await h.request("initialize", init);
    const turn = (await h.request("turn.start", { inputs: input("projects"), settings })).result;
    await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === turn.turnId);
    const events = h.lines.flatMap(l => l.event ? [l.event] : []);
    const items = events.filter(e => e.type === "item_completed").map(e => e.item);
    for (const kind of ["assistant_message", "reasoning", "command_execution", "file_change", "todo_list", "subagent", "dynamic_tool"]) assert.ok(items.some(i => i.type === kind), kind);
    assert.equal(items.find(i => i.type === "command_execution").outputOmitted, true);
    assert.equal(items.find(i => i.type === "file_change").patchOmitted, true);
    assert.deepEqual(events.filter(e => e.type === "subagent_update").map(e => e.status), ["running", "completed"]);
    assert.equal(new Set(items.map(i => i.id)).size, items.length);
    await h.request("shutdown", {});
  } finally { h.child.kill(); }
});

test("Cursor resume cancels a paginated abandoned run before retrying", async () => {
  const h = helper();
  try {
    await h.request("initialize", { ...init, resume: "existing" });
    const result = (await h.request("turn.start", { inputs: input("recover"), settings })).result;
    assert.equal(result.status, "accepted");
    const finish = await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === result.turnId);
    assert.equal(finish.event.outcome.type, "done");
    await h.request("shutdown", {});
  } finally { h.child.kill(); }
});

test("Cursor redacts credentials split across streamed text", async () => {
  const h = helper();
  try {
    await h.request("initialize", init);
    const turn = (await h.request("turn.start", { inputs: input("secret"), settings })).result;
    await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === turn.turnId);
    const events = h.lines.flatMap(l => l.event ? [l.event] : []);
    assert.equal(events.filter(e => e.type === "text_delta").map(e => e.text).join(""), "[redacted]");
    assert.equal(events.find(e => e.type === "item_completed" && e.item.type === "assistant_message").item.text, "[redacted]");
    assert.ok(!JSON.stringify(events).includes("fake-key"));
    await h.request("shutdown", {});
  } finally { h.child.kill(); }
});
