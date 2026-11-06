import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";

// Old clients omit this; old servers ignore it.
export const SOCKET_FRAME_PARTS_QUERY_PARAM = "frameParts";

// WebSocket messages arrive whole. At 4,000 bytes/s each part takes about
// 12 seconds, leaving margin before the client's 15-second liveness timeout.
const SOCKET_FRAME_PART_BYTES = 48 * 1024;

// No JSON message starts with a record separator. It marks every part but the last.
const PART_PREFIX = "\u001e";

// The RPC client only counts frames that decode to messages as liveness, and
// ignores pongs, so each held-back part reads to it as one.
const PART_RECEIVED_FRAME = '{"_tag":"Pong"}';
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const MAX_PARTS = 2048;

/** Splits on the UTF-8 size the frame has on the wire, never inside a surrogate pair. */
export function splitSocketFrame(
  frame: string,
  partBytes = SOCKET_FRAME_PART_BYTES,
): Arr.NonEmptyReadonlyArray<string> {
  // UTF-8 spends at most 3 bytes on a UTF-16 code unit.
  if (frame.length * 3 <= partBytes) return [frame];
  const parts: Array<string> = [];
  let start = 0;
  let bytes = PART_PREFIX.length;
  let total = 0;
  for (let index = 0; index < frame.length;) {
    const code = frame.charCodeAt(index);
    const low = frame.charCodeAt(index + 1);
    const pair = code >= 0xd800 && code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
    const size = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    total += size;
    if (total > MAX_REASSEMBLED_BYTES || parts.length >= MAX_PARTS - 1)
      throw new Error("Socket frame exceeds reassembly limit");
    if (bytes + size > partBytes) {
      parts.push(PART_PREFIX + frame.slice(start, index));
      start = index;
      bytes = PART_PREFIX.length;
    }
    bytes += size;
    index += pair ? 2 : 1;
  }
  return Arr.append(parts, frame.slice(start));
}

/** Server side: sends string frames longer than one part as consecutive parts. */
export function splitLargeSocketFrames(socket: Socket.Socket): Socket.Socket {
  return Socket.make({
    reader: socket.reader,
    writer: Effect.map(socket.writer, (writer) => ({
      write: (chunk) =>
        typeof chunk === "string"
          ? Effect.try({
              try: () => splitSocketFrame(chunk),
              catch: (cause) =>
                new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) }),
            }).pipe(Effect.flatMap(writer.writeAll))
          : writer.write(chunk),
      writeAll: (chunks) =>
        Effect.forEach(
          chunks,
          (chunk) =>
            typeof chunk === "string"
              ? Effect.try({
                  try: () => splitSocketFrame(chunk),
                  catch: (cause) =>
                    new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) }),
                }).pipe(Effect.flatMap(writer.writeAll))
              : writer.write(chunk),
          { discard: true },
        ),
    })),
  });
}

export function makeFrameJoiner(maxBytes = MAX_REASSEMBLED_BYTES, maxParts = MAX_PARTS) {
  let pending: string[] = [];
  let size = 0;
  const encoder = new TextEncoder();
  return (frame: string | Uint8Array): string | Uint8Array => {
    if (typeof frame !== "string") {
      if (pending.length > 0) throw new Error("Unexpected binary frame during reassembly");
      return frame;
    }
    const partial = frame.startsWith(PART_PREFIX);
    if (!partial && pending.length === 0) return frame;
    const part = partial ? frame.slice(PART_PREFIX.length) : frame;
    if (part.length > maxBytes - size) throw new Error("Socket frame exceeds reassembly limit");
    size += encoder.encode(part).byteLength;
    if (size > maxBytes || pending.length >= maxParts)
      throw new Error("Socket frame exceeds reassembly limit");
    pending.push(part);
    if (partial) return PART_RECEIVED_FRAME;
    const whole = pending.join("");
    pending = [];
    size = 0;
    return whole;
  };
}

/** Client side: joins parts back into whole frames. */
export function joinSocketFrameParts(socket: Socket.Socket): Socket.Socket {
  return Socket.make({
    reader: Effect.map(socket.reader, (reader) => {
      const join = makeFrameJoiner();
      return {
        upgrade: reader.upgrade,
        pull: Effect.flatMap(reader.pull, (frames) =>
          Effect.try({
            try: () => Arr.map(frames, join),
            catch: (cause) =>
              new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) }),
          }),
        ),
      };
    }),
    writer: socket.writer,
  });
}
