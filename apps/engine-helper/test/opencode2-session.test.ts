import assert from "node:assert/strict";
import { test } from "node:test";
import type { EngineEvent, InitializeParams, TurnSettings } from "../src/protocol.ts";
import { OpenCode2Session } from "../src/engines/opencode2/session.ts";
import { scriptedRuntime } from "./fakes/opencode2-session.ts";
import { opencodeEngine } from "../src/engines/opencode/index.ts";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const modelSelection = { instanceId: "opencode", model: "test/model" };
const settings: TurnSettings = { modelSelection, runtimeMode: "full-access" };
const params: InitializeParams = { protocol: 1, engine: "opencode", threadId: "thread-v2", cwd: "/tmp", resume: null, modelSelection, runtimeMode: "full-access", mcp: null, instructions: null, launch: null };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function hostFor(events: EngineEvent[], failures: string[] = []) { return { emit(event: EngineEvent) { events.push(event); }, log() {}, fail(reason: string) { failures.push(reason); }, now: () => "2026-01-01T00:00:00Z" }; }
const input = (id: string, text: string) => [{ inputId: id, text, attachments: [] }];

test("OpenCode 2 creates, resumes and projects a streamed turn through native events", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const gate = fake.holdPrompt(); const starting = session.startTurn(input("i", "hello"), settings); await gate.reached;
    fake.emit("session.execution.started", { sessionID: session.engineRef });
    fake.emit("session.text.delta", { sessionID: session.engineRef, assistantMessageID: "m", ordinal: 0, delta: "Hello" });
    fake.emit("session.reasoning.ended", { sessionID: session.engineRef, assistantMessageID: "m", ordinal: 0, text: "Think" });
    fake.emit("session.text.ended", { sessionID: session.engineRef, assistantMessageID: "m", ordinal: 0, text: "Hello world" });
    fake.emit("session.execution.succeeded", { sessionID: session.engineRef });
    await tick(); assert.equal(events.length, 0); gate.release();
    const turn = await starting; assert.equal(turn.status, "accepted"); await tick(); await tick();
    const text = events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.text : "").join("");
    const reasoning = events.find((event) => event.type === "content_delta");
    assert.equal(text, "Hello world"); assert.equal(reasoning?.type === "content_delta" && reasoning.streamKind, "reasoning_text");
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "done").length, 1);
    assert.ok(fake.calls.some((call) => call.method === "session.create"));
  } finally { await session.shutdown(); }
  const resumed = scriptedRuntime(); const next = await OpenCode2Session.fromRuntime(resumed.runtime, { ...params, resume: "session-v2" }, hostFor([]));
  assert.ok(resumed.calls.some((call) => call.method === "session.get")); await next.shutdown();
});

test("OpenCode 2 steers settle before terminal including terminal followed by delivery", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    fake.emit("session.execution.started", { sessionID: session.engineRef }); await tick();
    assert.equal((await session.steer(turn.turnId, input("s", "steer"))).status, "accepted"); await tick();
    const steer = fake.calls.filter((call) => call.method === "session.prompt").at(-1)?.input as { id: string };
    fake.emit("session.execution.succeeded", { sessionID: session.engineRef });
    fake.emit("session.inbox.delivered", { sessionID: session.engineRef, inboxID: steer.id }); await tick();
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
    fake.emit("session.execution.started", { sessionID: session.engineRef }); fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await tick();
    const settled = events.findIndex((event) => event.type === "steer_updated" && event.status.type === "completed");
    const ended = events.findIndex((event) => event.type === "turn_finished"); assert.ok(settled >= 0 && ended > settled);
  } finally { await session.shutdown(); }
});

test("a bare /compact turn uses the native compaction request", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    assert.equal((await session.startTurn(input("i", "/compact"), settings)).status, "accepted"); await tick();
    assert.equal(fake.calls.filter((call) => call.method === "session.prompt").length, 0);
    const compact = fake.calls.find((call) => call.method === "session.compact")?.input as { sessionID: string; id: string };
    assert.equal(compact.sessionID, session.engineRef); assert.match(compact.id, /^msg_t3_turn_/);
    fake.emit("session.compaction.started", { sessionID: session.engineRef });
    fake.emit("session.compaction.ended", { sessionID: session.engineRef, text: "Summary" });
    fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await tick();
    assert.ok(events.some((event) => event.type === "item_completed" && event.item.type === "compaction"));
  } finally { await session.shutdown(); }
});

test("resuming a 2.x session follows the requested working directory", async () => {
  const fake = scriptedRuntime(); fake.setNativeDirectory("/old");
  const session = await OpenCode2Session.fromRuntime(fake.runtime, { ...params, resume: "session-v2" }, hostFor([]));
  try { assert.deepEqual(fake.calls.find((call) => call.method === "session.move")?.input, { sessionID: "session-v2", directory: "/tmp" }); }
  finally { await session.shutdown(); }
});

test("OpenCode 2 permissions and forms roundtrip on their asking session", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); await tick();
    fake.emit("permission.asked", { id: "p", sessionID: session.engineRef, action: "shell", resources: ["*"], save: ["*"] });
    fake.emit("form.created", { form: { id: "q", sessionID: session.engineRef, title: "Q", fields: [{ key: "answer", type: "string" }] } }); await tick();
    assert.equal(events.filter((event) => event.type === "request_opened").length, 2);
    await session.answerRequest("p", { outcome: "acceptForSession" }); await session.answerRequest("q", { outcome: "answered", answers: { answer: "yes" } });
    assert.deepEqual((fake.calls.find((call) => call.method === "session.form.reply")?.input as { answer: unknown }).answer, { answer: "yes" });
    assert.equal(events.filter((event) => event.type === "request_closed").length, 2);
  } finally { await session.shutdown(); }
});

test("OpenCode 2 applies runtime mode and model-only variant changes", async () => {
  const fake = scriptedRuntime(); const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor([]));
  try {
    const changed: TurnSettings = { runtimeMode: "approval-required", modelSelection: { ...modelSelection, options: [{ id: "variant", value: "high" }] } };
    await session.setConfig(changed); assert.ok(fake.calls.some((call) => call.method === "session.update"));
    const switchCall = fake.calls.find((call) => call.method === "session.switchModel")?.input as { model: { variant: string } }; assert.equal(switchCall.model.variant, "high");
  } finally { await session.shutdown(); }
});

test("start and steer send only existing native images while preserving attachment notices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goat-opencode2-attachment-")); const file = join(dir, "existing.png"); await writeFile(file, "fixture");
  const fake = scriptedRuntime(); const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor([]));
  const attachments = [
    { id: "existing", type: "image" as const, name: "existing.png", mimeType: "image/png", sizeBytes: 7, path: file },
    { id: "missing", type: "image" as const, name: "missing.png", mimeType: "image/png", sizeBytes: 7, path: join(dir, "missing.png") },
    { id: "file", type: "file" as const, name: "file.png", mimeType: "image/png", sizeBytes: 7, path: file },
    { id: "null", type: "image" as const, name: "null.png", mimeType: "image/png", sizeBytes: 7, path: null },
    { id: "unsupported", type: "image" as const, name: "vector.svg", mimeType: "image/svg+xml", sizeBytes: 7, path: file },
  ];
  try {
    const turn = await session.startTurn([{ inputId: "i", text: "hello", attachments }], settings);
    assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    assert.equal((await session.steer(turn.turnId, [{ inputId: "s", text: "more", attachments }])).status, "accepted");
    const prompts = fake.calls.filter((call) => call.method === "session.prompt").map((call) => call.input as { text: string; files: Array<{ name: string }> });
    for (const prompt of prompts) {
      assert.deepEqual(prompt.files.map((entry) => entry.name), ["existing.png"]);
      assert.match(prompt.text, /missing\.png.*saved at/); assert.match(prompt.text, /file\.png.*saved at/);
      assert.match(prompt.text, /null\.png.*unavailable/); assert.match(prompt.text, /vector\.svg.*saved at/);
    }
  } finally { await session.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test("create, setConfig and the next turn each send the chosen native variant", async () => {
  const fake = scriptedRuntime(); fake.setModels([{ providerID: "test", id: "model", variants: [{ id: "high" }, { id: "low" }], limit: { context: 1000 } }]);
  const choose = (variant: string): TurnSettings => ({ runtimeMode: "full-access", modelSelection: { ...modelSelection, options: [{ id: "variant", value: variant }] } });
  const session = await OpenCode2Session.fromRuntime(fake.runtime, { ...params, modelSelection: choose("high").modelSelection }, hostFor([]));
  try {
    assert.equal((fake.calls.find((call) => call.method === "session.create")?.input as { model: { variant: string } }).model.variant, "high");
    await session.setConfig(choose("low"));
    assert.equal((fake.calls.findLast((call) => call.method === "session.switchModel")?.input as { model: { variant: string } }).model.variant, "low");
    assert.equal((await session.startTurn(input("i", "hello"), choose("high"))).status, "accepted");
    assert.equal((fake.calls.findLast((call) => call.method === "session.switchModel")?.input as { model: { variant: string } }).model.variant, "high");
  } finally { await session.shutdown(); }
});

test("OpenCode 2 interrupts do not claim success before native confirmation", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    const gate = fake.holdInterrupt(); const interrupting = session.interrupt(turn.turnId); await gate.reached;
    fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await tick();
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
    gate.release(); await interrupting; await tick();
    const terminal = events.find((event) => event.type === "turn_finished"); assert.equal(terminal?.type === "turn_finished" && terminal.outcome.type, "interrupted");
  } finally { await session.shutdown(); }
});

test("selected OpenCode 2 runtime drives real SDK SSE decoding and a complete helper turn", async () => {
  const events: EngineEvent[] = []; const done = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") done.resolve(); }, log() {}, fail(reason: string) { done.reject(new Error(reason)); }, now: () => "2026-01-01T00:00:00Z" };
  const launch = { env: { GOAT2_ENGINE_HELPER_SDK_OPENCODE2: fileURLToPath(new URL("./fakes/opencode2-helper.ts", import.meta.url)) } };
  const session = await opencodeEngine.start({ ...params, launch }, host);
  try {
    const turn = await session.startTurn(input("i", "hello"), settings); assert.equal(turn.status, "accepted"); await done.promise;
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "done").length, 1);
    assert.equal(events.filter((event) => event.type === "item_completed" && event.item.type === "command_execution").length, 1);
    assert.ok(events.some((event) => event.type === "content_delta" && event.streamKind === "reasoning_text"));
    assert.ok(events.some((event) => event.type === "token_usage" && event.usage.usedTokens === 22));
  } finally { await session.shutdown(); }
});

test("malformed execution terminal through the real 2.x SSE decoder fails visibly", async () => {
  const events: EngineEvent[] = [], failures: string[] = []; const failed = Promise.withResolvers<void>();
  const host = { emit(event: EngineEvent) { events.push(event); }, log() {}, fail(reason: string) { failures.push(reason); failed.resolve(); }, now: () => "2026-01-01T00:00:00Z" };
  const launch = { env: { GOAT2_ENGINE_HELPER_SDK_OPENCODE2: fileURLToPath(new URL("./fakes/opencode2-helper.ts", import.meta.url)) } };
  const session = await opencodeEngine.start({ ...params, launch }, host);
  try {
    assert.equal((await session.startTurn(input("i", "bad-terminal"), settings)).status, "accepted"); await failed.promise;
    assert.deepEqual(failures, ["OpenCode 2 execution event could not be routed"]);
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
  } finally { await session.shutdown(); }
});

test("overlapping steers cannot release an old terminal after one delivery and one cancellation", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    fake.emit("session.execution.started", { sessionID: session.engineRef }); await tick();
    assert.equal((await session.steer(turn.turnId, input("a", "one"))).status, "accepted");
    assert.equal((await session.steer(turn.turnId, input("b", "two"))).status, "accepted"); await tick();
    const calls = fake.calls.filter((call) => call.method === "session.prompt");
    const a = (calls.at(-2)?.input as { id: string }).id, b = (calls.at(-1)?.input as { id: string }).id;
    fake.emit("session.execution.succeeded", { sessionID: session.engineRef });
    fake.emit("session.inbox.delivered", { sessionID: session.engineRef, inboxID: a });
    fake.emit("session.inbox.cancelled", { sessionID: session.engineRef, inboxID: b });
    fake.emit("session.inbox.delivered", { sessionID: session.engineRef, inboxID: a }); await tick();
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
    fake.emit("session.execution.started", { sessionID: session.engineRef });
    fake.emit("session.text.ended", { sessionID: session.engineRef, assistantMessageID: "next", ordinal: 0, text: "next" });
    fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await tick();
    const updates = events.flatMap((event) => event.type === "steer_updated" ? [[event.inputIds, event.status.type]] : []);
    assert.deepEqual(updates, [[["a"], "completed"], [["b"], "cancelled"]]);
    const end = events.findIndex((event) => event.type === "turn_finished");
    assert.ok(end > events.findLastIndex((event) => event.type === "steer_updated"));
  } finally { await session.shutdown(); }
});

test("an uncertain steer reply after native failure is never accepted or settled", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    const gate = fake.holdPrompt();
    try {
      const steering = session.steer(turn.turnId, input("s", "hold")); await gate.reached;
      fake.emit("session.execution.failed", { sessionID: session.engineRef, error: { type: "unknown", message: "synthetic" } }); await tick();
      assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
      gate.release(); assert.equal((await steering).status, "unknown"); await tick();
      assert.equal(events.filter((event) => event.type === "steer_updated").length, 0);
      assert.equal(events.filter((event) => event.type === "turn_finished").length, 1);
    } finally { gate.release(); }
  } finally { await session.shutdown(); }
});

test("OpenCode 2 passes the GOAT token and waits for first MCP tools on older servers", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const reached = Promise.withResolvers<number>(); const gate = Promise.withResolvers<void>();
  const wait = async (ms: number, signal: AbortSignal) => { reached.resolve(ms); await Promise.race([gate.promise, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }))]); };
  const session = await OpenCode2Session.fromRuntime(fake.runtime, { ...params, mcp: { url: "http://127.0.0.1:1/mcp", bearerToken: "synthetic-token" } }, hostFor(events), wait);
  try {
    const starting = session.startTurn(input("i", "hello"), settings); assert.equal(await reached.promise, 250);
    const add = fake.calls.find((call) => call.method === "mcp.add")?.input as { server: string; config: { headers: { Authorization: string } } };
    assert.equal(add.server, "goat-thread-v2"); assert.equal(add.config.headers.Authorization, "Bearer synthetic-token");
    assert.equal(fake.calls.filter((call) => call.method === "session.prompt").length, 0);
    gate.resolve(); assert.equal((await starting).status, "accepted");
  } finally { gate.resolve(); await session.shutdown(); }
  assert.ok(fake.calls.some((call) => call.method === "mcp.remove"));
});

test("shutdown during MCP readiness cannot release a later prompt", async () => {
  const fake = scriptedRuntime(); const reached = Promise.withResolvers<void>();
  const wait = async (_ms: number, signal: AbortSignal) => { reached.resolve(); await new Promise<never>((_, reject) => { if (signal.aborted) reject(new Error("cancelled")); else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }); };
  const session = await OpenCode2Session.fromRuntime(fake.runtime, { ...params, mcp: { url: "http://127.0.0.1:1/mcp", bearerToken: "synthetic-token" } }, hostFor([]), wait);
  const starting = session.startTurn(input("i", "hello"), settings); await reached.promise; await session.shutdown();
  assert.equal((await starting).status, "declined"); assert.equal(fake.calls.filter((call) => call.method === "session.prompt").length, 0);
});

test("OpenCode 2 reconnects, backfills the owned prompt and settles from native history", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const failures: string[] = []; const finished = Promise.withResolvers<void>();
  const host = { ...hostFor(events, failures), emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); } };
  const session = await OpenCode2Session.fromRuntime(fake.runtime, params, host, async () => {});
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); await tick();
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { id: string };
    fake.emit("session.execution.started", { sessionID: session.engineRef });
    fake.emit("session.text.delta", { sessionID: session.engineRef, assistantMessageID: "m", ordinal: 0, delta: "Hello" }); await tick();
    fake.setHistory([{ id: "idle", type: "idle", outcome: "succeeded", time: { created: 3 } }, { id: "m", type: "assistant", time: { created: 2, streamed: 3 }, content: [{ type: "text", text: "Hello world" }] }, { id: prompt.id, type: "user", text: "hold", time: { created: 1 } }]);
    fake.failReconnect(1); fake.breakStream(); await finished.promise;
    assert.equal(fake.calls.filter((call) => call.method === "reconnect").length, 2);
    assert.ok(fake.calls.some((call) => call.method === "message.list"));
    assert.equal(events.flatMap((event) => event.type === "text_delta" ? [event.text] : []).join(""), "Hello world");
    assert.equal(events.filter((event) => event.type === "item_completed" && event.item.type === "assistant_message").length, 1);
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "done").length, 1); assert.deepEqual(failures, []);
  } finally { await session.shutdown(); }
});

test("OpenCode 2 fails visibly when reconnect cannot establish the owned prompt", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const failures: string[] = [];
  const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures), async () => {});
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); await tick();
    fake.breakStream(); await tick(); await tick(); await tick();
    assert.deepEqual(failures, ["OpenCode 2 could not reconcile the event stream"]);
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
  } finally { await session.shutdown(); }
});

test("OpenCode 2 process exit fails only its own session", async () => {
  const one = scriptedRuntime(), two = scriptedRuntime(); const first: string[] = [], second: string[] = [];
  const a = await OpenCode2Session.fromRuntime(one.runtime, params, hostFor([], first));
  const b = await OpenCode2Session.fromRuntime(two.runtime, params, hostFor([], second));
  try { one.crash(); await tick(); assert.deepEqual(first, ["OpenCode 2 server exited"]); assert.deepEqual(second, []); assert.equal((await b.startTurn(input("i", "hold"), settings)).status, "accepted"); }
  finally { await a.shutdown(); await b.shutdown(); }
});

test("shutdown during native prompt admission returns unknown without a late acceptance", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  const gate = fake.holdPrompt();
  try {
    const starting = session.startTurn(input("i", "hold"), settings); await gate.reached;
    await session.shutdown(); assert.equal((await starting).status, "unknown");
    const count = events.length; gate.release(); await tick(); assert.equal(events.length, count);
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
  } finally { gate.release(); await session.shutdown(); }
});

test("a failed turn releases an unresolved steer as unknown before its HTTP reply", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    const gate = fake.holdPrompt();
    try {
      const steering = session.steer(turn.turnId, input("s", "hold")); await gate.reached;
      fake.emit("session.execution.failed", { sessionID: session.engineRef, error: { type: "unknown", message: "synthetic" } }); await tick();
      assert.equal((await steering).status, "unknown");
      const count = events.length; gate.release(); await tick(); assert.equal(events.length, count);
      assert.equal(events.filter((event) => event.type === "steer_updated").length, 0);
    } finally { gate.release(); }
  } finally { await session.shutdown(); }
});

test("unsettled accepted steering is cancelled before a bounded recovery failure", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const failures: string[] = [];
  const reached = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const wait = async (_ms: number, signal: AbortSignal) => { reached.resolve(); await Promise.race([gate.promise, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }))]); };
  const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures), wait);
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    fake.emit("session.execution.started", { sessionID: session.engineRef }); await tick();
    assert.equal((await session.steer(turn.turnId, input("s", "hold"))).status, "accepted"); await tick();
    fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await reached.promise;
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 0); gate.resolve(); await tick(); await tick();
    const settled = events.findIndex((event) => event.type === "steer_updated" && event.status.type === "cancelled");
    const terminal = events.findIndex((event) => event.type === "turn_finished" && event.outcome.type === "failed");
    assert.ok(settled >= 0 && terminal > settled); assert.deepEqual(failures, ["OpenCode 2 could not settle queued steering"]);
  } finally { gate.resolve(); await session.shutdown(); }
});

test("unowned OpenCode 2 work outside a turn fails visibly", async () => {
  const fake = scriptedRuntime(); const failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor([], failures));
  try { fake.emit("session.inbox.enqueued", { sessionID: session.engineRef, inboxID: "foreign", item: { type: "user", payload: { text: "external" }, delivery: "queue" } }); await tick(); assert.deepEqual(failures, ["OpenCode 2 started unowned work outside a GOAT turn"]); }
  finally { await session.shutdown(); }
});

test("unsupported OpenCode 2 form fails once and cannot terminate a later turn", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); await tick();
    fake.emit("form.created", { form: { id: "unsupported", sessionID: session.engineRef, title: "Q", fields: [{ key: "url", type: "external", url: "https://example.invalid" }] } }); await tick();
    assert.ok(fake.calls.some((call) => call.method === "session.form.cancel"));
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
    assert.equal((await session.startTurn(input("next", "hold"), settings)).status, "declined");
    fake.emit("session.execution.interrupted", { sessionID: session.engineRef, reason: "user" }); await tick();
    assert.equal((await session.startTurn(input("next", "hold"), settings)).status, "accepted");
  } finally { await session.shutdown(); }
});

test("pre-submission failures decline and never claim uncertain prompt delivery", async () => {
  for (const mode of ["active", "mcp"] as const) {
    const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, { ...params, mcp: { url: "http://127.0.0.1:1/mcp", bearerToken: "synthetic-token" } }, hostFor(events));
    try {
      if (mode === "active") fake.failActive(true); else fake.failMcp(true);
      const result = await session.startTurn(input("i", "hello"), settings);
      assert.equal(result.status, "declined", mode); assert.equal(fake.calls.filter((call) => call.method === "session.prompt").length, 0);
      assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
    } finally { await session.shutdown(); }
  }
});

test("an uncertain steer is cancelled before any later prompt, and cancellation failure blocks it", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    fake.failPrompt(new Error("synthetic connection reset")); assert.equal((await session.steer(turn.turnId, input("s", "steer"))).status, "unknown");
    fake.failPrompt(undefined); fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await tick();
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 1);
    const before = fake.calls.filter((call) => call.method === "session.prompt").length;
    fake.failCancel(true); const refused = await session.startTurn(input("n", "next"), settings);
    assert.equal(refused.status, "declined"); assert.match(refused.reason, /cancel.*earlier steer/);
    assert.equal(fake.calls.filter((call) => call.method === "session.prompt").length, before);
    fake.failCancel(false); assert.equal((await session.startTurn(input("n", "next"), settings)).status, "accepted");
    const cancel = fake.calls.findLastIndex((call) => call.method === "session.inbox.cancel");
    const prompt = fake.calls.findLastIndex((call) => call.method === "session.prompt"); assert.ok(cancel >= 0 && cancel < prompt);
  } finally { await session.shutdown(); }
});

test("unreadable execution terminal never silently strands an owned turn", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); await tick();
    fake.emit("session.execution.succeeded", {}); await tick();
    assert.deepEqual(failures, ["OpenCode 2 execution event could not be routed"]);
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
  } finally { await session.shutdown(); }
});

test("native subagent lifecycle keeps one identity and projects its terminal result", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    fake.emit("session.tool.input.started", { sessionID: session.engineRef, assistantMessageID: "m", id: "task", name: "subagent" });
    fake.emit("session.tool.called", { sessionID: session.engineRef, assistantMessageID: "m", id: "task", input: { prompt: "inspect", description: "Research" }, executed: true });
    fake.emit("session.tool.progress", { sessionID: session.engineRef, assistantMessageID: "m", id: "task", metadata: { sessionID: "child" } });
    fake.emit("session.execution.succeeded", { sessionID: "child" });
    fake.emit("session.tool.success", { sessionID: session.engineRef, assistantMessageID: "m", id: "task", executed: true, content: [{ type: "text", text: "result" }], metadata: { sessionID: "child" } });
    fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await tick();
    const states = events.filter((event) => event.type === "subagent_update").map((event) => event.type === "subagent_update" ? [event.subagentId, event.status] : []);
    assert.ok(states.some(([id, status]) => id === "task" && status === "running"));
    assert.ok(states.some(([id, status]) => id === "task" && status === "completed"));
    const result = events.find((event) => event.type === "item_completed" && event.item.type === "subagent");
    assert.ok(result?.type === "item_completed" && result.item.type === "subagent" && result.item.subagentId === "task" && result.item.result === "result");
  } finally { await session.shutdown(); }
});

test("background subagent work fails visibly if it outlives the GOAT turn", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures));
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    fake.emit("session.tool.input.started", { sessionID: session.engineRef, assistantMessageID: "m", id: "task", name: "subagent" });
    fake.emit("session.tool.called", { sessionID: session.engineRef, assistantMessageID: "m", id: "task", input: { prompt: "inspect", background: true }, executed: true });
    fake.emit("session.tool.success", { sessionID: session.engineRef, assistantMessageID: "m", id: "task", executed: true, content: [{ type: "text", text: "started" }], metadata: { sessionID: "child", status: "running" } });
    fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await tick();
    assert.deepEqual(failures, ["OpenCode 2 background subagent work cannot continue outside a GOAT turn"]);
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
  } finally { await session.shutdown(); }
});

test("OpenCode 2 maps native todo tool output and rejects an unmatched tool result", async () => {
  for (const malformed of [false, true]) {
    const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures));
    try {
      assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
      if (!malformed) {
        fake.emit("session.tool.input.started", { sessionID: session.engineRef, assistantMessageID: "m", id: "todo", name: "todowrite" });
        fake.emit("session.tool.called", { sessionID: session.engineRef, assistantMessageID: "m", id: "todo", input: {}, executed: true });
      }
      fake.emit("session.tool.success", { sessionID: session.engineRef, assistantMessageID: "m", id: "todo", executed: true, content: [{ type: "text", text: "saved" }], metadata: { todos: [{ content: "first", status: "in_progress" }, { content: "skip", status: "cancelled" }, { content: "done", status: "completed" }] } }); await tick();
      if (malformed) assert.deepEqual(failures, ["OpenCode 2 tool event has no matching start"]);
      else {
        const todo = events.find((event) => event.type === "item_completed" && event.item.type === "todo_list");
        assert.ok(todo?.type === "item_completed" && todo.item.type === "todo_list");
        assert.deepEqual(todo.item.steps.map((step) => [step.text, step.status]), [["first", "running"], ["done", "completed"]]);
      }
    } finally { await session.shutdown(); }
  }
});

test("shutdown during preparation does not perform later MCP or prompt work", async () => {
  for (const phase of ["active", "update"] as const) {
    const fake = scriptedRuntime(); const session = await OpenCode2Session.fromRuntime(fake.runtime, { ...params, mcp: { url: "http://127.0.0.1:1", bearerToken: "synthetic-token" } }, hostFor([]));
    const barrier = phase === "active" ? fake.holdActive() : fake.holdUpdate();
    try {
      const starting = session.startTurn(input("i", "hello"), { ...settings, runtimeMode: "approval-required" }); await barrier.reached;
      await session.shutdown(); barrier.release(); assert.equal((await starting).status, "declined");
      assert.equal(fake.calls.filter((call) => call.method === "mcp.add" || call.method === "session.prompt").length, 0, phase);
    } finally { barrier.release(); await session.shutdown(); }
  }
});

test("child approval grants stay scoped to the child and duplicate replies are rejected", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, { ...params, runtimeMode: "approval-required" }, hostFor(events));
  try {
    assert.equal((await session.startTurn(input("i", "hold"), { ...settings, runtimeMode: "approval-required" })).status, "accepted"); await tick();
    fake.emit("session.created", { sessionID: "child", parentID: session.engineRef });
    fake.emit("permission.asked", { id: "p-child", sessionID: "child", action: "shell", resources: ["child-only"], save: ["child-only"] }); await tick();
    const gate = fake.holdReply();
    try {
      const first = session.answerRequest("p-child", { outcome: "acceptForSession" }); await gate.reached;
      await assert.rejects(session.answerRequest("p-child", { outcome: "decline" }), /already being answered/);
      gate.release(); await first;
    } finally { gate.release(); }
    await session.setConfig({ ...settings, runtimeMode: "auto-accept-edits" });
    const updates = fake.calls.filter((call) => call.method === "session.update").map((call) => call.input as { sessionID: string; permissions: Array<{ resource: string; effect: string }> });
    assert.ok(updates.find((update) => update.sessionID === "child")?.permissions.some((rule) => rule.resource === "child-only" && rule.effect === "allow"));
    assert.ok(!updates.findLast((update) => update.sessionID === session.engineRef)?.permissions.some((rule) => rule.resource === "child-only"));
    assert.equal(fake.calls.filter((call) => call.method === "permission.reply").length, 1);
  } finally { await session.shutdown(); }
});

test("shutdown closes the runtime even if native interruption stalls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); await tick();
  const gate = fake.holdInterrupt();
  try {
    const closing = session.shutdown(); await gate.reached; t.mock.timers.tick(5_000); await closing;
    assert.ok(fake.calls.some((call) => call.method === "close"));
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "interrupted").length, 1);
  } finally { gate.release(); await session.shutdown(); }
});

test("reconnect restores and closes requests for owned active child sessions", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures), async () => {});
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); await tick();
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { id: string };
    fake.emit("session.created", { sessionID: "child", parentID: session.engineRef });
    fake.emit("permission.asked", { id: "stale", sessionID: "child", action: "shell", resources: ["*"] }); await tick();
    fake.setActive({ [session.engineRef]: { type: "running" }, child: { type: "running" } });
    fake.setHistory([{ id: prompt.id, type: "user", text: "hold", time: { created: 1 } }]);
    fake.setRequests([{ id: "child-permission", sessionID: "child", action: "shell", resources: ["*"] }]);
    fake.setForms("child", [{ id: "child-form", sessionID: "child", title: "Question", fields: [{ key: "answer", type: "string" }] }]);
    fake.breakStream(); await tick(); await tick(); await tick();
    const opened = events.flatMap((event) => event.type === "request_opened" ? [event.key] : []);
    assert.ok(opened.includes("child-permission") && opened.includes("child-form"));
    assert.ok(events.some((event) => event.type === "request_closed" && event.key === "stale"));
    await session.answerRequest("child-permission", { outcome: "accept" });
    await session.answerRequest("child-form", { outcome: "answered", answers: { answer: "yes" } });
    assert.deepEqual(failures, []);
  } finally { await session.shutdown(); }
});

test("recovery never reports a completed parent while a background child remains active", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures), async () => {});
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { id: string };
    fake.setActive({ child: { type: "running" } });
    fake.setHistory([{ id: "idle", type: "idle", outcome: "succeeded", time: { created: 3 } }, { id: "m", type: "assistant", time: { created: 2, streamed: 3 }, content: [{ type: "tool", id: "task", name: "subagent", executed: true, state: { status: "completed", input: { prompt: "inspect", background: true }, content: [{ type: "text", text: "started" }], metadata: { sessionID: "child", status: "running" } }, time: { created: 2 } }] }, { id: prompt.id, type: "user", text: "hold", time: { created: 1 } }]);
    fake.breakStream(); await tick(); await tick(); await tick();
    assert.deepEqual(failures, ["OpenCode 2 background subagent work cannot continue outside a GOAT turn"]);
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "done").length, 0);
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
  } finally { await session.shutdown(); }
});

test("native configuration failures do not expose provider error text", async () => {
  const fake = scriptedRuntime(); const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor([]));
  try {
    fake.failUpdate(true);
    await assert.rejects(session.setConfig({ ...settings, runtimeMode: "approval-required" }), (error: Error) => error.message === "OpenCode 2 configuration update failed" && !error.message.includes("synthetic-secret-token"));
  } finally { await session.shutdown(); }
});

test("a stalled active-session check declines before sending a prompt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = scriptedRuntime(); const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor([]));
  const gate = fake.holdActive();
  try {
    const starting = session.startTurn(input("i", "hello"), settings); await gate.reached;
    t.mock.timers.tick(5_000); assert.equal((await starting).status, "declined");
    assert.equal(fake.calls.filter((call) => call.method === "session.prompt").length, 0);
  } finally { gate.release(); await session.shutdown(); }
});

test("oversized events during admission fail the session without a false acceptance", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures));
  const gate = fake.holdPrompt();
  try {
    const starting = session.startTurn(input("i", "hold"), settings); await gate.reached;
    fake.emit("session.text.delta", { sessionID: session.engineRef, assistantMessageID: "m", ordinal: 0, delta: "x".repeat(4 * 1024 * 1024) }); await tick();
    assert.equal((await starting).status, "unknown"); assert.deepEqual(failures, ["OpenCode 2 admission event buffer exceeded its limit"]);
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
  } finally { gate.release(); await session.shutdown(); }
});

test("generated runtime credentials are redacted across streamed chunks", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [];
  (fake.runtime as unknown as { redactionSecrets: string[] }).redactionSecrets = ["synthetic-runtime-password"];
  const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    fake.emit("session.text.delta", { sessionID: session.engineRef, assistantMessageID: "m", ordinal: 0, delta: "synthetic-runtime-" });
    fake.emit("session.text.ended", { sessionID: session.engineRef, assistantMessageID: "m", ordinal: 0, text: "synthetic-runtime-password" });
    fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await tick();
    assert.equal(events.flatMap((event) => event.type === "text_delta" ? [event.text] : []).join(""), "[redacted]");
    assert.ok(!JSON.stringify(events).includes("synthetic-runtime-password"));
  } finally { await session.shutdown(); }
});

test("a first compact turn does not consume the first-message preamble", async () => {
  const fake = scriptedRuntime(); const session = await OpenCode2Session.fromRuntime(fake.runtime, { ...params, instructions: { firstMessagePreamble: "REQUIRED-PREAMBLE" } }, hostFor([]));
  try {
    assert.equal((await session.startTurn(input("i", "/compact"), settings)).status, "accepted"); await tick();
    fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await tick();
    assert.equal((await session.startTurn(input("j", "hello"), settings)).status, "accepted");
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { text: string };
    assert.match(prompt.text, /REQUIRED-PREAMBLE/);
  } finally { await session.shutdown(); }
});

test("interrupt waits for active child interruption before settling the parent", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    fake.emit("session.created", { sessionID: "child", parentID: session.engineRef }); await tick(); fake.setActive({ child: { type: "running" } });
    const gate = fake.holdInterrupt();
    try {
      const stopping = session.interrupt(turn.turnId); await gate.reached;
      fake.emit("session.execution.interrupted", { sessionID: session.engineRef, reason: "user" }); await tick();
      assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
      gate.release(); await stopping; await tick();
      const interrupted = fake.calls.filter((call) => call.method === "session.interrupt").map((call) => (call.input as { sessionID: string }).sessionID);
      assert.ok(interrupted.includes("child") && interrupted.includes(session.engineRef));
      assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "interrupted").length, 1);
    } finally { gate.release(); }
  } finally { await session.shutdown(); }
});

test("an unconfirmed child interruption fails the session instead of claiming success", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    fake.emit("session.created", { sessionID: "child", parentID: session.engineRef }); await tick(); fake.setActive({ child: { type: "running" } }); fake.failInterrupt("child");
    await assert.rejects(session.interrupt(turn.turnId), /interrupt failed/);
    assert.deepEqual(failures, ["OpenCode 2 could not stop native child work"]);
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
  } finally { await session.shutdown(); }
});

test("reconnect recovers a newly created child from running tool history", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures), async () => {});
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { id: string };
    fake.setActive({ [session.engineRef]: { type: "running" }, child: { type: "running" } });
    fake.setHistory([{ id: "m", type: "assistant", time: { created: 2 }, content: [{ type: "tool", id: "task", name: "subagent", state: { status: "running", input: { prompt: "inspect" }, metadata: { sessionID: "child" } }, time: { created: 2 } }] }, { id: prompt.id, type: "user", text: "hold", time: { created: 1 } }]);
    fake.setRequests([{ id: "child-permission", sessionID: "child", action: "shell", resources: ["*"] }]);
    fake.setForms("child", [{ id: "child-form", sessionID: "child", title: "Q", fields: [{ key: "answer", type: "string" }] }]);
    fake.breakStream(); await tick(); await tick(); await tick();
    const opened = events.flatMap((event) => event.type === "request_opened" ? [event.key] : []);
    assert.ok(opened.includes("child-permission") && opened.includes("child-form"));
    assert.ok(events.some((event) => event.type === "subagent_update" && event.subagentId === "task" && event.status === "running")); assert.deepEqual(failures, []);
  } finally { await session.shutdown(); }
});

test("reconnect restores completed compaction and invalidates earlier usage", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const finished = Promise.withResolvers<void>();
  const host = { ...hostFor(events), emit(event: EngineEvent) { events.push(event); if (event.type === "turn_finished") finished.resolve(); } };
  const session = await OpenCode2Session.fromRuntime(fake.runtime, params, host, async () => {});
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { id: string };
    fake.emit("session.step.ended", { sessionID: session.engineRef, assistantMessageID: "m", tokens: { input: 7, output: 8, reasoning: 2, cache: { read: 3, write: 4 } } }); await tick();
    fake.setHistory([{ id: "idle", type: "idle", outcome: "succeeded", time: { created: 4 } }, { id: "compact", type: "compaction", status: "completed", summary: "Summary", recent: "", reason: "auto", time: { created: 3 } }, { id: prompt.id, type: "user", text: "hold", time: { created: 1 } }]);
    fake.breakStream(); await finished.promise;
    assert.equal(events.filter((event) => event.type === "item_completed" && event.item.type === "compaction").length, 1);
    assert.equal(events.filter((event) => event.type === "token_usage").length, 0);
  } finally { await session.shutdown(); }
});

test("interrupt includes a child discovered while the root stop is in flight", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    const gate = fake.holdInterrupt();
    try {
      const stopping = session.interrupt(turn.turnId); await gate.reached;
      await assert.rejects(session.interrupt(turn.turnId), /already pending/);
      fake.emit("session.created", { sessionID: "late-child", parentID: session.engineRef });
      fake.setActive({ "late-child": { type: "running" } });
      fake.emit("session.execution.interrupted", { sessionID: session.engineRef, reason: "user" }); await tick();
      assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
      gate.release(); await stopping; await tick();
      const interrupted = fake.calls.filter((call) => call.method === "session.interrupt").map((call) => (call.input as { sessionID: string }).sessionID);
      assert.ok(interrupted.includes(session.engineRef) && interrupted.includes("late-child"));
      assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "interrupted").length, 1);
    } finally { gate.release(); }
  } finally { await session.shutdown(); }
});

test("child interrupt acknowledgement alone does not settle a still-active child", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const waitReached = Promise.withResolvers<void>(), waitGate = Promise.withResolvers<void>();
  const wait = async (_ms: number, signal: AbortSignal) => { waitReached.resolve(); await Promise.race([waitGate.promise, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }))]); };
  const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events), wait);
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    fake.emit("session.created", { sessionID: "child", parentID: session.engineRef }); await tick(); fake.setActive({ child: { type: "running" } }); fake.keepActive("child");
    const stopping = session.interrupt(turn.turnId); await tick();
    fake.emit("session.execution.interrupted", { sessionID: session.engineRef, reason: "user" }); await tick();
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
    await waitReached.promise; fake.setActive({}); waitGate.resolve(); await stopping; await tick();
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "interrupted").length, 1);
  } finally { waitGate.resolve(); await session.shutdown(); }
});

test("child stop confirmation deadline fails the session visibly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const waiting = Promise.withResolvers<void>();
  const wait = async (_ms: number, signal: AbortSignal) => { waiting.resolve(); await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); };
  const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures), wait);
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    fake.emit("session.created", { sessionID: "child", parentID: session.engineRef }); await tick(); fake.setActive({ child: { type: "running" } }); fake.keepActive("child");
    const stopping = session.interrupt(turn.turnId); await waiting.promise; t.mock.timers.tick(10_000);
    await assert.rejects(stopping, /interrupt failed/);
    assert.deepEqual(failures, ["OpenCode 2 could not stop native child work"]);
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
  } finally { await session.shutdown(); }
});

test("reconnect discovers an active child even before tool metadata names it", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures), async () => {});
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { id: string };
    fake.setActive({ [session.engineRef]: { type: "running" }, child: { type: "running" }, foreign: { type: "running" } }); fake.setParent("child", session.engineRef);
    fake.setHistory([{ id: "m", type: "assistant", time: { created: 2 }, content: [{ type: "tool", id: "task", name: "subagent", state: { status: "streaming", input: {} }, time: { created: 2 } }] }, { id: prompt.id, type: "user", text: "hold", time: { created: 1 } }]);
    fake.setRequests([{ id: "child-permission", sessionID: "child", action: "shell", resources: ["*"] }, { id: "foreign-permission", sessionID: "foreign", action: "shell", resources: ["*"] }]);
    fake.breakStream(); await tick(); await tick(); await tick();
    const opened = events.flatMap((event) => event.type === "request_opened" ? [event.key] : []);
    assert.ok(opened.includes("child-permission")); assert.ok(!opened.includes("foreign-permission")); assert.deepEqual(failures, []);
  } finally { await session.shutdown(); }
});

test("each 2.x todowrite call publishes one uniquely keyed snapshot", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    for (const [id, status] of [["todo-a", "in_progress"], ["todo-b", "completed"]]) {
      fake.emit("session.tool.input.started", { sessionID: session.engineRef, assistantMessageID: "m", id, name: "todowrite" });
      fake.emit("session.tool.called", { sessionID: session.engineRef, assistantMessageID: "m", id, input: {}, executed: true });
      fake.emit("session.tool.success", { sessionID: session.engineRef, assistantMessageID: "m", id, executed: true, content: [{ type: "text", text: "saved" }], metadata: { todos: [{ content: "work", status }] } });
    }
    await tick();
    const items = events.flatMap((event) => event.type === "item_completed" && event.item.type === "todo_list" ? [event.item] : []);
    assert.deepEqual(items.map((entry) => entry.id), ["todo-a", "todo-b"]);
    assert.deepEqual(items.map((entry) => entry.steps[0]?.status), ["running", "completed"]);
    assert.equal(new Set(items.map((entry) => entry.id)).size, items.length);
  } finally { await session.shutdown(); }
});

test("reconnect buffers new execution activity before applying an older idle snapshot", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures), async () => {});
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); await tick();
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { id: string };
    fake.setHistory([{ id: "idle", type: "idle", outcome: "succeeded", time: { created: 2 } }, { id: prompt.id, type: "user", text: "hold", time: { created: 1 } }]);
    const history = fake.holdHistory();
    try {
      fake.breakStream(); await history.reached;
      fake.emit("session.execution.started", { sessionID: session.engineRef }); await tick(); history.release(); await tick(); await tick();
      assert.equal(events.filter((event) => event.type === "turn_finished").length, 0); assert.deepEqual(failures, []);
      fake.emit("session.text.ended", { sessionID: session.engineRef, assistantMessageID: "m", ordinal: 0, text: "new work" });
      fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await tick();
      assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "done").length, 1);
    } finally { history.release(); }
  } finally { await session.shutdown(); }
});

test("reconnect backfill and buffered compaction events yield one completed item", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures), async () => {});
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { id: string };
    fake.setActive({ [session.engineRef]: { type: "running" } });
    fake.setHistory([{ id: "msg_123", type: "compaction", status: "completed", summary: "Summary", recent: "", reason: "auto", time: { created: 2 } }, { id: prompt.id, type: "user", text: "hold", time: { created: 1 } }]);
    const history = fake.holdHistory();
    try {
      fake.breakStream(); await history.reached;
      fake.emit("session.compaction.started", { sessionID: session.engineRef, reason: "auto", recent: "" }, { id: "evt_123" });
      fake.emit("session.compaction.ended", { sessionID: session.engineRef, reason: "auto", text: "Summary", recent: "" }, { id: "evt_124" });
      await tick(); history.release(); await tick(); await tick();
      assert.equal(events.filter((event) => event.type === "item_completed" && event.item.type === "compaction").length, 1); assert.deepEqual(failures, []);
    } finally { history.release(); }
  } finally { await session.shutdown(); }
});

test("a child restarted during root interruption is stopped again", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    fake.emit("session.created", { sessionID: "child", parentID: session.engineRef }); fake.setActive({ child: { type: "running" } }); await tick();
    const gate = fake.holdInterrupt(session.engineRef);
    try {
      const stopping = session.interrupt(turn.turnId); await gate.reached;
      fake.setActive({ child: { type: "running" } }); fake.emit("session.execution.started", { sessionID: "child" });
      fake.emit("session.execution.interrupted", { sessionID: session.engineRef, reason: "user" }); await tick(); gate.release(); await stopping; await tick();
      const childStops = fake.calls.filter((call) => call.method === "session.interrupt" && (call.input as { sessionID: string }).sessionID === "child");
      assert.equal(childStops.length, 2);
      assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "interrupted").length, 1);
    } finally { gate.release(); }
  } finally { await session.shutdown(); }
});

test("a replayed terminal waits for a later buffered execution start", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures), async () => {});
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { id: string };
    fake.setHistory([{ id: "idle", type: "idle", outcome: "succeeded", time: { created: 2 } }, { id: prompt.id, type: "user", text: "hold", time: { created: 1 } }]);
    const history = fake.holdHistory();
    try {
      fake.breakStream(); await history.reached;
      fake.emit("session.execution.succeeded", { sessionID: session.engineRef });
      fake.emit("session.execution.started", { sessionID: session.engineRef }); await tick(); history.release(); await tick(); await tick();
      assert.equal(events.filter((event) => event.type === "turn_finished").length, 0); assert.deepEqual(failures, []);
      fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await tick();
      assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "done").length, 1);
    } finally { history.release(); }
  } finally { await session.shutdown(); }
});

test("a completed subagent recovered from history is not reopened by replayed tool events", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events), async () => {});
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { id: string };
    fake.setActive({ [session.engineRef]: { type: "running" } });
    fake.setHistory([{ id: "m", type: "assistant", time: { created: 2, streamed: 3 }, content: [{ type: "tool", id: "task", name: "subagent", executed: true, state: { status: "completed", input: { prompt: "inspect" }, content: [{ type: "text", text: "result" }], metadata: { sessionID: "child" } }, time: { created: 2 } }] }, { id: prompt.id, type: "user", text: "hold", time: { created: 1 } }]);
    const history = fake.holdHistory();
    try {
      fake.breakStream(); await history.reached;
      fake.emit("session.tool.input.started", { sessionID: session.engineRef, assistantMessageID: "m", id: "task", name: "subagent" });
      fake.emit("session.tool.called", { sessionID: session.engineRef, assistantMessageID: "m", id: "task", input: { prompt: "inspect" }, executed: true });
      fake.emit("session.tool.success", { sessionID: session.engineRef, assistantMessageID: "m", id: "task", executed: true, content: [{ type: "text", text: "result" }], metadata: { sessionID: "child" } });
      await tick(); history.release(); await tick(); await tick();
      const states = events.flatMap((event) => event.type === "subagent_update" && event.subagentId === "task" ? [event.status] : []);
      assert.deepEqual(states, ["completed"]);
      assert.equal(events.filter((event) => event.type === "item_completed" && event.item.type === "subagent").length, 1);
    } finally { history.release(); }
  } finally { await session.shutdown(); }
});

test("conflicting terminal text during replay fails the owning session visibly", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures), async () => {});
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { id: string };
    fake.setActive({ [session.engineRef]: { type: "running" } });
    fake.setHistory([{ id: "m", type: "assistant", time: { created: 2, streamed: 3 }, content: [{ type: "text", text: "snapshot" }] }, { id: prompt.id, type: "user", text: "hold", time: { created: 1 } }]);
    const history = fake.holdHistory();
    try {
      fake.breakStream(); await history.reached;
      fake.emit("session.text.ended", { sessionID: session.engineRef, assistantMessageID: "m", ordinal: 0, text: "different" }); await tick(); history.release(); await tick(); await tick();
      assert.deepEqual(failures, ["OpenCode 2 event content conflicted with recovered history"]);
      assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
    } finally { history.release(); }
  } finally { await session.shutdown(); }
});

test("second child check detects a restart even if its start event is delayed", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    fake.emit("session.created", { sessionID: "child", parentID: session.engineRef }); fake.setActive({ child: { type: "running" } }); await tick();
    const gate = fake.holdInterrupt(session.engineRef);
    try {
      const stopping = session.interrupt(turn.turnId); await gate.reached;
      fake.setActive({ child: { type: "running" } }); fake.emit("session.execution.interrupted", { sessionID: session.engineRef, reason: "user" }); await tick();
      gate.release(); await stopping; await tick();
      assert.equal(fake.calls.filter((call) => call.method === "session.interrupt" && (call.input as { sessionID: string }).sessionID === "child").length, 2);
    } finally { gate.release(); }
  } finally { await session.shutdown(); }
});

test("interrupt rescans children restarted while recovery events are buffered", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures), async () => {});
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    const prompt = fake.calls.find((call) => call.method === "session.prompt")?.input as { id: string };
    fake.emit("session.created", { sessionID: "a", parentID: session.engineRef }); fake.emit("session.created", { sessionID: "b", parentID: session.engineRef }); await tick();
    fake.setActive({ [session.engineRef]: { type: "running" } }); fake.setHistory([{ id: prompt.id, type: "user", text: "hold", time: { created: 1 } }]);
    const history = fake.holdHistory(); fake.breakStream(); await history.reached;
    const root = fake.holdInterrupt(session.engineRef);
    try {
      const stopping = session.interrupt(turn.turnId); await root.reached;
      fake.setActive({ a: { type: "running" }, b: { type: "running" } }); root.release();
      const childB = fake.holdInterrupt("b");
      try {
        await childB.reached; fake.setActive({ a: { type: "running" }, b: { type: "running" } });
        fake.emit("session.execution.started", { sessionID: "a" }); fake.emit("session.execution.interrupted", { sessionID: session.engineRef, reason: "user" }); await tick();
        childB.release(); await stopping;
        assert.equal(fake.calls.filter((call) => call.method === "session.interrupt" && (call.input as { sessionID: string }).sessionID === "a").length, 2);
        history.release(); await tick(); await tick();
        assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "interrupted").length, 1, JSON.stringify({ events, failures }));
        assert.deepEqual(failures, []);
      } finally { childB.release(); }
    } finally { root.release(); history.release(); }
  } finally { await session.shutdown(); }
});

test("a still-running native child prevents a successful parent terminal", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures));
  try {
    assert.equal((await session.startTurn(input("i", "hold"), settings)).status, "accepted"); await tick();
    fake.emit("session.created", { sessionID: "child", parentID: session.engineRef });
    fake.emit("session.execution.started", { sessionID: "child" });
    fake.emit("session.execution.succeeded", { sessionID: session.engineRef }); await tick();
    assert.deepEqual(failures, ["OpenCode 2 background subagent work cannot continue outside a GOAT turn"]);
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "done").length, 0);
  } finally { await session.shutdown(); }
});

test("resume waits for a stale form cancellation terminal before a new turn", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [];
  fake.setForms("session-v2", [{ id: "old-form", sessionID: "session-v2", title: "Q", fields: [{ key: "answer", type: "string" }] }]);
  const session = await OpenCode2Session.fromRuntime(fake.runtime, { ...params, resume: "session-v2" }, hostFor(events));
  try {
    assert.ok(fake.calls.some((call) => call.method === "session.form.cancel"));
    assert.equal((await session.startTurn(input("i", "hello"), settings)).status, "declined");
    fake.emit("session.execution.interrupted", { sessionID: session.engineRef, reason: "user" }); await tick();
    assert.equal((await session.startTurn(input("i", "hello"), settings)).status, "accepted");
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
  } finally { await session.shutdown(); }
});

test("a stale form without a native terminal fails visibly after a bounded wait", async () => {
  const fake = scriptedRuntime(); const failures: string[] = []; const reached = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  fake.setForms("session-v2", [{ id: "old-form", sessionID: "session-v2", title: "Q", fields: [{ key: "answer", type: "string" }] }]);
  const wait = async (_ms: number, signal: AbortSignal) => { reached.resolve(); await Promise.race([gate.promise, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }))]); };
  const session = await OpenCode2Session.fromRuntime(fake.runtime, { ...params, resume: "session-v2" }, hostFor([], failures), wait);
  try { await reached.promise; gate.resolve(); await tick(); assert.deepEqual(failures, ["OpenCode 2 cancelled form did not settle"]); }
  finally { gate.resolve(); await session.shutdown(); }
});

test("resume waits for a stale permission rejection terminal before a new turn", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [];
  fake.setRequests([{ id: "old-permission", sessionID: "session-v2", action: "shell", resources: ["*"] }]);
  const session = await OpenCode2Session.fromRuntime(fake.runtime, { ...params, resume: "session-v2" }, hostFor(events));
  try {
    assert.ok(fake.calls.some((call) => call.method === "permission.reply"));
    assert.equal((await session.startTurn(input("i", "hello"), settings)).status, "declined");
    fake.emit("session.execution.interrupted", { sessionID: session.engineRef, reason: "user" }); await tick();
    assert.equal((await session.startTurn(input("i", "hello"), settings)).status, "accepted");
    assert.equal(events.filter((event) => event.type === "turn_finished").length, 0);
  } finally { await session.shutdown(); }
});

test("a child that starts after interrupt confirmation prevents a false interrupted terminal", async () => {
  const fake = scriptedRuntime(); const events: EngineEvent[] = [], failures: string[] = []; const session = await OpenCode2Session.fromRuntime(fake.runtime, params, hostFor(events, failures));
  try {
    const turn = await session.startTurn(input("i", "hold"), settings); assert.equal(turn.status, "accepted"); if (turn.status !== "accepted") throw new Error("not admitted"); await tick();
    fake.emit("session.created", { sessionID: "child", parentID: session.engineRef }); await tick(); await session.interrupt(turn.turnId);
    fake.setActive({ child: { type: "running" } }); fake.emit("session.execution.started", { sessionID: "child" });
    fake.emit("session.execution.interrupted", { sessionID: session.engineRef, reason: "user" }); await tick();
    assert.deepEqual(failures, ["OpenCode 2 background subagent work cannot continue outside a GOAT turn"]);
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "interrupted").length, 0);
    assert.equal(events.filter((event) => event.type === "turn_finished" && event.outcome.type === "failed").length, 1);
  } finally { await session.shutdown(); }
});
