import {
  TERMINAL_SEQUENCE_GROUND,
  terminalSequenceEnd,
  terminalSequenceStateAfter,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

const COMPACTION_TEMP_PREFIX = ".history-";
const COMPACTION_TEMP_NAME = "history";

const removeAbandonedHistoryCompactions = Effect.fn("terminal.removeAbandonedHistoryCompactions")(
  function* (fs: FileSystem.FileSystem, path: Path.Path, logsDir: string) {
    // The server holds exclusive ownership of its userdata before starting the terminal manager.
    for (const name of yield* fs.readDirectory(logsDir)) {
      if (!/^\.history-[a-z0-9]{6}$/i.test(name)) continue;
      const dir = path.join(logsDir, name);
      yield* Effect.gen(function* () {
        if ((yield* fs.lstat(dir)).type !== "Directory") return;
        const entries = yield* fs.readDirectory(dir);
        if (entries.length > 1) return;
        const [entry] = entries;
        // Older servers used makeTempFileScoped, whose file name was six random bytes in hex.
        if (entry !== undefined) {
          if (entry !== COMPACTION_TEMP_NAME && !/^[a-f0-9]{12}$/.test(entry)) return;
          if ((yield* fs.lstat(path.join(dir, entry))).type !== "File") return;
        }
        yield* fs.remove(dir, { recursive: true, force: true });
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to remove abandoned terminal history", { error }),
        ),
      );
    }
  },
  Effect.catch((error) =>
    Effect.logWarning("failed to list abandoned terminal history", { error }),
  ),
);

export const initializeTerminalHistory = Effect.fn("terminal.initializeHistory")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  logsDir: string,
) {
  yield* fs.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);
  yield* removeAbandonedHistoryCompactions(fs, path, logsDir);
});

export const writeCompactedTerminalHistory = Effect.fn("terminal.writeCompactedHistory")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  logsDir: string,
  nextPath: string,
  history: string,
) {
  const dir = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ directory: logsDir, prefix: COMPACTION_TEMP_PREFIX }),
    (dir) =>
      fs
        .remove(dir, { recursive: true, force: true })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to remove temporary terminal history", { error }),
          ),
        ),
  );
  const temporaryPath = path.join(dir, COMPACTION_TEMP_NAME);
  yield* fs.writeFileString(temporaryPath, history);
  yield* fs.rename(temporaryPath, nextPath);
}, Effect.scoped);

export const readTerminalHistoryTail = Effect.fn("terminal.readHistoryTail")(function* (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
  historyByteLimit: number,
) {
  const file = yield* fileSystem.open(filePath, { flag: "r" });
  const info = yield* file.stat;
  const limit = BigInt(historyByteLimit);
  const offset = info.size > limit ? info.size - limit : 0n;
  // The tail can start inside a control sequence; only the bytes before it say which.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let sequenceState = TERMINAL_SEQUENCE_GROUND;
  const skipped = new Uint8Array(Math.min(Number(offset), 64 * 1024));
  for (let remaining = Number(offset); remaining > 0;) {
    const read = Number(yield* file.read(skipped.subarray(0, remaining)));
    if (read === 0) break;
    remaining -= read;
    sequenceState = terminalSequenceStateAfter(
      sequenceState,
      decoder.decode(skipped.subarray(0, read), { stream: true }),
    );
  }
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
  sequenceState = terminalSequenceStateAfter(
    sequenceState,
    decoder.decode(bytes.subarray(0, start)),
  );
  const history = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    bytes.subarray(start, length),
  );
  return {
    history: history.slice(terminalSequenceEnd(sequenceState, history)),
    truncated: offset > 0n,
  };
});

// One line in the terminal itself, so a failed compaction is not hidden in the server log.
export const TERMINAL_HISTORY_COMPACTION_NOTICE =
  "\r\n[GOAT] Could not shrink this terminal's saved history; it will be rewritten on the next save.\r\n";
