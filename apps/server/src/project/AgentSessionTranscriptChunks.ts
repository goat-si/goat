import * as NodeZlib from "node:zlib";

import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Pull from "effect/Pull";
import * as Stream from "effect/Stream";

// Codex zstd-compresses older rollouts; their byte limits and offsets count decompressed bytes.
export const COMPRESSED_TRANSCRIPT_SUFFIX = ".jsonl.zst";
export const isCompressedTranscript = (filePath: string) =>
  filePath.endsWith(COMPRESSED_TRANSCRIPT_SUFFIX);

export function makeTranscriptChunkReader(fileSystem: FileSystem.FileSystem) {
  return Effect.fn("AgentSessionScanner.transcriptChunkReader")(function* (
    file: FileSystem.File,
    filePath: string,
  ) {
    if (!isCompressedTranscript(filePath)) return (size: number) => file.readAlloc(size);
    const pull = yield* Stream.toPull(
      fileSystem
        .stream(filePath)
        .pipe(NodeStream.pipeThroughSimple(() => NodeZlib.createZstdDecompress())),
    );
    let pending: Array<Uint8Array> = [];
    let done = false;
    // Untraced: called once per chunk inside the caller's traced read.
    return Effect.fnUntraced(function* (size: number) {
      while (pending.length === 0) {
        if (done) return Option.none<Uint8Array>();
        const next = yield* pull.pipe(Pull.catchDone(() => Effect.undefined));
        if (next === undefined) done = true;
        else pending = [...next];
      }
      const chunk = pending.shift();
      if (chunk === undefined) return Option.none<Uint8Array>();
      if (chunk.byteLength > size) pending.unshift(chunk.subarray(size));
      return Option.some(chunk.subarray(0, size));
    });
  });
}
