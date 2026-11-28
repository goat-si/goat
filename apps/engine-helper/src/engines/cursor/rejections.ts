// Lifted from provider-cursor/src/server/CursorSdk.ts:15-44 at 916b5ccc1b2.
// After a local exec fails the SDK may write a final frame to an already closed stream.
export function classifyCursorRejection(reason: unknown): string | undefined {
  if (!(reason instanceof Error)) return undefined;
  if (reason.name === "WriteIterableClosedError" && reason.message === "WritableIterable is closed") {
    return "Cursor SDK wrote to a closed exec stream.";
  }
  if (
    reason.name === "ConnectError" &&
    Reflect.get(reason, "code") === 10 &&
    reason.cause instanceof Error &&
    Reflect.get(reason.cause, "code") === "ERR_STREAM_WRITE_AFTER_END"
  ) {
    return "Cursor SDK wrote to an ended request stream.";
  }
  if (
    reason.name === "AbortError" &&
    typeof reason.stack === "string" &&
    /^[ \t]+at (?:\S+\.)?onStall \(.*[\\/]@cursor[\\/]sdk[\\/]dist[\\/]/m.test(reason.stack)
  ) {
    return "Cursor SDK aborted a stalled request.";
  }
  return undefined;
}
