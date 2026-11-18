// @effect-diagnostics nodeBuiltinImport:off -- Bounded reads must avoid following ignore-file symlinks or blocking on a FIFO.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { type IgnoreFile, parseIgnoreFile } from "./IgnorePatterns.ts";

const MAX_IGNORE_DIRECTORIES = 1_024;
const MAX_IGNORE_BYTES = 256 * 1024;
const MAX_IGNORE_FILE_BYTES = 64 * 1024;

export async function readIgnoreFile(path: string, maxBytes = MAX_IGNORE_FILE_BYTES) {
  const handle = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_NOFOLLOW ?? 0) |
      (NodeFS.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    if (stat.size > Math.min(maxBytes, MAX_IGNORE_FILE_BYTES)) return "unavailable" as const;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) return "unavailable" as const;
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function makeIgnoreFileDecider(cwd: string, filename: ".ignore" | ".gitignore" = ".ignore") {
  const cache = new Map<string, IgnoreFile | "unavailable" | undefined>();
  let remainingBytes = MAX_IGNORE_BYTES;
  // Both helpers share the search span and run per candidate path.
  const load = Effect.fnUntraced(function* (directory: string) {
    if (cache.has(directory)) return cache.get(directory);
    if (cache.size >= MAX_IGNORE_DIRECTORIES) return "unavailable" as const;
    const contents = yield* Effect.tryPromise(() =>
      readIgnoreFile(NodePath.join(cwd, directory, filename)),
    ).pipe(Effect.orElseSucceed(() => undefined));
    const file =
      contents === undefined || contents === "unavailable"
        ? contents
        : contents.length > remainingBytes
          ? "unavailable"
          : parseIgnoreFile(contents.toString());
    if (Buffer.isBuffer(contents) && file !== "unavailable") remainingBytes -= contents.length;
    cache.set(directory, file);
    return file;
  });

  const decide = Effect.fnUntraced(function* (relativePath: string, isFolder: boolean) {
    let separator = relativePath.lastIndexOf("/");
    while (true) {
      const file = yield* load(separator < 0 ? "" : relativePath.slice(0, separator));
      if (file === "unavailable") return file;
      const decision = file?.decide(relativePath.slice(separator + 1), isFolder);
      if (decision !== undefined || separator < 0) return decision;
      separator = relativePath.lastIndexOf("/", separator - 1);
    }
  });

  return decide;
}
