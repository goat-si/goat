import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { decodeGitText } from "./gitTextDecoder.ts";
export { decodeGitText } from "./gitTextDecoder.ts";
import { gitCommandContext } from "./gitCommandContext.ts";

const OUTPUT_LINE_SEPARATOR = /\r\n|\r|\n/;

export const collectOutput = Effect.fnUntraced(function* (
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maxOutputBytes: number,
  appendTruncationMarker: boolean,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
  keepLineCallbacksAfterTruncation = false,
): Effect.fn.Return<{ readonly text: string; readonly truncated: boolean }, GitCommandError> {
  const lineStreamDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const chunks: Array<Uint8Array> = [];
  const lineDecoder = keepLineCallbacksAfterTruncation && onLine ? new TextDecoder() : null;
  let bytes = 0;
  let lineBuffer = "";
  let truncated = false;
  // Bound newline-free output; oversized lines are not useful to callbacks.
  const maxPendingLineBytes = 64 * 1024;

  // Git redraws progress with bare CR; treat it as a line break.
  const emitCompleteLines = Effect.fnUntraced(function* (flush: boolean) {
    let separator = OUTPUT_LINE_SEPARATOR.exec(lineBuffer);
    while (separator) {
      const line = lineBuffer.slice(0, separator.index);
      lineBuffer = lineBuffer.slice(separator.index + separator[0].length);
      if (line.length > 0 && onLine) {
        yield* onLine(line);
      }
      separator = OUTPUT_LINE_SEPARATOR.exec(lineBuffer);
    }

    if (flush) {
      const trailing = lineBuffer;
      lineBuffer = "";
      if (trailing.length > 0 && onLine) {
        yield* onLine(trailing);
      }
    }
  });

  const processChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
    if (appendTruncationMarker && truncated) {
      if (lineDecoder) {
        lineBuffer += lineDecoder.decode(chunk, { stream: true });
        yield* emitCompleteLines(false);
        if (lineBuffer.length > maxPendingLineBytes) lineBuffer = "";
      }
      return;
    }
    const nextBytes = bytes + chunk.byteLength;
    if (!appendTruncationMarker && nextBytes > maxOutputBytes) {
      return yield* new GitCommandError({
        ...gitCommandContext(input),
        detail: `Git output exceeded ${maxOutputBytes} bytes and was truncated.`,
        outputLength: nextBytes,
      });
    }

    const chunkToDecode =
      appendTruncationMarker && nextBytes > maxOutputBytes
        ? chunk.subarray(0, Math.max(0, maxOutputBytes - bytes))
        : chunk;
    bytes += chunkToDecode.byteLength;
    truncated = appendTruncationMarker && nextBytes > maxOutputBytes;

    chunks.push(chunkToDecode);
    if (onLine) {
      lineBuffer += lineDecoder
        ? lineDecoder.decode(chunk, { stream: true })
        : lineStreamDecoder.decode(chunkToDecode, { stream: !truncated });
      yield* emitCompleteLines(false);
    }
  });

  yield* Stream.runForEach(stream, processChunk).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new GitCommandError({
          ...gitCommandContext(input),
          detail: "Failed to read Git process output.",
          cause,
        }),
    }),
  );

  if (onLine) {
    if (!truncated && !lineDecoder) lineBuffer += lineStreamDecoder.decode();
    if (lineDecoder) lineBuffer += lineDecoder.decode();
    yield* emitCompleteLines(true);
  }
  return {
    text: decodeGitText(Buffer.concat(chunks), truncated),
    truncated,
  };
});
