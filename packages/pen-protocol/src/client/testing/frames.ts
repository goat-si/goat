// Feeds bytes to a frame decoder and appends each event as it is decoded, so events before an error are kept.
import type { FrameDecoder, FrameEvent } from "../websocket.ts";

export function decodeInto(decoder: FrameDecoder, bytes: Uint8Array, out: Array<FrameEvent>): void {
  decoder.feed(bytes);
  for (let event = decoder.next(); event !== null; event = decoder.next()) out.push(event);
}
