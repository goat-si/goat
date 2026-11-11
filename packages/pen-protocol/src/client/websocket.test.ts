import { describe, expect, it } from "vite-plus/test";
import { FrameDecoder } from "./websocket.ts";

function binaryFrame(length: number): Uint8Array {
  const head = Uint8Array.of(
    0x82,
    127,
    0,
    0,
    0,
    0,
    (length >>> 24) & 255,
    (length >>> 16) & 255,
    (length >>> 8) & 255,
    length & 255,
  );
  const out = new Uint8Array(head.length + length);
  out.set(head);
  for (let i = 0; i < length; i++) out[head.length + i] = i & 255;
  return out;
}

describe("WebSocket message assembly (design 10.2: inbound held up to one message)", () => {
  it("a 256 KiB frame delivered one byte at a time is one message in one buffer no larger than the message", () => {
    const frame = binaryFrame(256 * 1024);
    const decoder = new FrameDecoder();
    const events = [];
    for (let i = 0; i < frame.length; i++) events.push(...decoder.push(frame.subarray(i, i + 1)));
    expect(events).toHaveLength(1);
    const message = events[0];
    expect(message?.type).toBe("message");
    const data = message?.type === "message" ? (message.data as Uint8Array) : new Uint8Array();
    expect(data.length).toBe(256 * 1024);
    expect(data[1000]).toBe(1000 & 255);
    expect(decoder.peakCapacity()).toBeLessThanOrEqual(256 * 1024);
  });

  it("a message of 1,024 fragments of 1 KiB, each fragment delivered in 7-byte pieces, keeps storage within twice the message", () => {
    const fragments: Array<number> = [];
    for (let f = 0; f < 1024; f++) {
      const opcode = f === 0 ? 0x02 : 0x00;
      fragments.push(
        (f === 1023 ? 0x80 : 0) | opcode,
        126,
        4,
        0,
        ...new Uint8Array(1024).fill(f & 255),
      );
    }
    const bytes = Uint8Array.from(fragments);
    const decoder = new FrameDecoder();
    const events = [];
    for (let i = 0; i < bytes.length; i += 7)
      events.push(...decoder.push(bytes.subarray(i, i + 7)));
    expect(events).toHaveLength(1);
    expect(decoder.peakCapacity()).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("next() decodes one message at a time; later frames stay undecoded input until asked for", () => {
    const decoder = new FrameDecoder();
    decoder.feed(Uint8Array.of(0x81, 1, 0x41, 0x81, 1, 0x42, 0x81, 1, 0x43));
    expect(decoder.next()).toEqual({ type: "message", data: "A" });
    expect(decoder.unread()).toBe(6);
    expect(decoder.next()).toEqual({ type: "message", data: "B" });
    expect(decoder.next()).toEqual({ type: "message", data: "C" });
    expect(decoder.next()).toBeNull();
  });
});
