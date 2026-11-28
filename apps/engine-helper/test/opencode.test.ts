import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { goatRemoteMcpConfig } from "../src/engines/opencode/goatMcpConfig.ts";
import { resolveOpenCodeConfigContent } from "../src/engines/opencode/openCodeConfigContent.ts";

test("OpenCode GOAT MCP entry follows the v1 remote config shape", () => {
  const authorization = `Bearer ${randomUUID()}`;
  assert.deepEqual(goatRemoteMcpConfig("http://127.0.0.1:1/mcp", authorization), {
    type: "remote", url: "http://127.0.0.1:1/mcp", headers: { Authorization: authorization }, oauth: false,
  });
});

test("OpenCode config content prefers launch environment, then inherited environment", () => {
  assert.equal(resolveOpenCodeConfigContent({ OPENCODE_CONFIG_CONTENT: "launch" }, { OPENCODE_CONFIG_CONTENT: "inherited" }), "launch");
  assert.equal(resolveOpenCodeConfigContent({}, { OPENCODE_CONFIG_CONTENT: "inherited" }), "inherited");
  assert.equal(resolveOpenCodeConfigContent(undefined, {}), "{}");
});

import { fileURLToPath } from "node:url";
import type { EngineEvent, InitializeParams, TurnSettings } from "../src/protocol.ts";
import { opencodeEngine } from "../src/engines/opencode/index.ts";
import * as fake from "./fakes/opencode-sdk.ts";

process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE = fileURLToPath(new URL("./fakes/opencode-sdk.ts", import.meta.url));
const selection = { instanceId: "opencode", model: "test/model" };
const settings: TurnSettings = { modelSelection: selection, runtimeMode: "full-access" };
const params: InitializeParams = { protocol: 1, engine: "opencode", threadId: "thread", cwd: process.cwd(), resume: null, modelSelection: selection, runtimeMode: "full-access", mcp: { url: "http://127.0.0.1:1/mcp", bearerToken: randomUUID() }, instructions: { appendSystemPrompt: "system", firstMessagePreamble: "preamble" }, launch: null };
const input = (text: string) => [{ inputId: "input", text, attachments: [] }];
function harness() {
  const events: EngineEvent[] = [];
  return { events, host: { emit: (event: EngineEvent) => events.push(event), log() {}, fail(reason: string) { throw new Error(reason); }, now: () => new Date().toISOString() } };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("event timeout"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

test("OpenCode streams a turn, injects MCP and resumes", async () => {
  fake.reset(); const h = harness(); const session = await opencodeEngine.start(params, h.host);
  assert.equal(session.engineRef, "session-fake");
  const mcp = fake.calls.find((c) => c.method === "mcp.add")?.args as { name: string; config: { headers: { Authorization: string }; oauth: boolean } };
  assert.equal(mcp.name, "goat"); assert.equal(mcp.config.headers.Authorization, `Bearer ${params.mcp!.bearerToken}`); assert.equal(mcp.config.oauth, false);
  const result = await session.startTurn(input("hello"), settings); assert.equal(result.status, "accepted");
  await until(() => h.events.some((event) => event.type === "turn_finished"));
  assert.equal(h.events.filter((e) => e.type === "text_delta").map((e) => e.type === "text_delta" ? e.text : "").join(""), "Hello world");
  assert.ok(h.events.some((e) => e.type === "item_completed" && e.item.type === "command_execution"));
  assert.equal(h.events.filter((e) => e.type === "turn_finished").length, 1);
  const prompt = fake.calls.find((c) => c.method === "prompt")?.args as { system: string; parts: Array<{ text: string }> };
  assert.equal(prompt.system, "system"); assert.equal(prompt.parts[0]?.text, "preamble\n\nhello");
  await session.shutdown();
  const resumed = await opencodeEngine.start({ ...params, resume: "session-fake" }, harness().host);
  assert.equal(resumed.engineRef, "session-fake"); assert.ok(fake.calls.some((c) => c.method === "get")); await resumed.shutdown();
});

test("OpenCode steering, interrupt, permission reply and submission failure", async () => {
  fake.reset(); const h = harness(); const session = await opencodeEngine.start(params, h.host);
  const started = await session.startTurn(input("hold"), settings); assert.equal(started.status, "accepted");
  if (started.status !== "accepted") throw new Error("not accepted");
  await until(() => fake.calls.some((c) => c.method === "prompt"));
  await until(() => h.events.length > 0 || fake.calls.some((c) => c.method === "prompt"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await session.steer(started.turnId, input("hold again"))).status, "accepted");
  await session.interrupt(started.turnId);
  await until(() => h.events.some((e) => e.type === "turn_finished"));
  assert.ok(h.events.some((e) => e.type === "turn_finished" && e.outcome.type === "interrupted"));
  const ask = await session.startTurn(input("approve"), settings); assert.equal(ask.status, "accepted");
  await until(() => h.events.some((e) => e.type === "request_opened"));
  await session.answerRequest("request-1", { outcome: "accept" });
  await until(() => h.events.filter((e) => e.type === "turn_finished").length === 2);
  assert.ok(fake.calls.some((c) => c.method === "permission.reply"));
  await session.startTurn(input("fail-prompt"), settings);
  await until(() => h.events.filter((e) => e.type === "turn_finished").length === 3);
  assert.ok(h.events.some((e) => e.type === "turn_finished" && e.outcome.type === "failed"));
  await session.shutdown();
});

test("OpenCode probe reads inventory without a turn", async () => {
  fake.reset(); const result = await opencodeEngine.probe!({ protocol: 1, engine: "opencode", cwd: process.cwd(), launch: null }, harness().host);
  assert.equal(result.status, "ready"); assert.equal(result.auth.status, "authenticated"); assert.equal(result.models[0]?.slug, "test/model");
  assert.ok(!fake.calls.some((call) => call.method === "prompt"));
});

test("OpenCode runtime owns and stops its server child", async () => {
  const { startServer } = await import("../src/engines/opencode/runtime.ts");
  const saved = process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE;
  delete process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE;
  try {
    const server = await startServer({} as never, process.cwd(), { binary: process.execPath, args: [fileURLToPath(new URL("./fakes/opencode-server.ts", import.meta.url))] });
    assert.equal(server.url, "http://127.0.0.1:12345");
    await server.close();
  } finally { process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE = saved; }
});

test("OpenCode structured question round trip", async () => {
  fake.reset(); const h = harness(); const session = await opencodeEngine.start(params, h.host);
  await session.startTurn(input("question"), settings);
  await until(() => h.events.some((event) => event.type === "request_opened"));
  const request = h.events.find((event) => event.type === "request_opened");
  assert.ok(request && request.type === "request_opened" && request.kind === "question");
  await session.answerRequest("question-1", { outcome: "answered", answers: { "question-0-color": "Blue" } });
  await until(() => h.events.some((event) => event.type === "turn_finished"));
  assert.deepEqual((fake.calls.find((call) => call.method === "question.reply")?.args as { answers: string[][] }).answers, [["Blue"]]);
  assert.ok(h.events.some((event) => event.type === "request_closed" && event.key === "question-1"));
  await session.shutdown();
});

test("interrupt before prompt submission never sends the prompt", async () => {
  fake.reset(); const h = harness(); const session = await opencodeEngine.start(params, h.host);
  const turn = await session.startTurn(input("hold"), settings); assert.equal(turn.status, "accepted");
  if (turn.status !== "accepted") throw new Error("not accepted");
  await session.interrupt(turn.turnId);
  await until(() => h.events.some((event) => event.type === "turn_finished"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!fake.calls.some((call) => call.method === "prompt"));
  assert.equal(h.events.filter((event) => event.type === "turn_finished").length, 1);
  await session.shutdown();
});

test("known credentials are redacted before engine events reach the host", async () => {
  const { safeHost } = await import("../src/engines/opencode/redact.ts");
  const h = harness(); const protectedHost = safeHost(h.host, params);
  const secret = params.mcp!.bearerToken;
  protectedHost.emit({ type: "text_delta", turnId: "turn", itemId: "item", text: `Bearer ${secret.slice(0, 8)}` });
  protectedHost.emit({ type: "text_delta", turnId: "turn", itemId: "item", text: secret.slice(8) });
  protectedHost.emit({ type: "turn_finished", turnId: "turn", outcome: { type: "done" } });
  assert.deepEqual(h.events[0], { type: "text_delta", turnId: "turn", itemId: "item", text: "Bearer [redacted]" });
});
