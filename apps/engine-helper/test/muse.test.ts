import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createMuseHost, museEnvironment, museServeArgs } from "../src/engines/muse/sdk.ts";
import * as fixture from "./fakes/muse-sdk.ts";

const fixturePath = fileURLToPath(new URL("./fakes/muse-sdk.ts", import.meta.url));

test("Muse SDK host configures and closes the handshake", async () => {
  fixture.reset();
  process.env.GOAT2_ENGINE_HELPER_SDK_MUSE = fixturePath;
  try {
    const { close } = await createMuseHost({ binary: "fixture", args: ["--flag"], cwd: "/tmp", env: { meta_api_key: "private", TEST: "value" }, fullAccess: true });
    assert.deepEqual(fixture.launches[0], { command: "fixture", args: ["--flag", "serve", "--trust-workspace", "--disable-sandbox"], cwd: "/tmp", env: { TEST: "value", MUSE_NO_AUTO_UPDATE: "1" }, shutdownTimeoutMs: 10000 });
    assert.deepEqual(fixture.calls[1], { clientInfo: { name: "t3_code", title: "T3 Code", version: "1" }, capabilities: { requestedCapabilities: ["sessionMcp"] } });
    await Promise.all([close(), close()]);
    assert.equal(fixture.closes, 1);
  } finally { delete process.env.GOAT2_ENGINE_HELPER_SDK_MUSE; }
});

test("failed handshake closes the child", async () => {
  fixture.reset();
  process.env.GOAT2_ENGINE_HELPER_SDK_MUSE = fixturePath;
  process.env.GOAT2_MUSE_FAKE_FAIL = "1";
  try {
    await assert.rejects(createMuseHost({ binary: "fixture" }), /fixture failure/);
    assert.equal(fixture.closes, 1);
  } finally {
    delete process.env.GOAT2_ENGINE_HELPER_SDK_MUSE;
    delete process.env.GOAT2_MUSE_FAKE_FAIL;
  }
});

test("Muse serve defaults and environment are safe", () => {
  assert.deepEqual(museServeArgs(false), ["serve", "--trust-workspace"]);
  assert.deepEqual(museEnvironment({ META_API_KEY: "private", HOME: "/tmp" }), { HOME: "/tmp", MUSE_NO_AUTO_UPDATE: "1" });
});

import { museEngine } from "../src/engines/muse/index.ts";
import type { EngineEvent, InitializeParams } from "../src/protocol.ts";
const init: InitializeParams = { protocol: 1, engine: "muse", threadId: "t", cwd: "/tmp", resume: null, modelSelection: { instanceId: "muse", model: "muse-example" }, runtimeMode: "full-access", mcp: { url: "http://127.0.0.1:9/mcp", bearerToken: "dummy" }, instructions: { appendSystemPrompt: "system text", firstMessagePreamble: "first text" }, launch: { binary: process.execPath, args: [], env: {} } };
const settings = { modelSelection: init.modelSelection, runtimeMode: init.runtimeMode };
const input = (text: string) => [{ inputId: "i", text, attachments: [] }];
function setup() {
  fixture.reset();
  process.env.GOAT2_ENGINE_HELPER_SDK_MUSE = fixturePath;
  const events: EngineEvent[] = [];
  const host = { emit: (event: EngineEvent) => events.push(event), fail: (reason: string) => { throw new Error(reason); }, log: () => {}, now: () => "2026-01-01T00:00:00Z" };
  const wait = async (predicate: (event: EngineEvent) => boolean) => {
    for (let n = 0; n < 100; n++) { const found = events.find(predicate); if (found) return found; await new Promise((resolve) => setTimeout(resolve, 5)); }
    throw new Error("Expected Muse event did not arrive");
  };
  return { host, events, wait };
}

test("turn streams, projects tool, injects MCP and preamble once, and resumes", async () => {
  const h = setup();
  const session = await museEngine.start(init, h.host);
  const sessionCall = fixture.calls.find((c) => c.method === "session/start")!;
  assert.deepEqual(sessionCall.params.config.mcpServers.goat, { transport: "streamableHttp", mode: "optional", url: init.mcp!.url, headers: { Authorization: "Bearer dummy" } });
  const first = await session.startTurn(input("hello"), settings);
  assert.equal(first.status, "accepted");
  await h.wait((e) => e.type === "turn_finished");
  assert.equal(h.events.filter((e) => e.type === "turn_finished").length, 1);
  assert.equal(h.events.filter((e) => e.type === "text_delta").map((e) => e.type === "text_delta" ? e.text : "").join(""), "hello");
  assert.ok(h.events.some((e) => e.type === "item_completed" && e.item.type === "dynamic_tool" && e.item.toolName === "goat_call" && e.item.toolSummary === "Read thread"));
  const start = fixture.calls.find((c) => c.method === "turn/start")!;
  assert.equal(start.params.input[0].text, "system text\n\nfirst text");
  await session.shutdown();
  const resumed = await museEngine.start({ ...init, resume: session.engineRef }, h.host);
  await resumed.startTurn(input("hello"), settings);
  assert.equal(fixture.calls.findLast((c) => c.method === "session/resume")?.params.sessionId, session.engineRef);
  assert.equal(fixture.calls.findLast((c) => c.method === "turn/start")?.params.input[0].text, "hello");
  await resumed.shutdown();
});

test("steer and interrupt target the active turn", async () => {
  const h = setup(); const session = await museEngine.start(init, h.host);
  const started = await session.startTurn(input("hold"), settings);
  assert.equal(started.status, "accepted"); if (started.status !== "accepted") throw new Error("not started");
  assert.equal((await session.steer(started.turnId, input("more"))).status, "accepted");
  assert.equal((await session.steer("other", input("more"))).status, "declined");
  await session.interrupt(started.turnId);
  const finished = await h.wait((e) => e.type === "turn_finished");
  assert.deepEqual(finished.type === "turn_finished" && finished.outcome, { type: "interrupted" });
  const settled = h.events.findIndex((e) => e.type === "steer_updated");
  assert.deepEqual(h.events[settled], { type: "steer_updated", turnId: started.turnId, inputIds: ["i"], status: { type: "completed" } });
  assert.equal(h.events.filter((e) => e.type === "steer_updated").length, 1, "only the accepted steer is settled");
  assert.ok(settled < h.events.indexOf(finished), "steer settled before turn_finished");
  await session.shutdown();
});

test("approval and question round trip to MSP", async () => {
  for (const scenario of ["approval", "question"] as const) {
    const h = setup(); const session = await museEngine.start(init, h.host);
    await session.startTurn(input(scenario), settings);
    const opened = await h.wait((e) => e.type === "request_opened");
    assert.equal(opened.type, "request_opened"); if (opened.type !== "request_opened") throw new Error("missing request");
    await session.answerRequest(opened.key, scenario === "approval" ? { outcome: "accept" } : { outcome: "answered", answers: { q: "blue" } });
    await h.wait((e) => e.type === "turn_finished");
    assert.ok(h.events.some((e) => e.type === "request_closed" && e.key === opened.key));
    const call = fixture.calls.find((c) => c.method === (scenario === "approval" ? "approval/decide" : "userInput/answer"))!;
    if (scenario === "approval") assert.equal(call.params.choiceId, "yes");
    else assert.deepEqual(call.params.answers, [{ questionId: "q", selectedLabel: "blue" }]);
    await session.shutdown();
  }
});

test("turn errors do not leak SDK error messages and auth errors emit auth_required", async () => {
  const h = setup(); const session = await museEngine.start(init, h.host);
  assert.deepEqual(await session.startTurn(input("start-fail"), settings), { status: "declined", reason: "Muse could not start the turn" });
  await session.startTurn(input("turn-fail"), settings);
  assert.equal((await h.wait((e) => e.type === "auth_required")).type, "auth_required");
  const end = await h.wait((e) => e.type === "turn_finished");
  assert.equal(end.type === "turn_finished" && end.outcome.type, "failed");
  assert.deepEqual(await session.startTurn(input("start-unknown"), settings), { status: "unknown", reason: "Muse turn admission is unknown" });
  assert.equal((await session.startTurn(input("hello"), settings)).status, "declined");
  await session.shutdown();
});

test("probe reads version and catalog without creating a session", async () => {
  const h = setup();
  const probe = await museEngine.probe!({ protocol: 1, engine: "muse", cwd: "/tmp", launch: { binary: process.execPath } }, h.host);
  assert.equal(probe.installed, true); assert.equal(probe.status, "ready"); assert.equal(probe.auth.status, "unknown");
  assert.match(probe.version!, /^\d+\.\d+\.\d+/); assert.equal(probe.models[0]?.slug, "muse-example");
  assert.ok(fixture.calls.some((c) => c.method === "model/list"));
  assert.ok(!fixture.calls.some((c) => c.method === "turn/start" || c.method === "session/start"));
  assert.deepEqual(fixture.launches[0].args, ["serve", "--disable-shell", "--disable-write", "--no-session-log"]);
});

import { projectMuseItem } from "../src/engines/muse/presentation.ts";
test("native tool, file, reasoning, web and subagent rows map to contract types", () => {
  const project = (kind: string, fields: Record<string, unknown> = {}) => projectMuseItem({ itemId: kind, kind, status: "completed", revision: 1, ...fields }, "turn", `turn:${kind}`, "2026-01-01T00:00:00Z", "muse");
  const command = project("toolCall", { tool: "shell", args: JSON.stringify({ command: "ls" }) });
  assert.equal(command?.type, "command_execution");
  if (command?.type === "command_execution") { assert.equal(command.input, "ls"); assert.equal(command.outputOmitted, true); }
  const file = project("toolCall", { tool: "edit", args: JSON.stringify({ path: "a.txt" }) });
  assert.equal(file?.type, "file_change");
  if (file?.type === "file_change") assert.equal(file.patchOmitted, true);
  assert.equal(project("reasoning", { text: "thinking" })?.type, "reasoning");
  assert.equal(project("toolCall", { tool: "web_search", args: JSON.stringify({ query: "topic" }) })?.type, "web_search");
  assert.equal(project("subagent", { subagentId: "child", objective: "research" })?.type, "subagent");
  assert.equal(project("toolCall", { tool: "write_todos" }), undefined);
});

test("delivery gap terminates an accepted turn exactly once and fails the host", async () => {
  fixture.reset(); process.env.GOAT2_ENGINE_HELPER_SDK_MUSE = fixturePath;
  const events: EngineEvent[] = []; const failures: string[] = [];
  const host = { emit: (event: EngineEvent) => events.push(event), fail: (reason: string) => failures.push(reason), log: () => {}, now: () => "2026-01-01T00:00:00Z" };
  const session = await museEngine.start(init, host);
  const result = await session.startTurn(input("hold"), settings);
  assert.equal(result.status, "accepted");
  fixture.sendNotification("view/gap", { sessionId: session.engineRef });
  fixture.sendNotification("view/gap", { sessionId: session.engineRef });
  assert.equal(events.filter((e) => e.type === "turn_finished").length, 1);
  assert.equal(failures.length, 1);
  await session.shutdown();
});

test("configured bearer is redacted even across streaming chunks", async () => {
  const h = setup(); const session = await museEngine.start(init, h.host);
  const result = await session.startTurn(input("hold"), settings);
  assert.equal(result.status, "accepted"); if (result.status !== "accepted") throw new Error("not started");
  await new Promise((resolve) => setImmediate(resolve));
  const base = { sessionId: session.engineRef, turnId: result.turnId };
  fixture.sendNotification("item/started", { ...base, item: { itemId: "message", turnId: result.turnId, kind: "agentMessage", status: "inProgress", revision: 1 } });
  fixture.sendNotification("item/delta", { ...base, itemId: "message", delta: "dum" });
  fixture.sendNotification("item/delta", { ...base, itemId: "message", delta: "my" });
  fixture.sendNotification("item/completed", { ...base, item: { itemId: "message", turnId: result.turnId, kind: "agentMessage", status: "completed", revision: 2, text: "dummy" } });
  fixture.sendNotification("turn/completed", { ...base, terminal: "completed" });
  assert.ok(!JSON.stringify(h.events).includes("dummy"));
  assert.equal(h.events.filter((e) => e.type === "text_delta").map((e) => e.type === "text_delta" ? e.text : "").join(""), "[redacted]");
  await session.shutdown();
});

test("runless child approvals fail visibly instead of being dropped", async () => {
  fixture.reset(); process.env.GOAT2_ENGINE_HELPER_SDK_MUSE = fixturePath;
  const failures: string[] = [];
  const host = { emit: (_event: EngineEvent) => {}, fail: (reason: string) => failures.push(reason), log: () => {}, now: () => "2026-01-01T00:00:00Z" };
  const session = await museEngine.start(init, host);
  fixture.sendNotification("approval/requested", { sessionId: session.engineRef, subagentOrigin: { subagentId: "child" }, approvalId: "a" });
  assert.deepEqual(failures, ["Muse background work requires unsupported host coordination"]);
  await session.shutdown();
});
