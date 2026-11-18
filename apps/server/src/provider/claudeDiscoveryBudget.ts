// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.readDirectory buffers the whole listing.
import * as NodeFSP from "node:fs/promises";
import { collectStreamAsString } from "@goat/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

export interface ClaudeSkillScanBudget {
  remainingEntries: number;
  remainingBytes: number;
}

export const listClaudeDiscoveryDirectory = Effect.fn("ClaudeDiscovery.listDirectory")(
  (path: string, limit: number) =>
    limit <= 0
      ? Effect.succeed([])
      : Effect.tryPromise(async () => {
          const names: string[] = [];
          const directory = await NodeFSP.opendir(path, { bufferSize: 16 });
          try {
            for (let i = 0; i < limit; i++) {
              const entry = await directory.read();
              if (entry === null) break;
              names.push(entry.name);
            }
          } finally {
            await directory.close();
          }
          return names.sort();
        }).pipe(Effect.orElseSucceed((): string[] => [])),
);

export const readClaudeSkillScanText = Effect.fn("ClaudeDiscovery.readSkillScanText")(function* (
  fileSystem: FileSystem.FileSystem,
  path: string,
  limit: number,
  budget: ClaudeSkillScanBudget,
) {
  const maxBytes = Math.min(limit, budget.remainingBytes);
  if (maxBytes <= 0) return undefined;
  const info = yield* fileSystem.stat(path).pipe(Effect.orElseSucceed(() => undefined));
  if (info?.type !== "File") return undefined;
  if (info.size > BigInt(maxBytes)) return undefined;
  return yield* collectStreamAsString(
    fileSystem.stream(path, { bytesToRead: maxBytes + 1, chunkSize: 64 * 1024 }).pipe(
      Stream.tap((chunk) =>
        Effect.sync(() => {
          budget.remainingBytes -= chunk.byteLength;
        }),
      ),
    ),
    { maxBytes },
  ).pipe(Effect.orElseSucceed(() => undefined));
});
