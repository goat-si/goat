import {
  type ModelInfo as ClaudeModelInfo,
  resolveSettings as resolveClaudeSettings,
  type SettingSource,
  type Settings as ClaudeSdkSettings,
} from "@anthropic-ai/claude-agent-sdk";
import { fromLenientJson } from "@goat/shared/schemaJson";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { claudeLocalSettingsDirectory } from "./Drivers/ClaudeHome.ts";
import { type ClaudeModelCatalog, withClaudeCodeModelRoutes } from "./ClaudeModelCatalog.ts";

// Env names that pick the backend, its region, or the model a family alias resolves to.
const MODEL_SETTINGS_ENV_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_",
  "AWS_",
  "CLOUD_ML_",
  "VERTEX_",
];

/** Equal keys mean Claude Code resolves model ids the same way under both settings. */
const ClaudeModelSettings = Schema.Struct({
  availableModels: Schema.optionalKey(Schema.Unknown),
  modelOverrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeClaudeModelSettings = Schema.decodeUnknownEffect(fromLenientJson(ClaudeModelSettings));

function claudeModelSettingsKey(
  settings: typeof ClaudeModelSettings.Type,
  environment?: NodeJS.ProcessEnv,
): string {
  const sortedEntries = (record: Readonly<Record<string, unknown>> | undefined) =>
    Object.entries(record ?? {}).toSorted(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    settings.availableModels ?? null,
    sortedEntries(settings.modelOverrides),
    sortedEntries({ ...environment, ...settings.env }).filter(([name]) =>
      MODEL_SETTINGS_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
    ),
  ]);
}

const NO_MODEL_SETTINGS_KEY = claudeModelSettingsKey({});

class ClaudeModelSettingsReadError extends Schema.TaggedError<ClaudeModelSettingsReadError>()(
  "ClaudeModelSettingsReadError",
  { cause: Schema.Defect() },
) {}

export const resolveClaudeModelSettingsKey = Effect.fn("resolveClaudeModelSettingsKey")(function* (
  settingSources: ReadonlyArray<SettingSource>,
  cwd: string | null,
  environment?: NodeJS.ProcessEnv,
) {
  // The SDK reads the local file from cwd, Claude Code from the main checkout's root. No key, so
  // no routes, when that root file touches model settings.
  const localDirectory = cwd === null ? null : yield* claudeLocalSettingsDirectory(cwd);
  if (localDirectory !== null && localDirectory !== cwd) {
    const rootLocal = yield* Effect.tryPromise({
      try: () => resolveClaudeSettings({ cwd: localDirectory, settingSources: ["local"] }),
      catch: (cause) => new ClaudeModelSettingsReadError({ cause }),
    }).pipe(
      Effect.map(({ sources }) => sources.find(({ source }) => source === "local")?.settings),
      Effect.orElseSucceed(() => undefined),
    );
    if (claudeModelSettingsKey(rootLocal ?? {}) !== NO_MODEL_SETTINGS_KEY) return undefined;
  }
  const effective = yield* Effect.tryPromise({
    try: () =>
      resolveClaudeSettings({
        ...(cwd === null ? {} : { cwd }),
        settingSources: [...settingSources],
      }),
    catch: (cause) => new ClaudeModelSettingsReadError({ cause }),
  }).pipe(
    Effect.map(({ effective }) => claudeModelSettingsKey(effective, environment)),
    Effect.orElseSucceed(() => undefined),
  );
  const configDir = environment?.CLAUDE_CONFIG_DIR?.trim();
  if (effective === undefined || !configDir) return effective;

  // The SDK resolves the host's user source; the subprocess can load an instance-scoped home.
  const path = yield* Path.Path;
  if (cwd === null && !path.isAbsolute(configDir)) return undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  const settingsPath = path.resolve(cwd ?? ".", configDir, "settings.json");
  const userSettings = yield* fileSystem.readFileString(settingsPath).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("{}")),
    Effect.flatMap(decodeClaudeModelSettings),
    Effect.option,
  );
  return Option.isNone(userSettings)
    ? undefined
    : JSON.stringify([effective, settingsPath, claudeModelSettingsKey(userSettings.value)]);
});

export type RouteClaudeModelCatalog = (
  catalog: ClaudeModelCatalog,
  cwd: string | null,
  launchSettings?: ClaudeSdkSettings,
  environment?: NodeJS.ProcessEnv,
) => Effect.Effect<ClaudeModelCatalog>;

type ReportedModel = Pick<ClaudeModelInfo, "value" | "resolvedModel">;

/**
 * Claude Code's reported model ids, applied to a turn only where its cwd resolves model settings
 * as the probe's cwd did. `settle` releases turns waiting for the first probe, whatever its outcome.
 */
export const makeClaudeCodeModelRoutes = Effect.fn("makeClaudeCodeModelRoutes")(function* (
  settingsKey: (
    cwd: string | null,
    environment?: NodeJS.ProcessEnv,
  ) => Effect.Effect<string | undefined>,
  probeCwd: string,
) {
  const firstProbeSettled = yield* Deferred.make<void>();
  const reported = yield* Ref.make<{
    readonly models: ReadonlyArray<ReportedModel>;
    readonly settingsKey: string | undefined;
  }>({ models: [], settingsKey: undefined });
  return {
    record: Effect.fn("ClaudeCodeModelRoutes.record")(function* (
      models: ReadonlyArray<ReportedModel>,
      environment?: NodeJS.ProcessEnv,
    ) {
      yield* Ref.set(reported, { models, settingsKey: yield* settingsKey(probeCwd, environment) });
    }),
    settle: Deferred.succeed(firstProbeSettled, undefined).pipe(Effect.asVoid),
    route: Effect.fn("ClaudeCodeModelRoutes.route")(function* (
      base: ClaudeModelCatalog,
      cwd: string | null,
      launchSettings?: ClaudeSdkSettings,
      environment?: NodeJS.ProcessEnv,
    ) {
      // Leave room for the sequential version and capability probes before falling back once;
      // an expired wait counts as settled so later calls do not wait again.
      yield* Deferred.await(firstProbeSettled).pipe(
        Effect.timeoutOption("2 minutes"),
        Effect.andThen(Deferred.succeed(firstProbeSettled, undefined)),
      );
      if (claudeModelSettingsKey(launchSettings ?? {}) !== NO_MODEL_SETTINGS_KEY) return base;
      const { models, settingsKey: probeKey } = yield* Ref.get(reported);
      const routed = withClaudeCodeModelRoutes(base, models);
      // Project settings can point an alias at another model, so routes hold only where the
      // cwd resolves the same model settings as the probe's.
      if (routed === base || probeKey === undefined) return base;
      return (yield* settingsKey(cwd, environment)) === probeKey ? routed : base;
    }),
  };
});
