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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const fake = fileURLToPath(new URL("./fakes/cursor-sdk.ts", import.meta.url));
const init = { protocol: 1, engine: "cursor", threadId: "t", cwd: "/tmp", resume: null,
  modelSelection: { instanceId: "cursor", model: "auto" }, runtimeMode: "full-access",
  mcp: { url: "http://127.0.0.1:9/mcp", bearerToken: "fake-mcp" }, instructions: null, launch: null };
const settings = { modelSelection: init.modelSelection, runtimeMode: init.runtimeMode };
function helper(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH, HOME: "/nonexistent", GOAT2_ENGINE_HELPER_SDK_CURSOR: fake, CURSOR_API_KEY: "fake-key", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines: any[] = [];
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
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
  return { child, lines, waitFor, request, stderr: () => stderr };
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
    const secondEvents = h.lines.map(l => l.event).filter(e => e && e.turnId === second.turnId);
    const settled = secondEvents.filter(e => e.type === "steer_updated");
    assert.deepEqual(settled, [{ type: "steer_updated", turnId: second.turnId, inputIds: ["i"], status: { type: "completed" } }]);
    assert.ok(secondEvents.indexOf(settled[0]) < secondEvents.findIndex(e => e.type === "turn_finished"), "steer settled before turn_finished");
    await h.request("shutdown", {});
  } finally { h.child.kill(); }
  const resumed = helper();
  try {
    assert.equal((await resumed.request("initialize", { ...init, resume: "original-id" })).result.engineRef, "original-id");
    assert.equal((await resumed.request("turn.start", { inputs: input("reject"), settings })).result.status, "unknown");
    const failed = (await resumed.request("turn.start", { inputs: input("fail"), settings })).result;
    assert.equal((await resumed.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === failed.turnId)).event.outcome.type, "failed");
    await resumed.request("shutdown", {});
  } finally { resumed.child.kill(); }
});

test("Cursor probe discovers models without a turn", async () => {
  const requests: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/v1/me" ? { apiKeyName: "" } : { items: [{ id: "test-model", displayName: "Test model" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const backend = `http://127.0.0.1:${address.port}`;
  const h = helper();
  try {
    const p = (await h.request("probe", { protocol: 1, engine: "cursor", cwd: null, launch: { env: { CURSOR_BACKEND_URL: backend, CURSOR_API_KEY: "fake-key" } } })).result;
    assert.equal(p.status, "ready"); assert.equal(p.auth.status, "authenticated"); assert.equal(p.models[0].slug, "test-model");
    assert.deepEqual(requests.map(r => [r.method, r.url, r.authorization]).sort(), [["GET", "/v1/me", "Bearer fake-key"], ["GET", "/v1/models", "Bearer fake-key"]]);
  } finally { h.child.kill(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Cursor probe distinguishes invalid keys from an unknown sign-in", async () => {
  const server = createServer((_req, res) => { res.statusCode = 401; res.end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const backend = `http://127.0.0.1:${address.port}`;
  try {
  for (const [key, status] of [["bad-key", "unauthenticated"], ["", "unknown"]]) {
    const h = helper({ CURSOR_API_KEY: key! });
    try {
      const reply = await h.request("probe", { protocol: 1, engine: "cursor", cwd: null, launch: { env: { CURSOR_BACKEND_URL: backend, CURSOR_API_KEY: key } } });
      assert.equal(reply.result.auth.status, status);
      assert.ok(!JSON.stringify(h.lines).includes("bad-key"));
    } finally { h.child.kill(); }
  }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Cursor probe never sends an inherited key to a different backend", async () => {
  let calls = 0;
  const server = createServer((_req, res) => { calls++; res.statusCode = 500; res.end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const h = helper({ GOAT_TEST_SIGNED_IN: "1" });
  try {
    const reply = await h.request("probe", { protocol: 1, engine: "cursor", cwd: null, launch: { env: { CURSOR_BACKEND_URL: `http://127.0.0.1:${address.port}` } } });
    assert.equal(reply.result.auth.status, "unknown");
    assert.equal(calls, 0);
  } finally { h.child.kill(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
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
    assert.equal(items.find(i => i.type === "command_execution").output, "file");
    assert.equal(items.find(i => i.type === "file_change").diffStr, "+x");
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

test("Cursor distinguishes pre-dispatch rejection from uncertain send", async () => {
  const h = helper();
  try {
    await h.request("initialize", init);
    const before = (await h.request("turn.start", { inputs: input(""), settings })).result;
    assert.equal(before.status, "declined");
    const after = (await h.request("turn.start", { inputs: input("reject"), settings })).result;
    assert.equal(after.status, "unknown");
  } finally { h.child.kill(); }
});

test("Cursor supplies resolved and unavailable file attachments in the prompt", async () => {
  const h = helper();
  try {
    await h.request("initialize", init);
    const attachments = [
      { type: "file", id: "ok", name: "report.txt", mimeType: "text/plain", sizeBytes: 1, path: "/tmp/report.txt" },
      { type: "file", id: "missing", name: "lost.txt", mimeType: "text/plain", sizeBytes: 1, path: "" },
    ];
    const started = (await h.request("turn.start", { inputs: [{ inputId: "i", text: "check attachments", attachments }], settings })).result;
    assert.equal(started.status, "accepted");
    await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === started.turnId);
    assert.equal(h.lines.find(l => l.event?.type === "item_completed" && l.event.item.type === "assistant_message").event.item.text, "attachments verified");
  } finally { h.child.kill(); }
});

test("Cursor rejects unavailable native images before SDK dispatch", async () => {
  const h = helper();
  try {
    await h.request("initialize", init);
    const image = { type: "image", id: "img", name: "img.png", mimeType: "image/png", sizeBytes: 1, path: "" };
    const result = (await h.request("turn.start", { inputs: [{ inputId: "i", text: "image", attachments: [image] }], settings })).result;
    assert.equal(result.status, "declined");
    assert.match(result.reason, /attachment|image/i);
  } finally { h.child.kill(); }
});

test("Cursor passes native image bytes to the SDK", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goat-cursor-image-"));
  const path = join(dir, "image.png");
  await writeFile(path, "fake-image");
  const h = helper();
  try {
    await h.request("initialize", init);
    const image = { type: "image", id: "img", name: "img.png", mimeType: "image/png", sizeBytes: 10, path };
    const result = (await h.request("turn.start", { inputs: [{ inputId: "i", text: "verify image", attachments: [image] }], settings })).result;
    assert.equal(result.status, "accepted");
    await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === result.turnId);
    assert.equal(h.lines.find(l => l.event?.type === "item_completed" && l.event.item.type === "assistant_message").event.item.text, "image verified");
  } finally { h.child.kill(); await rm(dir, { recursive: true, force: true }); }
});

test("Cursor scopes inherited credentials to their configured destinations", async () => {
  for (const scenario of [
    { launch: { CURSOR_BACKEND_URL: "https://api2.cursor.sh/" }, key: "fake-key", token: "host-token" },
    { launch: { CURSOR_BACKEND_URL: "https://other.example" }, key: "none", token: "none" },
    { launch: { CURSOR_BACKEND_URL: "https://other.example", CURSOR_API_KEY: "instance-key", CURSOR_AUTH_TOKEN: "instance-token" }, key: "instance-key", token: "instance-token" },
    { launch: { CURSOR_API_ENDPOINT: "https://other.example" }, key: "fake-key", token: "none" },
  ]) {
    const h = helper({ CURSOR_AUTH_TOKEN: "host-token", GOAT_TEST_EXPECT_KEY: scenario.key, GOAT_TEST_EXPECT_TOKEN: scenario.token });
    try {
      const reply = await h.request("initialize", { ...init, launch: { env: scenario.launch } });
      assert.equal(reply.result?.engineRef, "cursor-new", JSON.stringify(reply));
      assert.ok(!JSON.stringify(h.lines).includes("host-token"));
      await h.request("shutdown", {});
    } finally { h.child.kill(); }
  }
});

test("a failed cancellation does not mark a later completed turn interrupted", async () => {
  const h = helper();
  try {
    await h.request("initialize", init);
    const turn = (await h.request("turn.start", { inputs: input("cancel-fails-hang"), settings })).result;
    const cancel = await h.request("turn.interrupt", { turnId: turn.turnId });
    assert.equal(cancel.error?.code, "transport");
    const finished = await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === turn.turnId);
    assert.equal(finished.event.outcome.type, "done");
  } finally { h.child.kill(); }
});

test("Cursor retries cancellation after the previous attempt failed", async () => {
  const h = helper();
  try {
    await h.request("initialize", init);
    const turn = (await h.request("turn.start", { inputs: input("cancel-retry-hang"), settings })).result;
    assert.equal((await h.request("turn.interrupt", { turnId: turn.turnId })).error?.code, "transport");
    assert.deepEqual((await h.request("turn.interrupt", { turnId: turn.turnId })).result, {});
    assert.equal((await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === turn.turnId)).event.outcome.type, "interrupted");
  } finally { h.child.kill(); }
});

test("Cursor completes a finished turn while cancellation is unresponsive", async () => {
  const h = helper();
  try {
    await h.request("initialize", init);
    const turn = (await h.request("turn.start", { inputs: input("wait-done-cancel-hang"), settings })).result;
    void h.request("turn.interrupt", { turnId: turn.turnId }).catch(() => {});
    assert.equal((await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === turn.turnId)).event.outcome.type, "done");
    const next = (await h.request("turn.start", { inputs: input("plain"), settings })).result;
    assert.equal(next.status, "accepted");
  } finally { h.child.kill(); }
});

test("Cursor reports interruption when wait rejects before cancellation succeeds", async () => {
  const h = helper();
  try {
    await h.request("initialize", init);
    const turn = (await h.request("turn.start", { inputs: input("wait-error-cancel-hang"), settings })).result;
    assert.deepEqual((await h.request("turn.interrupt", { turnId: turn.turnId })).result, {});
    const finished = await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === turn.turnId);
    assert.equal(finished.event.outcome.type, "interrupted");
    const next = (await h.request("turn.start", { inputs: input("continue"), settings })).result;
    assert.equal(next.status, "accepted");
    assert.equal((await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === next.turnId)).event.outcome.type, "done");
  } finally { h.child.kill(); }
});

test("Cursor SDK diagnostics cannot leak credentials across writes", async () => {
  const h = helper({ GOAT_TEST_DIAGNOSTIC: "1" });
  try {
    await h.request("initialize", init);
    await h.request("shutdown", {});
    await new Promise<void>(resolve => h.child.once("close", () => resolve()));
    assert.ok(!h.stderr().includes("fake-key"));
    assert.ok(!h.stderr().includes("fake-mcp"));
    assert.ok(h.stderr().includes("diagnostic"));
  } finally { h.child.kill(); }
});

test("Cursor passes an empty MCP override when a resumed session has no endpoint", async () => {
  const h = helper({ GOAT_TEST_NO_MCP: "1" });
  try {
    await h.request("initialize", { ...init, mcp: null, resume: "existing" });
    const result = (await h.request("turn.start", { inputs: input("plain"), settings })).result;
    assert.equal(result.status, "accepted");
    assert.equal((await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === result.turnId)).event.outcome.type, "done");
  } finally { h.child.kill(); }
});

test("Cursor refuses overlapping probe and initialize before changing environment", async () => {
  let notify!: () => void;
  const arrived = new Promise<void>(resolve => { notify = resolve; });
  const held: Array<{ url: string; response: import("node:http").ServerResponse }> = [];
  const server = createServer((req, response) => {
    held.push({ url: req.url ?? "", response });
    notify();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const backend = `http://127.0.0.1:${address.port}`;
  const h = helper();
  try {
    const probe = h.request("probe", { protocol: 1, engine: "cursor", cwd: null, launch: { env: { CURSOR_BACKEND_URL: backend, CURSOR_API_KEY: "fake-key" } } });
    await arrived;
    const initialized = await h.request("initialize", init);
    assert.equal(initialized.error?.code, "unavailable");
    // Both GETs are released by closing the server after returning one valid response each.
    for (const entry of held) entry.response.end(JSON.stringify(entry.url === "/v1/me" ? { apiKeyName: "" } : { items: [] }));
    // The second request may arrive after the first; answer it immediately as well.
    server.removeAllListeners("request");
    server.on("request", (req, response) => response.end(JSON.stringify(req.url === "/v1/me" ? { apiKeyName: "" } : { items: [] })));
    const result = await probe;
    assert.equal(result.result?.auth.status, "authenticated");
    assert.equal((await h.request("initialize", { ...init, launch: { env: { CURSOR_BACKEND_URL: backend, CURSOR_API_KEY: "fake-key" } } })).result?.engineRef, "cursor-new");
  } finally { for (const entry of held) if (!entry.response.writableEnded) entry.response.end(); h.child.kill(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Cursor SDK loaded for one backend refuses another backend before opening a session", async () => {
  const h = helper({ GOAT2_ENGINE_HELPER_SDK_CURSOR: "", CURSOR_API_KEY: "" });
  try {
    const first = await h.request("probe", { protocol: 1, engine: "cursor", cwd: null, launch: { env: { CURSOR_BACKEND_URL: "http://127.0.0.1:1" } } });
    assert.equal(first.result?.auth.status, "unknown");
    const next = await h.request("initialize", { ...init, launch: { env: { CURSOR_BACKEND_URL: "http://127.0.0.1:2", CURSOR_API_KEY: "synthetic-key" } } });
    assert.equal(next.error?.code, "unavailable");
    assert.match(next.error.message, /another backend/);
    assert.ok(!JSON.stringify(h.lines).includes("synthetic-key"));
  } finally { h.child.kill(); }
});

test("Cursor applies an in-session model change to the next SDK send", async () => {
  const h = helper();
  try {
    await h.request("initialize", init);
    const changed = { ...settings, modelSelection: { ...settings.modelSelection, model: "new-model" } };
    assert.deepEqual((await h.request("session.set_config", { settings: changed })).result, {});
    const turn = (await h.request("turn.start", { inputs: input("switch-model"), settings })).result;
    assert.equal(turn.status, "accepted");
    assert.equal((await h.waitFor(l => l.event?.type === "turn_finished" && l.event.turnId === turn.turnId)).event.outcome.type, "done");
    const unsupported = await h.request("session.set_config", { settings: { ...changed, runtimeMode: "approval-required" } });
    assert.equal(unsupported.error?.code, "unsupported");
  } finally { h.child.kill(); }
});
