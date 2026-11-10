import { fromLenientJson } from "@goat/shared/schemaJson";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      autoCompactWindow: Schema.optionalKey(Schema.Unknown),
      modelSettings: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);

function windowFrom(settings: unknown, model: string): string | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const models = Reflect.get(settings, "modelSettings");
  const entry =
    typeof models === "object" && models !== null ? Reflect.get(models, model) : undefined;
  const modelWindow =
    typeof entry === "object" && entry !== null
      ? Reflect.get(entry, "autoCompactWindow")
      : undefined;
  const validWindow = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 100_000 && value <= 1_000_000
      ? String(value)
      : undefined;
  return modelWindow === "auto"
    ? ""
    : (validWindow(modelWindow) ?? validWindow(Reflect.get(settings, "autoCompactWindow")));
}

export const resolveAutoCompactWindow = Effect.fn("ClaudeAdapterV2.resolveAutoCompactWindow")(
  function* (input: {
    readonly configured: string;
    readonly model: string;
    readonly launchSettings: unknown;
    readonly files: ReadonlyArray<string>;
    readonly fileSystem: FileSystem.FileSystem;
  }) {
    if (input.configured !== "") return input.configured;
    const model = input.model.replace(/\[1m\]$/i, "");
    const launch = windowFrom(input.launchSettings, model);
    if (launch !== undefined) return launch;
    for (const file of input.files) {
      const settings = yield* input.fileSystem
        .readFileString(file)
        .pipe(Effect.flatMap(decodeSettings), Effect.option);
      const value = Option.isSome(settings) ? windowFrom(settings.value, model) : undefined;
      if (value !== undefined) return value;
    }
    return "";
  },
);

const decodeEnvSettings = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.StructWithRest(
      Schema.Struct({ env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ),
);
export const readToolSearchSetting = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.flatMap(decodeEnvSettings),
    Effect.map((settings) => {
      const value = settings.env?.ENABLE_TOOL_SEARCH;
      return typeof value === "string" ? value : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );

/** The CLI reports a compaction it aborted for our interrupt as failed; callers pass that check in. */
export const claudeCompactionOutcome = (succeeded: boolean, failed: boolean) =>
  succeeded
    ? ({ status: "completed", title: "Context compacted" } as const)
    : failed
      ? ({ status: "failed", title: "Context compaction failed" } as const)
      : ({ status: "interrupted", title: "Context compaction stopped" } as const);
