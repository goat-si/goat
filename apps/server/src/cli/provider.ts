import * as HomeRoute from "../provider/OpenCodexRoute.ts";
/**
 * `goat provider diagnose`: why provider instances cannot run, read-only.
 *
 * Runs the same checks as the goat_provider_diagnose MCP tool, in this
 * process: it reads settings.json and the saved provider status cache from the
 * GOAT home, and probes Claude Cloud and Devin Cloud live with this shell's
 * environment, which can differ from the app's. It never writes settings,
 * state, or credentials, so it works while the server is stopped.
 */
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderDiagnoseResult,
  ProviderInstanceId,
  ServerProvider,
  ServerSettings,
  TrimmedNonEmptyString,
  type ProviderDiagnoseInput,
} from "@goat/contracts";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { DevinCloudCli } from "@goat/provider-devin-cloud/server";
import { fromJsonStringPretty, fromLenientJson } from "@goat/shared/schemaJson";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { LIVE_DIAGNOSIS_DRIVERS, diagnoseProviders } from "../provider/ProviderDiagnosis.ts";
import { baseDirFlag } from "./config.ts";
import { generatedVerbsNote } from "./agentSurfaceCommand.ts";

const decodeSettingsFile = Schema.decodeUnknownEffect(fromLenientJson(ServerSettings));
const decodeSnapshotFile = Schema.decodeUnknownOption(Schema.fromJsonString(ServerProvider));
/** The `ok` result envelope from docs/internals/agent-surface.md; diagnosis has no error or needs_human outcome. */
const encodeEnvelope = Schema.encodeSync(
  fromJsonStringPretty(
    Schema.Struct({ status: Schema.Literal("ok"), value: ProviderDiagnoseResult }),
  ),
);

const readSettings = Effect.fn("cli.provider.readSettings")(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.option);
  if (Option.isNone(raw)) return DEFAULT_SERVER_SETTINGS;
  return yield* decodeSettingsFile(raw.value).pipe(
    Effect.mapError(
      () =>
        new CliError.UserError({
          cause: `Could not read ${settingsPath}. Open GOAT once to repair it, then try again.`,
        }),
    ),
  );
});

/** Saved snapshots for configured instances and built-in default instances. */
const readSavedSnapshots = Effect.fn("cli.provider.readSavedSnapshots")(function* (
  cacheDir: string,
  settings: ServerSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(cacheDir).pipe(Effect.orElseSucceed(() => []));
  const snapshots = yield* Effect.forEach(
    names.filter((name) => name.endsWith(".json")),
    (name) =>
      fs.readFileString(path.join(cacheDir, name)).pipe(
        Effect.map(decodeSnapshotFile),
        Effect.orElseSucceed(() => Option.none<ServerProvider>()),
      ),
    { concurrency: 8 },
  );
  return snapshots.flatMap((snapshot) =>
    Option.isSome(snapshot) &&
    (settings.providerInstances[snapshot.value.instanceId] !== undefined ||
      (String(snapshot.value.instanceId) === String(snapshot.value.driver) &&
        !LIVE_DIAGNOSIS_DRIVERS.has(snapshot.value.driver)))
      ? [snapshot.value]
      : [],
  );
});

/** A ProviderHost over a settings snapshot read from disk. It has no credentials and does no background work. */
export const readOnlyHost = (
  paths: ServerConfig.ServerDerivedPaths,
  baseDir: string,
  cwd: string,
  settings: ServerSettings,
) =>
  ProviderHost.ProviderHost.of({
    paths: {
      cwd,
      baseDir,
      stateDir: paths.stateDir,
      providerStatusCacheDir: paths.providerStatusCacheDir,
      attachmentsDir: paths.attachmentsDir,
    },
    settings: {
      get: Effect.succeed(settings),
      withSnapshot: (use) => use(settings),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    shouldRunBackgroundWork: () => Effect.succeed(false),
    resolveAttachmentPath: () => null,
    credentials: () => Effect.die("Provider diagnosis never reads stored credentials."),
  });

const MARK = {
  pass: "ok  ",
  fail: "FAIL",
  warn: "warn",
  unknown: " ?  ",
  skipped: "skip",
} as const;

export const formatDiagnosis = (result: ProviderDiagnoseResult): string => {
  if (result.diagnoses.length === 0) return "No provider instances matched.";
  const blocks = result.diagnoses.map((diagnosis) => {
    const title = `${diagnosis.displayName ?? diagnosis.instanceId} (${diagnosis.driver})`;
    const state = diagnosis.ready ? "ready" : "not ready";
    const lines = [`${title}: ${state}${diagnosis.configured ? "" : ", not configured"}`];
    for (const item of diagnosis.checks) {
      lines.push(`  ${MARK[item.status]} ${item.id}: ${item.summary}`);
      if (item.fix) {
        const via = [item.fix.path, item.fix.handoff].filter(Boolean).join(", ");
        lines.push(
          `       next (${item.fix.actor}): ${item.fix.instruction}${via ? ` [${via}]` : ""}`,
        );
      }
    }
    return lines.join("\n");
  });
  return [
    ...blocks,
    "Checked by this CLI with this shell's environment; the app may see a different one.",
  ].join("\n\n");
};

const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);

const providerDiagnoseCommand = Command.make("diagnose", {
  baseDir: baseDirFlag,
  instance: optionalString("instance", "Diagnose one provider instance id."),
  driver: optionalString(
    "driver",
    "Diagnose every instance of one driver, such as claudeCloud or devinCloud.",
  ),
  cwd: optionalString("cwd", "Project folder whose repository remote cloud providers need."),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the result envelope as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Explain why provider instances cannot run, and who takes the next step.",
  ),
  Command.withHandler(
    Effect.fn("cli.provider.diagnose")(function* (flags) {
      const path = yield* Path.Path;
      const envHome = yield* Config.String("GOAT_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(flags.baseDir, () => envHome)),
      );
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      const settings = yield* readSettings(paths.settingsPath);
      const snapshots = yield* readSavedSnapshots(paths.providerStatusCacheDir, settings);
      const decodeName = Schema.decodeUnknownOption(TrimmedNonEmptyString);
      const input: ProviderDiagnoseInput = {
        ...Option.match(Option.flatMap(flags.instance, decodeName), {
          onNone: () => ({}),
          onSome: (id) => ({ instanceId: ProviderInstanceId.make(id) }),
        }),
        ...Option.match(Option.flatMap(flags.driver, decodeName), {
          onNone: () => ({}),
          onSome: (driver) => ({ driver: ProviderDriverKind.make(driver) }),
        }),
        ...Option.match(flags.cwd, {
          onNone: () => ({}),
          onSome: (cwd) => ({ cwd: path.resolve(cwd) }),
        }),
      };
      const host = readOnlyHost(paths, baseDir, process.cwd(), settings);
      const result = yield* diagnoseProviders({ input, snapshots, checkedBy: "cli" }).pipe(
        Effect.provide(
          Layer.mergeAll(DevinCloudCli.layer, HomeRoute.layer).pipe(
            Layer.provide(AcpRegistrySupport.layerFromHost),
            Layer.provide(FetchHttpClient.layer),
            Layer.provideMerge(Layer.succeed(ProviderHost.ProviderHost, host)),
          ),
        ),
      );
      yield* Console.log(
        flags.json ? encodeEnvelope({ status: "ok", value: result }) : formatDiagnosis(result),
      );
    }),
  ),
);

export const providerCommand = Command.make("provider").pipe(
  Command.withDescription(
    `Inspect this environment's provider instances. ${generatedVerbsNote("provider")}`,
  ),
  Command.withSubcommands([providerDiagnoseCommand]),
);
