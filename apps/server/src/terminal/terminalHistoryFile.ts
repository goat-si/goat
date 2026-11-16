import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

export const readTerminalHistoryTail = Effect.fn("terminal.readHistoryTail")(function* (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
  historyByteLimit: number,
) {
  const file = yield* fileSystem.open(filePath, { flag: "r" });
  const info = yield* file.stat;
  const limit = BigInt(historyByteLimit);
  const offset = info.size > limit ? info.size - limit : 0n;
  yield* file.seek(offset, "start");
  const bytes = new Uint8Array(Number(info.size - offset));
  let length = 0;
  while (length < bytes.length) {
    const read = Number(yield* file.read(bytes.subarray(length)));
    if (read === 0) break;
    length += read;
  }
  let start = 0;
  if (offset > 0n) {
    // A tail read can start inside a UTF-8 code point. Skip its remaining bytes.
    while (start < length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  }
  return {
    history: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(start, length)),
    truncated: offset > 0n,
  };
});

// One line in the terminal itself, so a failed compaction is not hidden in the server log.
export const TERMINAL_HISTORY_COMPACTION_NOTICE =
  "\r\n[GOAT] Could not shrink this terminal's saved history; it will be rewritten on the next save.\r\n";
