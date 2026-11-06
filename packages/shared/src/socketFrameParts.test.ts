import { expect, it } from "@effect/vitest";
import { makeFrameJoiner, splitSocketFrame } from "./socketFrameParts.ts";

it("splits UTF-8 frames and rejoins them while preserving old unframed messages", () => {
  const original = JSON.stringify({ message: "é€😀x".repeat(64_000) });
  const frames = splitSocketFrame(original);
  expect(frames.length).toBeGreaterThan(1);
  expect(frames.every((frame) => new TextEncoder().encode(frame).length <= 48 * 1024)).toBe(true);
  const join = makeFrameJoiner();
  expect(join('{"old":true}')).toBe('{"old":true}');
  for (const frame of frames.slice(0, -1)) expect(join(frame)).toBe('{"_tag":"Pong"}');
  expect(join(frames.at(-1)!)).toBe(original);
  expect(join('{"next":true}')).toBe('{"next":true}');
});

it("limits reassembly size and part count and rejects interleaved binary data", () => {
  const size = makeFrameJoiner(5, 4);
  size("\u001eabc");
  expect(() => size("éé")).toThrow("reassembly limit");
  const count = makeFrameJoiner(100, 2);
  count("\u001ea");
  count("\u001eb");
  expect(() => count("c")).toThrow("reassembly limit");
  const binary = makeFrameJoiner();
  binary("\u001epart");
  expect(() => binary(new Uint8Array([1]))).toThrow("Unexpected binary");
});
