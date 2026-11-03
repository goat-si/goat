const FIRST_BYTES = 64 * 1024;
const LAST_BYTES = 192 * 1024;
const BLOCK_BYTES = 4096;

type StreamName = "stdout" | "stderr";
type Block = { readonly bytes: Uint8Array; readonly streams: Uint8Array; readonly offset: number };
type Output = { readonly streamName: StreamName; readonly chunk: Uint8Array };
type Buffer = { readonly blocks: ReadonlyArray<Block>; readonly length: number };
export interface StopBuffer {
  readonly first: Buffer;
  readonly last: Buffer;
  readonly omittedBytes: number;
}

export const emptyStopBuffer = (): StopBuffer => ({
  first: { blocks: [], length: 0 },
  last: { blocks: [], length: 0 },
  omittedBytes: 0,
});

function append(buffer: Buffer, chunk: Uint8Array, streamName: StreamName): Buffer {
  if (!chunk.byteLength) return buffer;
  const blocks = [...buffer.blocks];
  let offset = 0;
  const last = blocks.at(-1);
  if (last && last.bytes.length < BLOCK_BYTES) {
    const count = Math.min(BLOCK_BYTES - last.bytes.length, chunk.length);
    const bytes = new Uint8Array(last.bytes.length + count);
    const streams = new Uint8Array(bytes.length);
    bytes.set(last.bytes);
    bytes.set(chunk.subarray(0, count), last.bytes.length);
    streams.set(last.streams);
    streams.fill(streamName === "stderr" ? 1 : 0, last.bytes.length);
    blocks[blocks.length - 1] = { bytes, streams, offset: last.offset };
    offset = count;
  }
  while (offset < chunk.length) {
    const bytes = chunk.slice(offset, offset + BLOCK_BYTES);
    const streams = new Uint8Array(bytes.length);
    if (streamName === "stderr") streams.fill(1);
    blocks.push({ bytes, streams, offset: 0 });
    offset += bytes.length;
  }
  return { blocks, length: buffer.length + chunk.length };
}

function trim(buffer: Buffer, amount: number): Buffer {
  const blocks = [...buffer.blocks];
  let remaining = amount;
  while (remaining > 0) {
    const first = blocks.shift();
    if (!first) break;
    const drop = Math.min(remaining, first.bytes.length - first.offset);
    remaining -= drop;
    if (first.offset + drop < first.bytes.length)
      blocks.unshift({ ...first, offset: first.offset + drop });
  }
  return { blocks, length: buffer.length - amount + remaining };
}

export function appendStopOutput(
  buffer: StopBuffer,
  streamName: StreamName,
  chunk: Uint8Array,
): StopBuffer {
  const firstCount = Math.min(FIRST_BYTES - buffer.first.length, chunk.length);
  const first = append(buffer.first, chunk.subarray(0, firstCount), streamName);
  const remainder = chunk.subarray(firstCount);
  const skip = Math.max(0, remainder.length - LAST_BYTES);
  const combined = append(buffer.last, remainder.subarray(skip), streamName);
  const overflow = Math.max(0, combined.length - LAST_BYTES);
  return {
    first,
    last: trim(combined, overflow),
    omittedBytes: buffer.omittedBytes + skip + overflow,
  };
}

function outputs(buffer: Buffer): Array<Output> {
  const result: Array<Output> = [];
  for (const block of buffer.blocks) {
    let start = block.offset;
    while (start < block.bytes.length) {
      const stream = block.streams[start];
      let end = start + 1;
      while (end < block.bytes.length && block.streams[end] === stream) end++;
      result.push({
        streamName: stream === 1 ? "stderr" : "stdout",
        chunk: block.bytes.subarray(start, end),
      });
      start = end;
    }
  }
  return result;
}

export function stopOutputParts(buffer: StopBuffer) {
  return {
    first: outputs(buffer.first),
    last: outputs(buffer.last),
    omittedBytes: buffer.omittedBytes,
  };
}
