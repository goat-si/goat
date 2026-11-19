import type { ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import { isCompressedTranscript } from "./AgentSessionTranscriptChunks.ts";
import type { TranscriptCandidate } from "./AgentSessionTranscriptDiscovery.ts";
import { transcriptIdentity } from "./AgentSessionTranscriptIdentity.ts";

const MAX_QUEUED_DISCOVERY_ENTRIES = 20_000;

type Action =
  | { readonly kind: "directory"; readonly path: string; readonly depth: number }
  | { readonly kind: "file"; readonly path: string };

export const discoverOtherHomes = Effect.fn("AgentSessionScanner.discoverOtherHomes")(
  function* (input: {
    readonly source: "codex" | "pi";
    readonly homes: ReadonlyArray<{ homePath: string; providerInstanceId: ProviderInstanceId }>;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly operationBudget: number;
  }) {
    const { fileSystem, path, source } = input;
    const homes = input.homes.slice(0, MAX_QUEUED_DISCOVERY_ENTRIES);
    let queued = homes.length;
    let truncated = homes.length !== input.homes.length;
    const cursors = homes.map((home) => ({
      home,
      actions: [
        {
          kind: "directory",
          path: source === "codex" ? path.join(home.homePath, "sessions") : home.homePath,
          depth: 0,
        } as Action,
      ],
    }));
    const transcripts: Array<TranscriptCandidate> = [];
    const advance = Effect.fn("AgentSessionScanner.advanceOtherDiscovery")(function* (
      cursor: (typeof cursors)[number],
      allowance: number,
    ) {
      let used = 0;
      while (used < allowance && cursor.actions.length > 0) {
        const action = cursor.actions.pop();
        if (action === undefined) break;
        queued--;
        used++;
        if (action.kind === "file") {
          const info = yield* fileSystem
            .stat(action.path)
            .pipe(Effect.asSome, Effect.orElseSucceed(Option.none));
          if (Option.isSome(info) && info.value.type === "File" && Option.isSome(info.value.mtime))
            transcripts.push({
              filePath: action.path,
              mtimeMs: info.value.mtime.value.getTime(),
              providerInstanceId: cursor.home.providerInstanceId,
              homePath: cursor.home.homePath,
              identity: transcriptIdentity(action.path, info.value),
            });
          continue;
        }
        const names = yield* fileSystem
          .readDirectory(action.path)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        const ordered = source === "codex" ? names.toSorted().toReversed() : names;
        const children: Array<Action> = [];
        for (const name of ordered) {
          let child: Action | undefined;
          if (source === "codex") {
            if (action.depth < 3)
              child = {
                kind: "directory",
                path: path.join(action.path, name),
                depth: action.depth + 1,
              };
            else if (
              name.startsWith("rollout-") &&
              (name.endsWith(".jsonl") || isCompressedTranscript(name))
            )
              child = { kind: "file", path: path.join(action.path, name) };
          } else if (name.endsWith(".jsonl"))
            child = { kind: "file", path: path.join(action.path, name) };
          else if (action.depth === 0)
            child = { kind: "directory", path: path.join(action.path, name), depth: 1 };
          if (child === undefined) continue;
          if (queued + children.length === MAX_QUEUED_DISCOVERY_ENTRIES) {
            truncated = true;
            break;
          }
          children.push(child);
        }
        for (const child of children.toReversed()) {
          cursor.actions.push(child);
          queued++;
        }
      }
      return used;
    });
    let remaining = input.operationBudget;
    for (const [index, cursor] of cursors.entries()) {
      const share =
        Math.floor(input.operationBudget / Math.max(1, cursors.length)) +
        (index < input.operationBudget % Math.max(1, cursors.length) ? 1 : 0);
      remaining -= yield* advance(cursor, share);
    }
    let active = cursors.filter((cursor) => cursor.actions.length > 0);
    while (remaining > 0 && active.length > 0) {
      let spent = 0;
      for (const [index, cursor] of active.entries()) {
        const used = yield* advance(cursor, Math.ceil(remaining / (active.length - index)));
        remaining -= used;
        spent += used;
      }
      if (spent === 0) break;
      active = active.filter((cursor) => cursor.actions.length > 0);
    }
    return { transcripts, truncated: truncated || active.length > 0 };
  },
);
