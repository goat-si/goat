import assert from "node:assert/strict";
import { test } from "node:test";
import type { V2Event } from "@opencode/client";
import type { EngineEvent } from "../src/protocol.ts";
import { OpenCode2Projection } from "../src/engines/opencode2/events.ts";

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
