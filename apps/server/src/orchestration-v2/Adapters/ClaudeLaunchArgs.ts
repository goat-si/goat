import type { Settings as ClaudeSdkSettings } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSettings } from "@goat/contracts";
import { parseCliArgs } from "@goat/shared/cliArgs";
import { fromLenientJson } from "@goat/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class ClaudeAppendSystemPromptFileError extends Schema.TaggedError<ClaudeAppendSystemPromptFileError>()(
  "ClaudeAppendSystemPromptFileError",
  {
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Claude could not read the --append-system-prompt-file launch argument at ${this.path}. Fix the path in the Claude launch arguments, then send the message again.`;
  }
}

export class ClaudeAppendSystemPromptMissingValueError extends Schema.TaggedError<ClaudeAppendSystemPromptMissingValueError>()(
  "ClaudeAppendSystemPromptMissingValueError",
  { flag: Schema.Literals(["--append-system-prompt", "--append-system-prompt-file"]) },
) {
  override get message(): string {
    return `The ${this.flag} launch argument has no ${this.flag === "--append-system-prompt" ? "text" : "file path"}. Add it after the flag in the Claude launch arguments, then send the message again.`;
  }
}

export class ClaudeSettingsLaunchArgError extends Schema.TaggedError<ClaudeSettingsLaunchArgError>()(
  "ClaudeSettingsLaunchArgError",
  { path: Schema.optional(Schema.String), cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Claude could not read the --settings launch argument${this.path === undefined ? "" : ` at ${this.path}`} as a JSON object. Fix it in the Claude launch arguments, then send the message again.`;
  }
}

/**
 * Checks the append launch arguments the way the Claude CLI would and reads
 * the file relative to the process cwd. makeClaudeQueryOptions folds these
 * flags out of extraArgs, so a value the CLI would have rejected has to be
 * rejected here or it silently disappears.
 */
export const readClaudeAppendSystemPromptFile = Effect.fnUntraced(function* (input: {
  readonly settings: ClaudeSettings | undefined;
  readonly cwd: string | null;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  if (input.settings === undefined) return undefined;
  const flags = parseCliArgs(input.settings.launchArgs).flags;
  // parseCliArgs gives null for a flag with no following value. An explicit
  // `--append-system-prompt ""` is a value the CLI accepts, so it stays.
  if (flags["append-system-prompt"] === null) {
    return yield* new ClaudeAppendSystemPromptMissingValueError({
      flag: "--append-system-prompt",
    });
  }
  const file = flags["append-system-prompt-file"];
  if (file === undefined) return undefined;
  // `--append-system-prompt-file=` is "" and names no file either.
  if (file === null || file === "") {
    return yield* new ClaudeAppendSystemPromptMissingValueError({
      flag: "--append-system-prompt-file",
    });
  }
  const filePath = input.path.resolve(input.cwd ?? ".", file);
  return yield* input.fileSystem
    .readFileString(filePath)
    .pipe(
      Effect.mapError((cause) => new ClaudeAppendSystemPromptFileError({ path: filePath, cause })),
    );
});

const decodeClaudeLaunchArgSettings = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);

export const readClaudeLaunchArgSettings = Effect.fn("ClaudeAdapterV2.readLaunchArgSettings")(
  function* (input: {
    readonly settings: ClaudeSettings | undefined;
    readonly cwd: string | null;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) {
    if (input.settings === undefined) return undefined;
    const value = parseCliArgs(input.settings.launchArgs).flags.settings;
    if (value === undefined) return undefined;
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0) return yield* new ClaudeSettingsLaunchArgError({});
    if (trimmed.startsWith("{")) {
      return (yield* decodeClaudeLaunchArgSettings(trimmed).pipe(
        Effect.mapError((cause) => new ClaudeSettingsLaunchArgError({ cause })),
      )) as ClaudeSdkSettings;
    }
    const filePath = input.path.resolve(input.cwd ?? ".", trimmed);
    return (yield* input.fileSystem.readFileString(filePath).pipe(
      Effect.flatMap(decodeClaudeLaunchArgSettings),
      Effect.mapError((cause) => new ClaudeSettingsLaunchArgError({ path: filePath, cause })),
    )) as ClaudeSdkSettings;
  },
);
