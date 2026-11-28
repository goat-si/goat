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

test("accepted steers settle before the turn finishes, including unread cancellation", async () => {
  for (const read of [true, false]) {
    fake.reset(); const events: EngineEvent[] = []; const finished = Promise.withResolvers<void>();
    const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
    const session = await opencodeEngine.start(params, host);
    try {
      const turn = await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings);
      assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
      await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const result = await session.steer(turn.turnId, [{ inputId: "steer-a", text: "unread-steer", attachments: [] }, { inputId: "steer-b", text: "", attachments: [] }]);
      assert.equal(result.status, "accepted");
      if (read) {
        const call = fake.calls.filter((entry) => entry.method === "prompt").at(-1)?.args as { messageID: string };
        await fake.sendEvent("message.updated", { sessionID: session.engineRef, info: { id: call.messageID, sessionID: session.engineRef, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test", modelID: "model" } } });
      }
      await session.interrupt(turn.turnId); await finished.promise;
      const settled = events.findIndex((event) => event.type === "steer_updated");
      const ended = events.findIndex((event) => event.type === "turn_finished");
      assert.ok(settled >= 0 && settled < ended);
      const event = events[settled]; assert.equal(event?.type, "steer_updated");
      if (event?.type === "steer_updated") { assert.deepEqual(event.inputIds, ["steer-a", "steer-b"]); assert.equal(event.status.type, read ? "completed" : "cancelled"); }
      assert.equal(events.filter((event) => event.type === "steer_updated").length, 1);
    } finally { await session.shutdown(); }
  }
});

test("an unread accepted steer is cancelled when the native turn idles normally", async () => {
  fake.reset(); const events: EngineEvent[] = [];
  const host = { emit(event: EngineEvent) { events.push(event); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  try {
    const turn = await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings);
    assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
    await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await session.steer(turn.turnId, [{ inputId: "unread", text: "unread-steer", attachments: [] }])).status, "accepted");
    fake.setNativeStatus(session.engineRef, "idle");
    await fake.sendEvent("session.idle", { sessionID: session.engineRef });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settled = events.findIndex((event) => event.type === "steer_updated" && event.status.type === "cancelled");
    const ended = events.findIndex((event) => event.type === "turn_finished" && event.outcome.type === "done");
    assert.ok(settled >= 0 && settled < ended);
  } finally { await session.shutdown(); }
});

test("idle observed before a steer reply is reconciled after acceptance", async () => {
  fake.reset(); const events: EngineEvent[] = [];
  const host = { emit(event: EngineEvent) { events.push(event); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  try {
    const turn = await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings);
    assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
    await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } }); await new Promise<void>((resolve) => setImmediate(resolve));
    const gate = fake.holdPrompt(); const steering = session.steer(turn.turnId, [{ inputId: "steer-early-idle", text: "unread-steer", attachments: [] }]); await gate.reached;
    fake.setNativeStatus(session.engineRef, "idle"); await fake.sendEvent("session.idle", { sessionID: session.engineRef });
    gate.release(); assert.equal((await steering).status, "accepted"); await new Promise<void>((resolve) => setImmediate(resolve));
    const settled = events.findIndex((event) => event.type === "steer_updated" && event.status.type === "cancelled");
    const ended = events.findIndex((event) => event.type === "turn_finished" && event.outcome.type === "done");
    assert.ok(settled >= 0 && settled < ended);
  } finally { await session.shutdown(); }
});

test("a steer observed before its reply remains unknown after an early turn failure", async () => {
  fake.reset(); const events: EngineEvent[] = []; const finished = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  try {
    const turn = await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings);
    assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
    await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const gate = fake.holdPrompt(true); const steering = session.steer(turn.turnId, [{ inputId: "steer-early", text: "unread-steer", attachments: [] }]);
    await gate.reached;
    const call = fake.calls.filter((entry) => entry.method === "prompt").at(-1)?.args as { messageID: string };
    await fake.sendEvent("message.updated", { sessionID: session.engineRef, info: { id: call.messageID, sessionID: session.engineRef, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test", modelID: "model" } } });
    await fake.sendEvent("session.error", { sessionID: session.engineRef, error: { name: "UnknownError", data: { message: "synthetic" } } });
    await finished.promise;
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
    assert.equal(events.filter((event) => event.type === "steer_updated").length, 0);
    const count = events.length; gate.release(); assert.equal((await steering).status, "unknown"); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events.length, count);
  } finally { await session.shutdown(); }
});

test("turn usage uses the last owned step and ignores malformed or unrelated usage", async () => {
  fake.reset(); const events: EngineEvent[] = []; const finished = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  try {
    const turn = await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings);
    assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const prompt = fake.calls.filter((entry) => entry.method === "prompt").at(-1)?.args as { messageID: string };
    const step = (id: string, messageID: string, input: number) => ({ id, sessionID: session.engineRef, messageID, type: "step-finish", reason: "stop", cost: 0, tokens: { input, output: 8, reasoning: 2, cache: { read: 3, write: 4 } } });
    await fake.sendEvent("message.part.updated", { sessionID: session.engineRef, part: step("owned-step", "assistant-owned", 7) });
    await fake.sendEvent("message.updated", { sessionID: session.engineRef, info: { id: "assistant-owned", sessionID: session.engineRef, role: "assistant", parentID: prompt.messageID, time: {} } });
    await fake.sendEvent("message.updated", { sessionID: session.engineRef, info: { id: "assistant-other", sessionID: session.engineRef, role: "assistant", parentID: "foreign", time: {} } });
    await fake.sendEvent("message.part.updated", { sessionID: session.engineRef, part: step("other-step", "assistant-other", 100) });
    await fake.sendEvent("message.part.updated", { sessionID: session.engineRef, part: step("bad-step", "assistant-owned", -1) });
    await fake.sendEvent("session.idle", { sessionID: session.engineRef }); await finished.promise;
    const usage = events.filter((event) => event.type === "token_usage");
    assert.deepEqual(usage, [{ type: "token_usage", turnId: turn.turnId, usage: { usedTokens: 22, inputTokens: 14, cachedInputTokens: 3, outputTokens: 8, reasoningOutputTokens: 2 } }]);
    assert.ok(events.indexOf(usage[0]!) < events.findIndex((event) => event.type === "turn_finished"));
  } finally { await session.shutdown(); }
});

test("a late steer success during descendant cleanup remains unknown after failure", async () => {
  fake.reset(); const events: EngineEvent[] = [];
  const host = { emit(event: EngineEvent) { events.push(event); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host); fake.setChildren(session.engineRef, ["child-1"]);
  const child = fake.holdAbort("child-1");
  try {
    const turn = await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings);
    assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
    await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const gate = fake.holdPrompt(true);
    try {
      const steering = session.steer(turn.turnId, [{ inputId: "late-steer", text: "unread-steer", attachments: [] }]); await gate.reached;
      const stopping = session.interrupt(turn.turnId); await child.reached;
      await fake.sendEvent("session.error", { sessionID: session.engineRef, error: { name: "UnknownError", data: { message: "synthetic" } } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      gate.release(); assert.equal((await steering).status, "unknown");
      assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
      child.release(); await stopping;
      await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "idle" } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(events.filter((event) => event.type === "steer_updated").length, 0);
      assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
      const count = events.length; await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(events.length, count);
    } finally { gate.release(); }
  } finally { child.release(); await session.shutdown(); }
});

test("a terminal provider failure invalidates a stalled steer submission", async () => {
  fake.reset(); const events: EngineEvent[] = [];
  const host = { emit(event: EngineEvent) { events.push(event); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  const gate = fake.holdPrompt();
  try {
    // Release the first submission, then install a separate barrier for steering.
    const start = session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings); await gate.reached; gate.release();
    const turn = await start; assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
    await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } }); await new Promise<void>((resolve) => setImmediate(resolve));
    const steerGate = fake.holdPrompt();
    try {
      const steering = session.steer(turn.turnId, [{ inputId: "stalled", text: "unread-steer", attachments: [] }]); await steerGate.reached;
      await fake.sendEvent("session.error", { sessionID: session.engineRef, error: { name: "UnknownError", data: { message: "synthetic" } } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(events.some((event) => event.type === "turn_finished" && event.outcome.type === "failed"));
      assert.equal((await steering).status, "unknown");
    } finally { steerGate.release(); }
  } finally { gate.release(); await session.shutdown(); }
});

test("a server crash cancels an unread accepted steer before turn failure", async () => {
  fake.reset(); const events: EngineEvent[] = []; const failures: string[] = [];
  const host = { emit(event: EngineEvent) { events.push(event); }, log() {}, fail(reason: string) { failures.push(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  try {
    const turn = await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings);
    assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
    await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await session.steer(turn.turnId, [{ inputId: "steer-crash", text: "unread-steer", attachments: [] }])).status, "accepted");
    fake.crashServer(0);
    const settled = events.findIndex((event) => event.type === "steer_updated"); const ended = events.findIndex((event) => event.type === "turn_finished");
    assert.ok(settled >= 0 && settled < ended);
    const event = events[settled]; assert.ok(event?.type === "steer_updated" && event.status.type === "cancelled");
    assert.deepEqual(failures, ["OpenCode server exited"]);
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
  fake.setHistory([{ info: { id: "assistant-early", role: "assistant" }, parts: [{ id: "part-early", sessionID: session.engineRef, messageID: "assistant-early", type: "text", text: "Hello world" }] }]);
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

test("an early delta already present inside a later snapshot is not duplicated", async () => {
  fake.reset(); const events: EngineEvent[] = []; const finished = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host); const gate = fake.holdPrompt();
  fake.setHistory([{ info: { id: "assistant-early", role: "assistant" }, parts: [{ id: "part-early", sessionID: session.engineRef, messageID: "assistant-early", type: "text", text: "Hello world!" }] }]);
  try {
    const starting = session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings); await gate.reached;
    await fake.sendEvent("message.part.delta", { sessionID: session.engineRef, messageID: "assistant-early", partID: "part-early", field: "text", delta: " world" });
    await fake.sendEvent("message.part.updated", { sessionID: session.engineRef, time: 1, part: { id: "part-early", sessionID: session.engineRef, messageID: "assistant-early", type: "text", text: "Hello world!" } });
    await fake.sendEvent("message.updated", { sessionID: session.engineRef, info: { id: "assistant-early", sessionID: session.engineRef, role: "assistant", time: { created: 1 }, parentID: "input", providerID: "test", modelID: "model", mode: "build", agent: "build", path: { cwd: "/tmp", root: "/tmp" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } });
    gate.release(); const turn = await starting; assert.equal(turn.status, "accepted");
    if (turn.status !== "accepted") throw new Error("turn not admitted");
    await session.interrupt(turn.turnId); await finished.promise;
    assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.text : "").join(""), "Hello world!");
    assert.ok(events.some((event) => event.type === "item_completed" && event.item.type === "assistant_message" && event.item.text === "Hello world!"));
  } finally { gate.release(); await session.shutdown(); }
});

test("repeated early delta is recovered from authoritative native history", async () => {
  fake.reset(); const events: EngineEvent[] = []; const finished = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host); const gate = fake.holdPrompt();
  fake.setHistory([{ info: { id: "assistant-early", role: "assistant" }, parts: [{ id: "part-early", sessionID: session.engineRef, messageID: "assistant-early", type: "text", text: "cat dog cat" }] }]);
  try {
    const starting = session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings); await gate.reached;
    await fake.sendEvent("message.part.delta", { sessionID: session.engineRef, messageID: "assistant-early", partID: "part-early", field: "text", delta: "cat" });
    await fake.sendEvent("message.part.updated", { sessionID: session.engineRef, time: 1, part: { id: "part-early", sessionID: session.engineRef, messageID: "assistant-early", type: "text", text: "cat dog " } });
    await fake.sendEvent("message.updated", { sessionID: session.engineRef, info: { id: "assistant-early", sessionID: session.engineRef, role: "assistant", time: { created: 1 }, parentID: "input", providerID: "test", modelID: "model", mode: "build", agent: "build", path: { cwd: "/tmp", root: "/tmp" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } });
    gate.release(); assert.equal((await starting).status, "accepted");
    await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } });
    await fake.sendEvent("session.idle", { sessionID: session.engineRef }); await finished.promise;
    assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.text : "").join(""), "cat dog cat");
    assert.ok(events.some((event) => event.type === "item_completed" && event.item.type === "assistant_message" && event.item.text === "cat dog cat"));
  } finally { gate.release(); await session.shutdown(); }
});

test("an ambiguous early delta fails visibly when native history lacks the part", async () => {
  fake.reset(); const events: EngineEvent[] = []; const finished = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host); const gate = fake.holdPrompt();
  try {
    const starting = session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings); await gate.reached;
    await fake.sendEvent("message.part.delta", { sessionID: session.engineRef, messageID: "assistant-early", partID: "part-early", field: "text", delta: "cat" });
    await fake.sendEvent("message.part.updated", { sessionID: session.engineRef, time: 1, part: { id: "part-early", sessionID: session.engineRef, messageID: "assistant-early", type: "text", text: "cat dog " } });
    await fake.sendEvent("message.updated", { sessionID: session.engineRef, info: { id: "assistant-early", sessionID: session.engineRef, role: "assistant", time: { created: 1 }, parentID: "input", providerID: "test", modelID: "model", mode: "build", agent: "build", path: { cwd: "/tmp", root: "/tmp" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } });
    gate.release(); assert.equal((await starting).status, "accepted");
    await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } });
    await fake.sendEvent("session.idle", { sessionID: session.engineRef }); await finished.promise;
    const terminal = events.find((event) => event.type === "turn_finished");
    assert.equal(terminal?.type === "turn_finished" && terminal.outcome.type, "failed");
    assert.ok(!events.some((event) => event.type === "text_delta" || (event.type === "item_completed" && event.item.type === "assistant_message")));
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
    await fake.sendEvent("session.created", { sessionID: "child-1", info: { id: "child-1", parentID: session.engineRef, permission: [{ permission: "bash", pattern: "*", action: "allow" }, { permission: "edit", pattern: "/private/*", action: "deny" }] } });
    const update = fake.calls.find((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "child-1")?.args as { permission: Array<{ permission: string; action: string }> } | undefined;
    assert.ok(update);
    assert.ok(update.permission.some((rule) => rule.permission === "read" && rule.action === "allow"));
    assert.ok(!update.permission.some((rule) => rule.permission === "bash" && rule.action === "allow"));
    assert.deepEqual(update.permission.at(-1), { permission: "edit", pattern: "/private/*", action: "deny" });
  } finally { await session.shutdown(); }
});

test("new sessions record the installed permission base for a later resume", async () => {
  fake.reset();
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, runtimeMode: "approval-required" }, host);
  try {
    const created = fake.calls.find((call) => call.method === "create")?.args as { permission: unknown; metadata?: { goatPermissionBase?: unknown; goatSubagentDeny?: unknown } };
    assert.deepEqual(created.metadata?.goatPermissionBase, created.permission);
    assert.equal(created.metadata?.goatSubagentDeny, false);
  } finally { await session.shutdown(); }
});

test("resumed sessions restore policies for existing native children", async () => {
  fake.reset(); fake.setChildren("session-fake", ["existing-child"]); fake.setNativePermission("session-fake", [{ permission: "edit", pattern: "/protected/*", action: "deny" }]);
  fake.setNativePermission("existing-child", [{ permission: "bash", pattern: "*", action: "allow" }, { permission: "edit", pattern: "/child-private/*", action: "deny" }]);
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, resume: "session-fake", runtimeMode: "approval-required" }, host);
  try {
    assert.ok(fake.calls.some((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "existing-child"));
    const root = fake.calls.find((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "session-fake")?.args as { permission: Array<{ permission: string; pattern: string; action: string }> };
    assert.ok(root.permission.some((rule) => rule.permission === "edit" && rule.pattern === "/protected/*" && rule.action === "deny"));
    const child = fake.calls.find((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "existing-child")?.args as { permission: Array<{ permission: string; pattern: string; action: string }> };
    assert.ok(!child.permission.some((rule) => rule.permission === "bash" && rule.action === "allow"));
    assert.ok(child.permission.some((rule) => rule.pattern === "/child-private/*" && rule.action === "deny"));
  } finally { await session.shutdown(); }
});

test("resume refuses unowned root or descendant work before changing policies or MCP", async () => {
  for (const busy of ["session-fake", "child-1"]) {
    fake.reset(); fake.setChildren("session-fake", ["child-1"]); fake.setNativeStatus(busy, "busy");
    const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
    await assert.rejects(opencodeEngine.start({ ...params, resume: "session-fake", mcp: { url: "http://127.0.0.1:1/mcp", bearerToken: "synthetic" } }, host), /unowned/i);
    assert.ok(!fake.calls.some((call) => call.method === "update" || call.method === "mcp.add"));
  }
});

test("resume does not rewrite an unchanged root or child permission policy", async () => {
  fake.reset();
  const base = [{ permission: "*", pattern: "*", action: "allow" as const }, { permission: "external_directory", pattern: "*", action: "allow" as const }];
  for (const id of ["session-fake", "child-1"]) { fake.setNativePermission(id, base); fake.setNativeMetadata(id, { goatPermissionBase: base, goatSubagentDeny: false }); }
  fake.setChildren("session-fake", ["child-1"]);
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, resume: "session-fake" }, host);
  try { assert.ok(!fake.calls.some((call) => call.method === "update")); } finally { await session.shutdown(); }
});

test("resume leaves matching policies without GOAT metadata untouched", async () => {
  fake.reset();
  const base = [{ permission: "*", pattern: "*", action: "allow" as const }, { permission: "external_directory", pattern: "*", action: "allow" as const }];
  for (const id of ["session-fake", "child-1"]) fake.setNativePermission(id, base);
  fake.setChildren("session-fake", ["child-1"]);
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, resume: "session-fake" }, host);
  try { assert.ok(!fake.calls.some((call) => call.method === "update")); } finally { await session.shutdown(); }
});

test("metadata-less resume retains a native deny added after the unchanged base", async () => {
  fake.reset();
  const base = [{ permission: "*", pattern: "*", action: "allow" as const }, { permission: "external_directory", pattern: "*", action: "allow" as const }];
  fake.setNativePermission("session-fake", base);
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const first = await opencodeEngine.start({ ...params, resume: "session-fake" }, host);
  assert.ok(!fake.calls.some((call) => call.method === "update")); await first.shutdown();
  fake.setNativePermission("session-fake", [...base, { permission: "edit", pattern: "*", action: "deny" }]);
  const second = await opencodeEngine.start({ ...params, resume: "session-fake", runtimeMode: "approval-required" }, host);
  try {
    const update = fake.calls.findLast((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "session-fake")?.args as { permission: Array<{ permission: string; pattern: string; action: string }> };
    const edit = update.permission.filter((rule) => rule.permission === "edit" && rule.pattern === "*").at(-1);
    assert.equal(edit?.action, "deny");
  } finally { await second.shutdown(); }
});

test("unknown legacy permission bases retain denies and warn about discarded allows", async () => {
  fake.reset(); fake.setNativePermission("session-fake", [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "/private/*", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ]);
  const warnings: string[] = [];
  const host = { emit(_event: EngineEvent) {}, log(level: string, message: string) { if (level === "warn") warnings.push(message); }, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, resume: "session-fake", runtimeMode: "approval-required" }, host);
  try {
    const update = fake.calls.findLast((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "session-fake")?.args as { permission: Array<{ permission: string; pattern: string; action: string }> };
    assert.ok(update.permission.some((rule) => rule.pattern === "/private/*" && rule.action === "deny"));
    assert.ok(!update.permission.some((rule) => rule.permission === "bash" && rule.action === "allow"));
    assert.ok(warnings.some((message) => message.includes("session-fake") && message.includes("unverified allow overrides were dropped")));
  } finally { await session.shutdown(); }
});

test("unknown legacy permission bases retain scoped native approval requirements", async () => {
  fake.reset(); fake.setNativePermission("session-fake", [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "/sensitive/*", action: "ask" },
  ]);
  const warnings: string[] = [];
  const host = { emit(_event: EngineEvent) {}, log(level: string, message: string) { if (level === "warn") warnings.push(message); }, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, resume: "session-fake" }, host);
  try {
    const update = fake.calls.findLast((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "session-fake")?.args as { permission: Array<{ permission: string; pattern: string; action: string }> };
    assert.ok(update.permission.some((rule) => rule.permission === "bash" && rule.pattern === "/sensitive/*" && rule.action === "ask"));
    assert.ok(warnings.some((message) => message.includes("unverified allow overrides were dropped")));
  } finally { await session.shutdown(); }
});

test("resume checks idle before applying changed root and child policies", async () => {
  fake.reset(); fake.setChildren("session-fake", ["child-1"]);
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, resume: "session-fake", runtimeMode: "approval-required" }, host);
  try {
    const status = fake.calls.findIndex((call) => call.method === "status");
    const root = fake.calls.findIndex((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "session-fake");
    const child = fake.calls.findIndex((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "child-1");
    assert.ok(status >= 0 && root > status && child > root);
  } finally { await session.shutdown(); }
});

test("MCP status must confirm the GOAT server is connected", async () => {
  for (const status of ["failed", "disabled", "needs_auth", "missing"] as const) {
    fake.reset(); fake.setMcpStatus(status);
    const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
    await assert.rejects(opencodeEngine.start({ ...params, mcp: { url: "http://127.0.0.1:1/mcp", bearerToken: "synthetic" } }, host), /MCP/i);
    assert.ok(!fake.calls.some((call) => call.method === "prompt"));
  }
});

test("resume removes recorded inherited child policy from an earlier parent mode", async () => {
  fake.reset();
  const prior = [{ permission: "*", pattern: "*", action: "deny" as const }, { permission: "bash", pattern: "*", action: "deny" as const }];
  const current = [{ permission: "*", pattern: "*", action: "allow" as const }, { permission: "external_directory", pattern: "*", action: "allow" as const }];
  fake.setNativePermission("session-fake", current);
  fake.setNativeMetadata("session-fake", { goatPermissionBase: current, goatPreviousPermissionBases: [prior] });
  fake.setChildren("session-fake", ["child-1"]);
  fake.setNativePermission("child-1", [...prior, { permission: "edit", pattern: "/private/*", action: "deny" }]);
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, resume: "session-fake" }, host);
  try {
    const child = fake.calls.find((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "child-1")?.args as { permission: Array<{ permission: string; pattern: string; action: string }> };
    assert.ok(!child.permission.some((rule) => rule.permission === "*" && rule.action === "deny"));
    assert.ok(child.permission.some((rule) => rule.pattern === "/private/*" && rule.action === "deny"));
  } finally { await session.shutdown(); }
});

test("resume replaces a child's own recorded base without discarding its native deny", async () => {
  fake.reset(); const oldBase = [{ permission: "*", pattern: "*", action: "deny" as const }, { permission: "bash", pattern: "*", action: "deny" as const }];
  fake.setChildren("session-fake", ["child-1"]); fake.setNativePermission("child-1", [...oldBase, { permission: "edit", pattern: "/child-private/*", action: "deny" }]);
  fake.setNativeMetadata("child-1", { goatPermissionBase: oldBase });
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, resume: "session-fake" }, host);
  try {
    const child = fake.calls.find((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "child-1")?.args as { permission: Array<{ permission: string; pattern: string; action: string }> };
    assert.ok(!child.permission.some((rule) => rule.permission === "*" && rule.action === "deny"));
    assert.ok(child.permission.some((rule) => rule.pattern === "/child-private/*" && rule.action === "deny"));
  } finally { await session.shutdown(); }
});

test("resume records the previous permission base for later child reconciliation", async () => {
  fake.reset();
  const oldBase = [{ permission: "*", pattern: "*", action: "allow" as const }, { permission: "external_directory", pattern: "*", action: "allow" as const }];
  fake.setNativePermission("session-fake", oldBase); fake.setNativeMetadata("session-fake", { goatPermissionBase: oldBase }); fake.setChildren("session-fake", ["child-1"]);
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, resume: "session-fake", runtimeMode: "approval-required" }, host);
  try {
    const root = fake.calls.find((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "session-fake")?.args as { metadata: { goatPreviousPermissionBases?: unknown } };
    assert.deepEqual(root.metadata.goatPreviousPermissionBases, [oldBase]);
  } finally { await session.shutdown(); }
});

test("resume preserves a GOAT-owned subagent deny for existing children", async () => {
  fake.reset();
  const base = [{ permission: "*", pattern: "*", action: "allow" as const }, { permission: "external_directory", pattern: "*", action: "allow" as const }];
  const deny = { permission: "task", pattern: "*", action: "deny" as const };
  fake.setNativePermission("session-fake", [...base, deny]); fake.setNativeMetadata("session-fake", { goatPermissionBase: base, goatSubagentDeny: true }); fake.setChildren("session-fake", ["child-1"]);
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, resume: "session-fake" }, host);
  try {
    const child = fake.calls.find((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "child-1")?.args as { permission: unknown[] };
    assert.deepEqual(child.permission.at(-1), deny);
  } finally { await session.shutdown(); }
});

test("resume recognizes a previous permission base appended by the native server", async () => {
  fake.reset();
  const oldBase = [{ permission: "*", pattern: "*", action: "allow" as const }, { permission: "external_directory", pattern: "*", action: "allow" as const }];
  fake.setNativePermission("session-fake", [{ permission: "old-prefix", pattern: "*", action: "allow" }, ...oldBase, { permission: "edit", pattern: "/protected/*", action: "deny" }]);
  fake.setNativeMetadata("session-fake", { goatPermissionBase: [{ permission: "unmatched", pattern: "*", action: "ask" }], goatPreviousPermissionBases: [oldBase] });
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start({ ...params, resume: "session-fake", runtimeMode: "approval-required" }, host);
  try {
    const root = fake.calls.find((call) => call.method === "update" && (call.args as { sessionID?: string }).sessionID === "session-fake")?.args as { permission: Array<{ permission: string; pattern: string; action: string }> };
    assert.ok(!root.permission.some((rule) => rule.permission === "old-prefix" || (rule.permission === "*" && rule.action === "allow")));
    assert.ok(root.permission.some((rule) => rule.pattern === "/protected/*" && rule.action === "deny"));
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

test("JSONL steer response precedes its settlement and the turn terminal", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
    env: { ...process.env, GOAT2_ENGINE_HELPER_SDK_OPENCODE: fileURLToPath(new URL("./fakes/opencode-sdk.ts", import.meta.url)) }, stdio: ["pipe", "pipe", "ignore"],
  });
  const frames: Array<Record<string, unknown>> = [];
  const initialized = Promise.withResolvers<void>(); const started = Promise.withResolvers<string>(); const ready = Promise.withResolvers<void>(); const settled = Promise.withResolvers<void>(); const finished = Promise.withResolvers<void>(); const closed = Promise.withResolvers<void>();
  child.once("close", () => closed.resolve()); const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const frame = JSON.parse(line) as Record<string, unknown>; frames.push(frame);
    if (frame.id === 1) initialized.resolve();
    if (frame.id === 2) { const result = frame.result as { status?: string; turnId?: string }; if (result?.status === "accepted" && result.turnId) started.resolve(result.turnId); else started.reject(new Error("turn not accepted")); }
    if (frame.id === 3 && (frame.result as { status?: string } | undefined)?.status !== "accepted") settled.reject(new Error("steer not accepted"));
    const event = frame.event as { type?: string; item?: { type?: string } } | undefined;
    if (event?.type === "item_completed" && event.item?.type === "assistant_message") ready.resolve();
    if (event?.type === "steer_updated") settled.resolve();
    if (event?.type === "turn_finished") finished.resolve();
  });
  try {
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params })}\n`); await initialized.promise;
    child.stdin.write(`${JSON.stringify({ id: 2, method: "turn.start", params: { inputs: [{ inputId: "i", text: "hold-for-steer", attachments: [] }], settings } })}\n`);
    const turnId = await started.promise; await ready.promise;
    child.stdin.write(`${JSON.stringify({ id: 3, method: "turn.steer", params: { turnId, inputs: [{ inputId: "steer-jsonl", text: "inline-steer", attachments: [] }] } })}\n`);
    await settled.promise;
    child.stdin.write(`${JSON.stringify({ id: 4, method: "turn.interrupt", params: { turnId } })}\n`); await finished.promise;
    const response = frames.findIndex((frame) => frame.id === 3);
    const update = frames.findIndex((frame) => (frame.event as { type?: string } | undefined)?.type === "steer_updated");
    const terminal = frames.findIndex((frame) => (frame.event as { type?: string } | undefined)?.type === "turn_finished");
    assert.ok(response >= 0 && response < update && update < terminal);
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

test("interrupt stops native descendants before reporting completion", async () => {
  fake.reset(); const finished = Promise.withResolvers<void>(); const events: EngineEvent[] = [];
  const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host);
  fake.setChildren(session.engineRef, ["child-1"]); fake.setChildren("child-1", ["grandchild-1"]);
  const childAbort = fake.holdAbort("child-1");
  try {
    const turn = await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings);
    assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stopping = session.interrupt(turn.turnId); await childAbort.reached;
    await fake.sendEvent("session.idle", { sessionID: session.engineRef });
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
    childAbort.release(); await stopping; await finished.promise;
    const aborted = fake.calls.filter((call) => call.method === "abort").map((call) => (call.args as { sessionID: string }).sessionID);
    assert.deepEqual(aborted, [session.engineRef, "child-1", "grandchild-1"]);
  } finally { childAbort.release(); await session.shutdown(); }
});

test("a descendant abort failure fails the session rather than claiming interruption", async () => {
  fake.reset(); const events: EngineEvent[] = []; const failures: string[] = [];
  const host = { emit(event: EngineEvent) { events.push(event); }, log() {}, fail(reason: string) { failures.push(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host); fake.setChildren(session.engineRef, ["child-1"]); fake.failAbort("child-1");
  try {
    const turn = await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings);
    assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
    await assert.rejects(session.interrupt(turn.turnId), /OpenCode interrupt failed/);
    assert.deepEqual(failures, ["OpenCode interrupt could not be confirmed"]);
    const outcomes = events.filter((event) => event.type === "turn_finished");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.type === "turn_finished" && outcomes[0].outcome.type, "failed");
  } finally { await session.shutdown(); }
});

test("provider failure during descendant stop remains a failed outcome", async () => {
  fake.reset(); const events: EngineEvent[] = []; const finished = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host); fake.setChildren(session.engineRef, ["child-1"]); const child = fake.holdAbort("child-1");
  try {
    const turn = await session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings);
    assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
    await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } }); await new Promise<void>((resolve) => setImmediate(resolve));
    const stopping = session.interrupt(turn.turnId); await child.reached;
    await fake.sendEvent("session.error", { sessionID: session.engineRef, error: { name: "UnknownError", data: { message: "synthetic" } } });
    await fake.sendEvent("session.idle", { sessionID: session.engineRef });
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
    child.release(); await stopping; await finished.promise;
    const terminal = events.find((event) => event.type === "turn_finished");
    assert.equal(terminal?.type === "turn_finished" && terminal.outcome.type, "failed");
  } finally { child.release(); await session.shutdown(); }
});

test("failed history reconciliation waits for descendant interruption cleanup", async () => {
  fake.reset(); const events: EngineEvent[] = []; const finished = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const session = await opencodeEngine.start(params, host); fake.setChildren(session.engineRef, ["child-1"]);
  const prompt = fake.holdPrompt(); const history = fake.holdHistory(); const child = fake.holdAbort("child-1");
  try {
    const starting = session.startTurn([{ inputId: "i", text: "hold", attachments: [] }], settings); await prompt.reached;
    await fake.sendEvent("message.part.delta", { sessionID: session.engineRef, messageID: "assistant-early", partID: "part-early", field: "text", delta: "cat" });
    await fake.sendEvent("message.part.updated", { sessionID: session.engineRef, time: 1, part: { id: "part-early", sessionID: session.engineRef, messageID: "assistant-early", type: "text", text: "cat dog " } });
    await fake.sendEvent("message.updated", { sessionID: session.engineRef, info: { id: "assistant-early", sessionID: session.engineRef, role: "assistant", time: { created: 1 }, parentID: "input", providerID: "test", modelID: "model", mode: "build", agent: "build", path: { cwd: "/tmp", root: "/tmp" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } });
    prompt.release(); const turn = await starting; assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("turn not admitted");
    await fake.sendEvent("session.status", { sessionID: session.engineRef, status: { type: "busy" } });
    await fake.sendEvent("session.idle", { sessionID: session.engineRef }); await history.reached;
    const stopping = session.interrupt(turn.turnId); await child.reached;
    history.fail(); await history.finished; await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
    child.release(); await stopping; await finished.promise;
    const terminal = events.find((event) => event.type === "turn_finished");
    assert.equal(terminal?.type === "turn_finished" && terminal.outcome.type, "failed");
  } finally { prompt.release(); child.release(); await session.shutdown(); }
});
