import type { ProviderReplayTranscript } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

/**
 * While a foreground Bash call runs, Claude Code writes its output to a task
 * file the adapter tails. A replay has no Claude Code process, so it writes the
 * file each recorded `task_started` names, holding that call's recorded output,
 * under `taskRoot`.
 */
const writeReplayTaskOutputFiles = Effect.fn("ClaudeReplay.writeTaskOutputFiles")(function* (
  transcript: Pick<ProviderReplayTranscript, "entries">,
  taskRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const frames = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" && typeof entry.frame === "object" && entry.frame !== null
      ? [entry.frame as Record<string, unknown>]
      : [],
  );
  const outputByToolUseId = new Map<string, string>();
  for (const frame of frames) {
    const result = frame.tool_use_result as Record<string, unknown> | undefined;
    const content = (frame.message as { readonly content?: unknown } | undefined)?.content;
    if (typeof result?.stdout !== "string" || !Array.isArray(content)) continue;
    const toolResult = content.find(
      (block): block is { readonly tool_use_id: string } =>
        block?.type === "tool_result" && typeof block.tool_use_id === "string",
    );
    if (toolResult === undefined) continue;
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    outputByToolUseId.set(toolResult.tool_use_id, `${result.stdout}${stderr}`);
  }
  for (const frame of frames) {
    if (frame.type !== "system" || frame.subtype !== "task_started") continue;
    if (frame.task_type !== "local_bash" || frame.is_backgrounded !== false) continue;
    const output =
      typeof frame.tool_use_id === "string" ? outputByToolUseId.get(frame.tool_use_id) : undefined;
    if (output === undefined || typeof frame.session_id !== "string") continue;
    const tasks = path.join(taskRoot, "replay-project", frame.session_id, "tasks");
    yield* fileSystem.makeDirectory(tasks, { recursive: true });
    yield* fileSystem.writeFileString(path.join(tasks, `${String(frame.task_id)}.output`), output);
  }
});

/**
 * Which variable points the replayed Claude Code process at its temp directory:
 * the `CLAUDE_CODE_TMPDIR` override, or, with that unset, `os.tmpdir()` on a
 * Windows host, which reads TEMP, then TMP.
 */
export type ClaudeReplayTempVariable = "CLAUDE_CODE_TMPDIR" | "TEMP" | "TMP";

const WINDOWS_TEMP_VARIABLES = new Set(["CLAUDE_CODE_TMPDIR", "TEMP", "TMP"]);

/**
 * Sets up a scenario-owned temp directory the way `tempVariable` would hand it to
 * Claude Code, and writes the replay's task files where Claude Code puts them. The
 * layout is spelled out here, apart from the adapter's locator, so a locator that
 * drifts from Claude Code fails the replay instead of following it.
 */
export const makeReplayTaskOutputTemp = Effect.fn("ClaudeReplay.makeTaskOutputTemp")(function* (
  transcript: Pick<ProviderReplayTranscript, "entries">,
  tempVariable: ClaudeReplayTempVariable,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tmpRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-replay-tasks-" });
  if (tempVariable === "CLAUDE_CODE_TMPDIR") {
    const uid = yield* HostProcess.UserId;
    yield* writeReplayTaskOutputFiles(
      transcript,
      path.join(tmpRoot, uid === undefined ? "claude" : `claude-${uid}`),
    );
    return {
      instanceEnvironment: [{ name: "CLAUDE_CODE_TMPDIR", value: tmpRoot, sensitive: false }],
      host: Layer.empty,
    };
  }
  // A Windows host: no uid, and no temp variable but the scenario's one, so the
  // host's own TEMP, TMP or override cannot decide where the adapter looks.
  yield* writeReplayTaskOutputFiles(transcript, path.join(tmpRoot, "claude"));
  const hostEnvironment = Object.fromEntries(
    Object.entries(yield* HostProcess.Environment).filter(
      ([name]) => !WINDOWS_TEMP_VARIABLES.has(name.toUpperCase()),
    ),
  );
  return {
    instanceEnvironment: [],
    host: Layer.mergeAll(
      Layer.succeed(HostProcess.Environment, { ...hostEnvironment, [tempVariable]: tmpRoot }),
      Layer.succeed(HostProcess.UserId, undefined),
    ),
  };
});
