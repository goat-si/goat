import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as AcpSchema from "effect-acp/compat";
import { makeAcpWakeBuffer } from "./wakeBuffer.ts";

const sessionId = "wake-buffer-test";
const frame = (
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
  text: string,
): AcpSchema.SessionNotification => ({
  sessionId,
  update: { sessionUpdate, content: { type: "text", text } },
});

it.effect("evicts the older thought under the character budget and keeps the result", () =>
  Effect.gen(function* () {
    const buffer = makeAcpWakeBuffer();
    const answer = frame("agent_message_chunk", "The queued answer.");
    const stale = frame("agent_thought_chunk", "a".repeat(2 * 1024 * 1024));
    const recent = frame("agent_thought_chunk", "b".repeat(2 * 1024 * 1024));
    yield* buffer.append(answer, true);
    yield* buffer.append(stale, false);
    yield* buffer.append(recent, false);
    const retained = yield* buffer.take(sessionId);
    expect(
      retained.map((item) => (item === answer ? "answer" : item === recent ? "recent" : "stale")),
    ).toEqual(["answer", "recent"]);
  }),
);

it.effect("keeps admitted results when the buffer contains only result-bearing frames", () =>
  Effect.gen(function* () {
    const buffer = makeAcpWakeBuffer();
    const first = frame("agent_message_chunk", "First queued answer.");
    yield* buffer.append(first, true);
    for (let index = 0; index < 127; index++) {
      yield* buffer.append(frame("agent_message_chunk", `Result chunk ${index}.`), true);
    }
    const accepted = yield* buffer.append(frame("agent_message_chunk", "Overflow."), true);
    expect(accepted).toBe(false);
    const retained = yield* buffer.take(sessionId);
    expect(retained).toHaveLength(128);
    expect(retained[0]).toBe(first);
  }),
);

it.effect("keeps buffered frames when a thought cannot fit even after eligible evictions", () =>
  Effect.gen(function* () {
    const buffer = makeAcpWakeBuffer();
    const answer = frame("agent_message_chunk", "a".repeat(3 * 1024 * 1024));
    const thought = frame("agent_thought_chunk", "A buffered thought.");
    expect(yield* buffer.append(answer, true)).toBe(true);
    expect(yield* buffer.append(thought, false)).toBe(true);
    const oversized = frame("agent_thought_chunk", "b".repeat(2 * 1024 * 1024));
    expect(yield* buffer.append(oversized, false)).toBe(false);
    expect(yield* buffer.length).toBe(2);
    const retained = yield* buffer.take(sessionId);
    expect(
      retained.map((item) =>
        item === answer ? "answer" : item === thought ? "thought" : "unexpected",
      ),
    ).toEqual(["answer", "thought"]);
  }),
);
