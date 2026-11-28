import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { opencodeEngine } from "../src/engines/opencode/index.ts";
import type { EngineEvent, InitializeParams, TurnSettings } from "../src/protocol.ts";
import * as fake from "./fakes/opencode-sdk.ts";

process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE = fileURLToPath(new URL("./fakes/opencode-sdk.ts", import.meta.url));
const modelSelection = { instanceId: "opencode", model: "test/model" };
const settings: TurnSettings = { modelSelection, runtimeMode: "full-access" };
const params: InitializeParams = { protocol: 1, engine: "opencode", threadId: "admission-test", cwd: process.cwd(), resume: null, modelSelection, runtimeMode: "full-access", mcp: null, instructions: null, launch: null };

test("prompt submission failure does not report a turn as accepted", async () => {
  fake.reset();
  const events: EngineEvent[] = [];
  const host = { emit: (event: EngineEvent) => events.push(event), log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  try {
    const result = await session.startTurn([{ inputId: "input", text: "fail-prompt", attachments: [] }], settings);
    assert.equal(result.status, "unknown");
    assert.equal(fake.calls.filter((call) => call.method === "prompt").length, 1);
    assert.equal(events.some((event) => event.type === "turn_finished"), false);
  } finally {
    await session.shutdown();
  }
});

test("a definite prompt rejection is declined and permits a later turn", async () => {
  fake.reset();
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  try {
    assert.equal((await session.startTurn([{ inputId: "i", text: "reject-prompt", attachments: [] }], settings)).status, "declined");
    assert.equal((await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings)).status, "accepted");
  } finally { await session.shutdown(); }
});

test("an uncertain steer cannot be silently resent as a later turn", async () => {
  fake.reset(); const finished = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  try {
    const turn = await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings);
    assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
    await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await session.steer(turn.turnId, [{ inputId: "s", text: "fail-prompt", attachments: [] }])).status, "unknown");
    await session.interrupt(turn.turnId); await finished.promise;
    assert.equal((await session.startTurn([{ inputId: "n", text: "hold again", attachments: [] }], settings)).status, "declined");
  } finally { await session.shutdown(); }
});

test("the pinned SDK exposes HTTP rejection and transport failure separately", async () => {
  const input = { sessionID: "session-test", parts: [{ type: "text" as const, text: "hello" }] };
  const rejected = createOpencodeClient({ baseUrl: "http://example.invalid", fetch: async () => new Response('{"name":"BadRequestError"}', { status: 400, headers: { "content-type": "application/json" } }) });
  const reply = await rejected.session.promptAsync(input, { throwOnError: false });
  assert.equal(reply.response?.status, 400); assert.ok(reply.error);
  const disconnected = createOpencodeClient({ baseUrl: "http://example.invalid", fetch: async () => { throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); } });
  const failed = await disconnected.session.promptAsync(input, { throwOnError: false });
  assert.equal(failed.response, undefined); assert.ok(failed.error instanceof TypeError);
});

test("resolved and unavailable attachments are delivered using v1 prompt parts", async () => {
  fake.reset();
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  try {
    const result = await session.startTurn([{ inputId: "input", text: "hold", attachments: [
      { type: "file", id: "a", name: "notes.txt", mimeType: "text/plain", sizeBytes: 4, path: "/tmp/has space.txt" },
      { type: "file", id: "b", name: "missing.pdf", mimeType: "application/pdf", sizeBytes: 4, path: null },
    ] }], settings);
    assert.equal(result.status, "accepted");
    const prompt = fake.calls.find((call) => call.method === "prompt")?.args as { parts: unknown[] };
    assert.deepEqual(prompt.parts, [
      { type: "text", text: 'hold\n\n[Attached file "notes.txt" is saved at: /tmp/has space.txt]\n\n[Attached file "missing.pdf" is unavailable: could not resolve a saved path for attachment \'b\'.]' },
      { type: "file", mime: "text/plain", filename: "notes.txt", url: "file:///tmp/has%20space.txt" },
    ]);
  } finally { await session.shutdown(); }
});

test("model-only configuration is accepted and a mode change applies nothing", async () => {
  fake.reset();
  const done = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { if (event.type === "turn_finished") done.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  try {
    assert.equal(typeof session.setConfig, "function");
    const modelB = { instanceId: "opencode", model: "test/model-b" };
    await session.setConfig!({ modelSelection: modelB, runtimeMode: "full-access" });
    await assert.rejects(session.setConfig!({ modelSelection: { instanceId: "opencode", model: "test/model-c" }, runtimeMode: "approval-required" }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "unsupported");
    assert.equal((await session.startTurn([{ inputId: "i", text: "hello", attachments: [] }], { modelSelection: modelB, runtimeMode: "full-access" })).status, "accepted");
    await done.promise;
    const prompt = fake.calls.find((call) => call.method === "prompt")?.args as { model: unknown };
    assert.deepEqual(prompt.model, { providerID: "test", modelID: "model-b" });
  } finally { await session.shutdown(); }
});

test("a user part arriving before its role never becomes assistant output", async () => {
  fake.reset(); const events: EngineEvent[] = []; const finished = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  const gate = fake.holdPrompt();
  try {
    const starting = session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings);
    await gate.reached;
    await fake.sendEvent("message.part.updated", { sessionID: session.engineRef, time: 1, part: { id: "user-part", sessionID: session.engineRef, messageID: "user-message", type: "text", text: "private user input" } });
    await fake.sendEvent("message.updated", { sessionID: session.engineRef, info: { id: "user-message", sessionID: session.engineRef, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test", modelID: "model" } } });
    gate.release();
    const result = await starting; assert.equal(result.status, "accepted");
    if (result.status !== "accepted") throw new Error("turn not admitted");
    await session.interrupt(result.turnId); await finished.promise;
    assert.ok(!JSON.stringify(events).includes("private user input"));
  } finally { gate.release(); await session.shutdown(); }
});

test("an assistant part is recovered from history or fails visibly when its role is missing", async () => {
  for (const recover of [true, false]) {
    fake.reset(); const events: EngineEvent[] = []; const finished = Promise.withResolvers<void>();
    const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
    const session = await opencodeEngine.start(params, host);
    try {
      fake.setHistory(recover ? [{ info: { id: "assistant-late", role: "assistant" } }] : []);
      assert.equal((await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings)).status, "accepted");
      await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } });
      await fake.sendEvent("message.part.updated", { sessionID: session.engineRef, time: 1, part: { id: "late-part", sessionID: session.engineRef, messageID: "assistant-late", type: "text", text: "Recovered" } });
      await fake.sendEvent("session.idle", { sessionID: session.engineRef });
      await finished.promise;
      const terminal = events.find((event) => event.type === "turn_finished");
      assert.equal(terminal?.type === "turn_finished" && terminal.outcome.type, recover ? "done" : "failed");
      assert.equal(events.some((event) => event.type === "item_completed" && event.item.type === "assistant_message" && event.item.text === "Recovered"), recover);
      assert.equal(events.filter((event) => event.type === "turn_finished").length, 1);
    } finally { await session.shutdown(); }
  }
});

test("unowned native work outside a turn fails the helper visibly", async () => {
  fake.reset(); const failures: string[] = [];
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { failures.push(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  try {
    await fake.sendEvent("message.updated", { sessionID: session.engineRef, info: { id: "external-prompt", sessionID: session.engineRef, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test", modelID: "model" } } });
    await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } });
    assert.deepEqual(failures, ["OpenCode background work requires unsupported host coordination"]);
  } finally { await session.shutdown(); }
});

test("a text delta arriving before its part survives until the assistant role is known", async () => {
  fake.reset(); const events: EngineEvent[] = []; const finished = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host); const gate = fake.holdPrompt();
  try {
    const starting = session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings); await gate.reached;
    await fake.sendEvent("message.part.delta", { sessionID: session.engineRef, messageID: "assistant-early", partID: "part-early", field: "text", delta: " world" });
    await fake.sendEvent("message.part.updated", { sessionID: session.engineRef, time: 1, part: { id: "part-early", sessionID: session.engineRef, messageID: "assistant-early", type: "text", text: "Hello" } });
    await fake.sendEvent("message.updated", { sessionID: session.engineRef, info: { id: "assistant-early", sessionID: session.engineRef, role: "assistant", time: { created: 1 }, parentID: "input", providerID: "test", modelID: "model", mode: "build", agent: "build", path: { cwd: "/tmp", root: "/tmp" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } });
    gate.release(); const turn = await starting; assert.equal(turn.status, "accepted");
    if (turn.status !== "accepted") throw new Error("turn not admitted");
    await session.interrupt(turn.turnId); await finished.promise;
    assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.text : "").join(""), "Hello world");
    assert.ok(events.some((event) => event.type === "item_completed" && event.item.type === "assistant_message" && event.item.text === "Hello world"));
  } finally { gate.release(); await session.shutdown(); }
});

test("a different running server generation is rejected before session creation", async () => {
  fake.reset(); fake.setHealth({ healthy: true, version: "2.0.28" });
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  await assert.rejects(opencodeEngine.start(params, host), /OpenCode 1\.x/);
  assert.ok(!fake.calls.some((call) => call.method === "create" || call.method === "mcp.add" || call.method === "prompt"));
});

test("probe rejects a server whose health reports another generation", async () => {
  fake.reset(); fake.setHealth({ healthy: true, version: "2.0.28" });
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const result = await opencodeEngine.probe!({ protocol: 1, engine: "opencode", cwd: process.cwd(), launch: null }, host);
  assert.equal(result.status, "error");
  assert.ok(!fake.calls.some((call) => call.method === "prompt" || call.method === "create"));
});

test("probe distinguishes an installed binary with a failed version command from a missing binary", async () => {
  const saved = process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE;
  delete process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE;
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  try {
    const result = await opencodeEngine.probe!({ protocol: 1, engine: "opencode", cwd: process.cwd(), launch: { binary: process.execPath, args: ["--not-a-real-node-option"] } }, host);
    assert.equal(result.installed, true);
    assert.equal(result.version, null);
    assert.equal(result.status, "error");
    const missing = await opencodeEngine.probe!({ protocol: 1, engine: "opencode", cwd: process.cwd(), launch: { binary: "/nonexistent/goat-opencode-test" } }, host);
    assert.equal(missing.installed, false);
    assert.equal(missing.version, null);
    assert.equal(missing.status, "error");
  } finally { if (saved !== undefined) process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE = saved; }
});

test("owned OpenCode server uses the configured password before generating one", async () => {
  const saved = process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE;
  delete process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE;
  const { startServer } = await import("../src/engines/opencode/runtime.ts");
  try {
    const server = await startServer({} as never, process.cwd(), { binary: process.execPath, args: [fileURLToPath(new URL("./fakes/opencode-server.ts", import.meta.url))], env: { OPENCODE_SERVER_PASSWORD: "synthetic-server-password" } });
    try { assert.equal(server.password, "synthetic-server-password"); } finally { await server.close(); }
  } finally { if (saved !== undefined) process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE = saved; }
});

test("owned OpenCode server selects an ephemeral nonzero port before launch", async () => {
  const saved = process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE;
  delete process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE;
  const { startServer } = await import("../src/engines/opencode/runtime.ts");
  try {
    const server = await startServer({} as never, process.cwd(), { binary: process.execPath, args: [fileURLToPath(new URL("./fakes/opencode-server.ts", import.meta.url))], env: { GOAT_TEST_REQUIRE_NONZERO_PORT: "1" } });
    await server.close();
  } finally { if (saved !== undefined) process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE = saved; }
});

test("native child sessions retain their restrictions while receiving the parent policy", async () => {
  fake.reset();
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, runtimeMode: "approval-required" }, host);
  try {
    await fake.sendEvent("session.created", { sessionID: "child-1", info: { id: "child-1", parentID: session.engineRef, permission: [{ permission: "edit", pattern: "/private/*", action: "deny" }] } });
    const update = fake.calls.find((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "child-1")?.args as { permission: Array<{ permission: string; action: string }> } | undefined;
    assert.ok(update);
    assert.ok(update.permission.some((rule) => rule.permission === "read" && rule.action === "allow"));
    assert.deepEqual(update.permission.at(-1), { permission: "edit", pattern: "/private/*", action: "deny" });
  } finally { await session.shutdown(); }
});

test("JSONL turn response precedes events received during native submission", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
    env: { ...process.env, GOAT2_ENGINE_HELPER_SDK_OPENCODE: fileURLToPath(new URL("./fakes/opencode-sdk.ts", import.meta.url)) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const frames: Array<Record<string, unknown>> = [];
  const initialized = Promise.withResolvers<void>(); const finished = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>(); child.once("close", () => closed.resolve());
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const frame = JSON.parse(line) as Record<string, unknown>; frames.push(frame);
    if (frame.id === 1) initialized.resolve();
    if ((frame.event as { type?: string } | undefined)?.type === "turn_finished") finished.resolve();
  });
  try {
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params })}\n`); await initialized.promise;
    child.stdin.write(`${JSON.stringify({ id: 2, method: "turn.start", params: { inputs: [{ inputId: "i", text: "inline-events", attachments: [] }], settings } })}\n`);
    await finished.promise;
    const response = frames.findIndex((frame) => frame.id === 2);
    const firstEvent = frames.findIndex((frame) => frame.event !== undefined);
    assert.ok(response >= 0 && firstEvent > response);
    assert.equal((frames[response]?.result as { status?: string }).status, "accepted");
  } finally { child.stdin.end(); await closed.promise; lines.close(); }
});

test("a detached native child stays running until its session ends", async () => {
  fake.reset(); const events: EngineEvent[] = [];
  const host = { emit(event: EngineEvent) { events.push(event); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host); const gate = fake.holdPrompt();
  try {
    const starting = session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings); await gate.reached;
    await fake.sendEvent("session.created", { sessionID: "child-1", info: { id: "child-1", parentID: session.engineRef, permission: [] } });
    await fake.sendEvent("message.part.updated", { sessionID: session.engineRef, time: 1, part: { id: "task-1", sessionID: session.engineRef, messageID: "assistant-1", type: "tool", tool: "task", callID: "call-1", state: { status: "completed", input: { prompt: "research" }, output: "", title: "Child", metadata: { sessionId: "child-1", background: true }, time: { start: 1, end: 2 } } } });
    gate.release(); assert.equal((await starting).status, "accepted");
    await fake.sendEvent("session.idle", { sessionID: "child-1" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const states = events.filter((event) => event.type === "subagent_update" && event.subagentId === "child-1").map((event) => event.type === "subagent_update" ? event.status : "");
    assert.deepEqual(states, ["running", "completed"]);
  } finally { gate.release(); await session.shutdown(); }
});

test("one OpenCode server crash does not fail another session", async () => {
  fake.reset(); const firstFailures: string[] = []; const secondFailures: string[] = [];
  const host = (failures: string[]) => ({ emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { failures.push(reason); }, now: () => "2026-01-01T00:00:00Z" });
  const first = await opencodeEngine.start(params, host(firstFailures));
  const second = await opencodeEngine.start(params, host(secondFailures));
  try {
    fake.crashServer(0);
    assert.deepEqual(firstFailures, ["OpenCode server exited"]);
    assert.deepEqual(secondFailures, []);
    assert.equal((await second.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings)).status, "accepted");
  } finally { await first.shutdown(); await second.shutdown(); }
});
