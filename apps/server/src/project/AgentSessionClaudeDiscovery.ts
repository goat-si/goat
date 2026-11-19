import type { ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import { transcriptIdentity } from "./AgentSessionTranscriptIdentity.ts";
import type { TranscriptCandidate } from "./AgentSessionTranscriptDiscovery.ts";

const MAX_DIRECTORY_DATES = 20_000;
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_FILE_ENTRIES = 20_000;

export const discoverClaudeHomes = Effect.fn("AgentSessionScanner.discoverClaudeHomes")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly homes: ReadonlyArray<{ homePath: string; providerInstanceId: ProviderInstanceId }>;
    readonly operationBudget: number;
  }) {
    const { fileSystem, path } = input;
    const homes = input.homes.slice(0, MAX_DIRECTORY_ENTRIES);
    const list = (directory: string) =>
      fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const stat = (entry: string) =>
      fileSystem.stat(entry).pipe(Effect.asSome, Effect.orElseSucceed(Option.none));
    let dateBudget = MAX_DIRECTORY_DATES;
    let remainingDirectories = MAX_DIRECTORY_ENTRIES;
    let remainingFiles = MAX_FILE_ENTRIES;
    const cursors = homes.map((home) => ({
      home,
      initialized: false,
      directories: [] as Array<string>,
      directoryIndex: 0,
      files: [] as Array<string>,
      fileIndex: 0,
      truncated: false,
      done: false,
    }));
    const transcripts: Array<TranscriptCandidate> = [];
    const advance = Effect.fn("AgentSessionScanner.advanceClaudeDiscovery")(function* (
      cursor: (typeof cursors)[number],
      allowance: number,
    ) {
      let used = 0;
      if (!cursor.initialized && allowance > 0) {
        used++;
        cursor.initialized = true;
        const root = path.join(cursor.home.homePath, "projects");
        const names = yield* list(root);
        const keep = Math.min(names.length, remainingDirectories);
        if (keep < names.length) cursor.truncated = true;
        remainingDirectories -= keep;
        const dated: Array<{ name: string; mtime: number }> = [];
        const undated: Array<string> = [];
        for (const name of names.slice(0, keep)) {
          if (dateBudget === 0) {
            cursor.truncated = true;
            undated.push(name);
            continue;
          }
          dateBudget--;
          const info = yield* stat(path.join(root, name));
          if (Option.isSome(info) && info.value.type === "Directory")
            dated.push({
              name,
              mtime: Option.isSome(info.value.mtime) ? info.value.mtime.value.getTime() : 0,
            });
          else remainingDirectories++;
        }
        cursor.directories = [
          ...dated
            .toSorted((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
            .map((entry) => entry.name),
          ...undated,
        ];
      }
      while (used < allowance && cursor.directoryIndex < cursor.directories.length) {
        const directoryName = cursor.directories[cursor.directoryIndex];
        if (directoryName === undefined) break;
        const directory = path.join(cursor.home.homePath, "projects", directoryName);
        if (cursor.files.length === 0) {
          used++;
          const names = (yield* list(directory)).filter((name) => name.endsWith(".jsonl"));
          const keep = Math.min(names.length, remainingFiles);
          if (keep < names.length) cursor.truncated = true;
          remainingFiles -= keep;
          cursor.files = names.slice(0, keep);
          cursor.fileIndex = 0;
          if (cursor.files.length === 0) {
            cursor.directoryIndex++;
            remainingDirectories++;
            continue;
          }
        }
        while (used < allowance && cursor.fileIndex < cursor.files.length) {
          const name = cursor.files[cursor.fileIndex++];
          if (name === undefined) break;
          const filePath = path.join(directory, name);
          remainingFiles++;
          used++;
          const info = yield* stat(filePath);
          if (Option.isSome(info) && info.value.type === "File" && Option.isSome(info.value.mtime))
            transcripts.push({
              filePath,
              mtimeMs: info.value.mtime.value.getTime(),
              providerInstanceId: cursor.home.providerInstanceId,
              homePath: cursor.home.homePath,
              identity: transcriptIdentity(filePath, info.value),
            });
        }
        if (cursor.fileIndex === cursor.files.length) {
          cursor.files = [];
          cursor.directoryIndex++;
          remainingDirectories++;
        }
      }
      cursor.done = cursor.initialized && cursor.directoryIndex === cursor.directories.length;
      return used;
    });
    let remaining = input.operationBudget;
    for (const [index, cursor] of cursors.entries()) {
      const share =
        Math.floor(input.operationBudget / Math.max(1, cursors.length)) +
        (index < input.operationBudget % Math.max(1, cursors.length) ? 1 : 0);
      remaining -= yield* advance(cursor, share);
    }
    let active = cursors.filter((cursor) => !cursor.done);
    while (remaining > 0 && active.length > 0) {
      let spent = 0;
      for (const [index, cursor] of active.entries()) {
        const share = Math.ceil(remaining / (active.length - index));
        const used = yield* advance(cursor, share);
        remaining -= used;
        spent += used;
      }
      if (spent === 0) break;
      active = active.filter((cursor) => !cursor.done);
    }
    return {
      transcripts,
      truncated:
        homes.length !== input.homes.length ||
        cursors.some((cursor) => !cursor.done || cursor.truncated),
    };
  },
);
