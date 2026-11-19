import { fromLenientJson } from "@goat/shared/schemaJson";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeEnvSettings = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);

const decodeCompactSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const settingsField = (settings: unknown, key: string): unknown =>
  typeof settings === "object" && settings !== null ? Reflect.get(settings, key) : undefined;

const settingsEnv = (settings: unknown, key: string) => {
  const value = settingsField(settingsField(settings, "env"), key);
  return typeof value === "string" ? value : undefined;
};

function windowFrom(settings: unknown, model: string): string | undefined {
  const modelWindow = settingsField(
    settingsField(settingsField(settings, "modelSettings"), model),
    "autoCompactWindow",
  );
  const validWindow = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 100_000 && value <= 1_000_000
      ? String(value)
      : undefined;
  return modelWindow === "auto"
    ? ""
    : (validWindow(modelWindow) ?? validWindow(settingsField(settings, "autoCompactWindow")));
}

export const resolveAutoCompactWindow = Effect.fn("ClaudeAdapterV2.resolveAutoCompactWindow")(
  function* (input: {
    readonly configured: string;
    readonly model: string;
    readonly launchSettings: unknown;
    readonly files: ReadonlyArray<string>;
    readonly environment: NodeJS.ProcessEnv;
    readonly fileSystem: FileSystem.FileSystem;
  }) {
    const model = input.model.replace(/\[1m\]$/i, "");
    const disableNames = ["DISABLE_COMPACT", "DISABLE_AUTO_COMPACT"] as const;
    const windowName = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
    const environment = new Map(
      [...disableNames, windowName].map((name) => [name, settingsEnv(input.launchSettings, name)]),
    );
    const launchEnabled = settingsField(input.launchSettings, "autoCompactEnabled");
    let enabled = typeof launchEnabled === "boolean" ? launchEnabled : undefined;
    let settingsWindow = windowFrom(input.launchSettings, model);
    for (const file of input.files) {
      if (
        enabled !== undefined &&
        settingsWindow !== undefined &&
        [...environment.values()].every((value) => value !== undefined)
      )
        break;
      const text = yield* input.fileSystem
        .readFileString(file)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (text === undefined) continue;
      const settings = Option.getOrUndefined(decodeCompactSettings(text));
      const envSettings =
        settings ?? (yield* decodeEnvSettings(text).pipe(Effect.orElseSucceed(() => undefined)));
      for (const [name, value] of environment) {
        if (value === undefined) environment.set(name, settingsEnv(envSettings, name));
      }
      const fileEnabled = settings?.autoCompactEnabled;
      if (enabled === undefined && typeof fileEnabled === "boolean") enabled = fileEnabled;
      settingsWindow ??= windowFrom(settings, model);
    }
    const env = (name: string) => environment.get(name) ?? input.environment[name];
    if (
      enabled === false ||
      disableNames.some((name) =>
        ["1", "true", "yes", "on"].includes(env(name)?.trim().toLowerCase() ?? ""),
      )
    )
      return "";
    if (input.configured !== "") return input.configured;
    const numeric = Number(env(windowName));
    if (Number.isInteger(numeric) && numeric >= 100_000 && numeric <= 1_000_000)
      return String(numeric);
    return settingsWindow ?? "";
  },
);

export const readToolSearchSetting = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.flatMap(decodeEnvSettings),
    Effect.map((settings) => settingsEnv(settings, "ENABLE_TOOL_SEARCH")),
    Effect.orElseSucceed(() => undefined),
  );

/** The CLI reports a compaction it aborted for our interrupt as failed; callers pass that check in. */
export const claudeCompactionOutcome = (succeeded: boolean, failed: boolean) =>
  succeeded
    ? ({ status: "completed", title: "Context compacted" } as const)
    : failed
      ? ({ status: "failed", title: "Context compaction failed" } as const)
      : ({ status: "interrupted", title: "Context compaction stopped" } as const);
