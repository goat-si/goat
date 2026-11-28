import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { field } from "../unknownField.ts";
import {
  claudeMessagesBeforeTrailingAborts,
  type ClaudeHistoryMessage,
} from "./ClaudeInterruptedResume.ts";
import {
  isClaudeConversationLine,
  isClaudeTranscriptConversationLine,
} from "./claudeTranscriptLines.ts";

// Transcript lines can exceed 100 KB; the tail only has to reach this process's last message.
const CLAUDE_TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
// A long terminal exchange pushes that message out of the tail; one wider read looks for it.
const CLAUDE_TRANSCRIPT_WIDE_TAIL_BYTES = 32 * 1024 * 1024;

const claudeProjectsDir = Effect.fnUntraced(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly path: Path.Path;
}) {
  const configuredDir = input.environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  return input.path.join(
    configuredDir.length > 0
      ? input.path.resolve(input.cwd, configuredDir)
      : input.path.join(yield* HostProcess.HomeDirectory, ".claude"),
    "projects",
  );
});

const locateClaudeTranscript = Effect.fnUntraced(function* (input: {
  readonly nativeThreadId: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const projectsDir = yield* claudeProjectsDir(input);
  let newest: { readonly path: string; readonly mtime: number } | undefined;
  for (const project of yield* input.fileSystem.readDirectory(projectsDir)) {
    const candidate = input.path.join(projectsDir, project, `${input.nativeThreadId}.jsonl`);
    const info = yield* input.fileSystem.stat(candidate).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") continue;
    const mtime = Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0;
    if (newest === undefined || mtime > newest.mtime) newest = { path: candidate, mtime };
  }
  return newest?.path;
});

/**
 * Whether a live process missed messages a terminal `claude --resume` appended to its session.
 * Anchors on the last message the process emitted; Claude flushes the file after streaming, so
 * an emitted message can be missing from it. Lines with no anchor before them prove nothing:
 * they can all predate the process, so the answer is undefined.
 */
function claudeTranscriptHasUnseenMessages(
  lines: ReadonlyArray<string>,
  emittedUuids: ReadonlySet<string>,
): boolean | undefined {
  let anchored = false;
  let unseen: Array<ClaudeHistoryMessage> = [];
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const uuid = field(entry, "uuid");
    if (typeof uuid !== "string" || !isClaudeTranscriptConversationLine(entry)) continue;
    if (emittedUuids.has(uuid)) {
      anchored = true;
      unseen = [];
      continue;
    }
    if (
      field(entry, "isSidechain") === true ||
      field(entry, "isMeta") === true ||
      field(entry, "isCompactSummary") === true
    ) {
      continue;
    }
    unseen.push({ type: entry.type, uuid, message: { content: entry.message.content } });
  }
  return anchored ? claudeMessagesBeforeTrailingAborts(unseen) > 0 : undefined;
}

// A failed read keeps the process: replacing it is only right when the file proves a miss.
const liveProcessMissedTranscriptMessages = Effect.fn(
  "ClaudeAdapterV2.liveProcessMissedTranscriptMessages",
)(
  function* (input: {
    readonly live: {
      readonly nativeThreadId: string;
      readonly environment: NodeJS.ProcessEnv;
      readonly emittedMessageUuids: ReadonlySet<string>;
      transcriptPath: string | undefined;
    };
    readonly cwd: string;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) {
    if (input.live.emittedMessageUuids.size === 0) return false;
    input.live.transcriptPath ??= yield* locateClaudeTranscript({
      nativeThreadId: input.live.nativeThreadId,
      environment: input.live.environment,
      cwd: input.cwd,
      fileSystem: input.fileSystem,
      path: input.path,
    });
    const transcriptPath = input.live.transcriptPath;
    if (transcriptPath === undefined) return false;
    const readTail = (maxBytes: number) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* input.fileSystem.open(transcriptPath, { flag: "r" });
          const size = Number((yield* handle.stat).size);
          const start = Math.max(0, size - maxBytes);
          yield* handle.seek(BigInt(start), "start");
          const bytes = yield* handle.readAlloc(size - start);
          const lines = (Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : "").split(
            "\n",
          );
          // The last piece is empty or a line Claude is still writing; a cut tail starts
          // mid-line.
          lines.pop();
          if (start > 0) lines.shift();
          return { lines, wholeFile: start === 0 };
        }),
      );
    for (const maxBytes of [CLAUDE_TRANSCRIPT_TAIL_BYTES, CLAUDE_TRANSCRIPT_WIDE_TAIL_BYTES]) {
      const tail = yield* readTail(maxBytes);
      const missed = claudeTranscriptHasUnseenMessages(tail.lines, input.live.emittedMessageUuids);
      if (missed !== undefined) return missed;
      if (tail.wholeFile) break;
    }
    return false;
  },
  Effect.orElseSucceed(() => false),
);

export const shouldReplaceStaleClaudeProcess = Effect.fnUntraced(function* (input: {
  readonly threadId: string;
  readonly live: {
    readonly nativeThreadId: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly emittedMessageUuids: ReadonlySet<string>;
    transcriptPath: string | undefined;
  };
  readonly keepsWork: Effect.Effect<boolean>;
  readonly cwd: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  // Decided before the transcript read: with no pending wakeup then, none can fire during it.
  const keepsWork = yield* input.keepsWork;
  if (!(yield* liveProcessMissedTranscriptMessages(input))) return false;
  if (keepsWork) {
    yield* Effect.logWarning("orchestration-v2.claude-stale-process-kept-for-background-work", {
      threadId: input.threadId,
      nativeThreadId: input.live.nativeThreadId,
    });
    return false;
  }
  return true;
});

// Metadata-only transcripts cannot be resumed or recreated; fail resumeThread to trigger a fresh session and handoff.
export const readClaudeTranscriptState = Effect.fn("ClaudeAdapterV2.readClaudeTranscriptState")(
  function* (input: {
    readonly nativeThreadId: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) {
    const projectsDir = yield* claudeProjectsDir(input);
    // Any message in any transcript copy means Claude may still resume it.
    let found = false;
    let unreadable = false;
    for (const project of yield* input.fileSystem.readDirectory(projectsDir)) {
      const transcriptPath = input.path.join(projectsDir, project, `${input.nativeThreadId}.jsonl`);
      // Stray files beside the project dirs fail with ENOTDIR.
      if (
        !(yield* input.fileSystem.exists(transcriptPath).pipe(Effect.orElseSucceed(() => false)))
      ) {
        continue;
      }
      const conversationLine = yield* input.fileSystem
        .stream(transcriptPath)
        .pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.filter(isClaudeConversationLine),
          Stream.runHead,
          Effect.option,
        );
      if (Option.isNone(conversationLine)) {
        unreadable = true;
        continue;
      }
      if (Option.isSome(conversationLine.value)) {
        return "conversation" as const;
      }
      found = true;
    }
    return found && !unreadable ? ("empty" as const) : ("missing" as const);
  },
);
