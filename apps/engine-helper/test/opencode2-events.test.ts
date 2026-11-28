import assert from "node:assert/strict";
import { test } from "node:test";
import type { V2Event } from "@opencode/client";
import type { EngineEvent } from "../src/protocol.ts";
import { OpenCode2Projection } from "../src/engines/opencode2/events.ts";
import { safeHost } from "../src/engines/opencode/redact.ts";
import type { InitializeParams } from "../src/protocol.ts";

test("OpenCode 2 projects separate text and reasoning ordinals, usage and compaction", () => {
  const events: EngineEvent[] = [];
  const host = { emit(event: EngineEvent) { events.push(event); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const projection = new OpenCode2Projection(host, "turn"); let seq = 0;
  const send = (type: string, data: Record<string, unknown>, id = `event-${++seq}`) => projection.handle({ id, created: 1, type, data: { sessionID: "session", ...data }, durable: { aggregateID: "session", seq, version: 1 } } as unknown as V2Event);
  send("session.text.started", { assistantMessageID: "message", ordinal: 0 });
  send("session.text.delta", { assistantMessageID: "message", ordinal: 0, delta: "Hello" }, "delta");
  send("session.text.delta", { assistantMessageID: "message", ordinal: 0, delta: "Hello" }, "delta");
  send("session.reasoning.ended", { assistantMessageID: "message", ordinal: 0, text: "Think" });
  send("session.text.ended", { assistantMessageID: "message", ordinal: 0, text: "Hello world" });
  send("session.text.ended", { assistantMessageID: "message", ordinal: 1, text: "Second" });
  send("session.compaction.started", {}); send("session.compaction.ended", { text: "Summary" });
  send("session.step.ended", { tokens: { input: 7, output: 8, reasoning: 2, cache: { read: 3, write: 4 } } });
  projection.finish(1000);
  const deltas = events.filter((event) => event.type === "text_delta");
  assert.deepEqual(deltas.map((event) => event.type === "text_delta" ? event.text : ""), ["Hello", " world", "Second"]);
  assert.deepEqual(events.filter((event) => event.type === "content_delta"), [{ type: "content_delta", turnId: "turn", itemId: "message:reasoning:0", streamKind: "reasoning_text", text: "Think" }]);
  const completed = events.filter((event) => event.type === "item_completed");
  assert.deepEqual(completed.map((event) => event.type === "item_completed" ? event.item.type : ""), ["reasoning", "assistant_message", "assistant_message", "compaction"]);
  assert.deepEqual(events.at(-1), { type: "token_usage", turnId: "turn", usage: { usedTokens: 22, inputTokens: 14, cachedInputTokens: 3, outputTokens: 8, reasoningOutputTokens: 2, maxTokens: 1000 } });
});

test("OpenCode 2 rejects a completed text snapshot that rewrites streamed text", () => {
  const host = { emit(_event: EngineEvent) {}, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const projection = new OpenCode2Projection(host, "turn");
  projection.handle({ id: "a", type: "session.text.delta", data: { assistantMessageID: "m", ordinal: 0, delta: "A" } } as unknown as V2Event);
  assert.throws(() => projection.handle({ id: "b", type: "session.text.ended", data: { assistantMessageID: "m", ordinal: 0, text: "B" } } as unknown as V2Event), /changed after streaming/);
});

test("reasoning content redacts a token split across native deltas", () => {
  const events: EngineEvent[] = [];
  const raw = { emit(event: EngineEvent) { events.push(event); }, log() {}, fail(reason: string) { throw new Error(reason); }, now: () => "2026-01-01T00:00:00Z" };
  const params: InitializeParams = { protocol: 1, engine: "opencode", threadId: "t", cwd: "/tmp", resume: null, modelSelection: { instanceId: "opencode", model: "p/m" }, runtimeMode: "full-access", mcp: { url: "http://127.0.0.1:1", bearerToken: "synthetic-secret-token" }, instructions: null, launch: null };
  const projection = new OpenCode2Projection(safeHost(raw, params), "turn");
  projection.handle({ id: "a", type: "session.reasoning.delta", data: { assistantMessageID: "m", ordinal: 0, delta: "synthetic-secret-" } } as unknown as V2Event);
  projection.handle({ id: "b", type: "session.reasoning.ended", data: { assistantMessageID: "m", ordinal: 0, text: "synthetic-secret-token" } } as unknown as V2Event);
  const streamed = events.flatMap((event) => event.type === "content_delta" ? [event.text] : []).join("");
  assert.equal(streamed, "[redacted]");
  assert.ok(!JSON.stringify(events).includes("synthetic-secret-token"));
});
