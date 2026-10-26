import {
  isDevinAcpRegistryInstance,
  ProviderInstanceId,
  type ServerSettings,
} from "@goat/contracts";
import { AcpRegistrySettings } from "@goat/provider-acp-registry/settings";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const decodeSiblingSettings = Schema.decodeUnknownEffect(AcpRegistrySettings);
const decodeInstanceId = Schema.decodeUnknownOption(ProviderInstanceId);
// The native-ref contract trims fingerprints; JSON preserves empty profile slots across persistence.
const encodeBinding = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const STAGE_MESSAGES = {
  sibling: "Devin Cloud could not find your Devin CLI. Install it, then refresh providers.",
  resolve: "Devin Cloud could not start your Devin CLI.",
  probe: "Devin Cloud could not run your Devin CLI.",
  version: "Update the Devin CLI to 3000.11.1 or newer.",
  auth: "Sign in to Devin to use Devin Cloud.",
  relay: "This Devin CLI does not support cloud sessions. Update it.",
} as const;

export function selectSiblingInstanceId(
  settings: Pick<ServerSettings, "providerInstances">,
  configuredId: string,
): { readonly id: ProviderInstanceId | undefined; readonly ambiguous: boolean } {
  if (configuredId) {
    const decoded = decodeInstanceId(configuredId);
    return { id: Option.isSome(decoded) ? decoded.value : undefined, ambiguous: false };
  }
  const candidates = Object.entries(settings.providerInstances ?? {}).filter(([, instance]) =>
    isDevinAcpRegistryInstance(instance),
  );
  return {
    id: candidates.length === 1 ? ProviderInstanceId.make(candidates[0]![0]) : undefined,
    ambiguous: candidates.length > 1,
  };
}

export class DevinCloudCliError extends Schema.TaggedError<DevinCloudCliError>()(
  "DevinCloudCliError",
  {
    stage: Schema.Literals(["sibling", "resolve", "probe", "version", "auth", "relay"]),
    /**
     * The finer cause for `sibling` and `resolve`, for provider diagnosis. A `resolve`
     * reason is the ACP Registry inspection status, such as `unprepared` or `missing_runner`.
     */
    reason: Schema.optional(
      Schema.Literals([
        "missing",
        "ambiguous",
        "not_acp_registry",
        "disabled",
        "not_devin",
        "unconfigured",
        "not_found",
        "unsupported",
        "unprepared",
        "missing_runner",
        "package_runner",
      ]),
    ),
    cause: Schema.optional(Schema.Defect()),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message() {
    if (this.detail) return this.detail;
    if (this.stage === "sibling" && this.reason === "disabled")
      return "The Devin provider that Devin Cloud uses is off. Turn it on in Settings.";
    if (this.stage === "sibling" && this.reason !== undefined && this.reason !== "missing")
      return "The provider Devin Cloud uses does not run the Devin CLI. Choose another under Advanced.";
    return STAGE_MESSAGES[this.stage];
  }
}

function cloudVersion(text: string): string | undefined {
  const match = /^\s*(?:devin\s+)?(\d+)\.(\d+)\.(\d+)(?:\s|$)/iu.exec(text);
  if (!match) return undefined;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

export function cloudVersionSupported(text: string): boolean {
  const version = cloudVersion(text);
  if (!version) return false;
  const current = version.split(".").map(Number);
  const minimum = [3000, 11, 1];
  for (let i = 0; i < minimum.length; i++) {
    if (current[i]! > minimum[i]!) return true;
    if (current[i]! < minimum[i]!) return false;
  }
  return true;
}

export type DevinCloudLaunch = {
  readonly sourceInstanceId: ProviderInstanceId;
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly binding: string;
};
export type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
export type DevinCliReadiness = {
  readonly version: string;
  /** The signed-in account, shown to the person; never logged. */
  readonly email: string | undefined;
};

/** Read-only readiness; never starts ACP or a cloud session. */
export const probeCli = Effect.fn("DevinCloud.probeCli")(function* (
  run: (args: ReadonlyArray<string>) => Effect.Effect<CliResult, DevinCloudCliError>,
) {
  const version = yield* run(["--version"]);
  if (version.exitCode !== 0 || !cloudVersionSupported(version.stdout)) {
    return yield* new DevinCloudCliError({ stage: "version" });
  }
  const help = yield* run(["acp", "--help"]);
  if (help.exitCode !== 0 || !/--cloud\b/u.test(help.stdout)) {
    return yield* new DevinCloudCliError({ stage: "relay" });
  }
  const auth = yield* run(["auth", "status"]);
  // Versioned capture: no account email, org, endpoint or raw output is persisted.
  if (auth.exitCode !== 0 || !/^Logged in \(via Devin\)\./mu.test(auth.stdout)) {
    return yield* new DevinCloudCliError({ stage: "auth" });
  }
  const email = /^\s*Email:\s*(\S+@\S+)\s*$/mu.exec(auth.stdout)?.[1];
  return { version: cloudVersion(version.stdout)!, email } satisfies DevinCliReadiness;
});

export class DevinCloudCli extends Context.Service<
  DevinCloudCli,
  {
    readonly resolve: (
      siblingId: string,
      cwd: string,
    ) => Effect.Effect<DevinCloudLaunch, DevinCloudCliError>;
    readonly probe: (
      launch: DevinCloudLaunch,
    ) => Effect.Effect<DevinCliReadiness, DevinCloudCliError>;
  }
>()("@goat/provider-devin-cloud/server/cli/DevinCloudCli") {}

const make = Effect.gen(function* () {
  const host = yield* ProviderHost.ProviderHost;
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolve = Effect.fn("DevinCloudCli.resolve")(function* (siblingId: string, cwd: string) {
    const all = yield* host.settings.get.pipe(
      Effect.mapError((cause) => new DevinCloudCliError({ stage: "sibling", cause })),
    );
    const selected = selectSiblingInstanceId(all, siblingId);
    if (selected.ambiguous)
      return yield* new DevinCloudCliError({
        stage: "sibling",
        reason: "ambiguous",
        detail:
          "More than one enabled Devin ACP instance is available. Choose a Devin ACP instance in Devin Cloud settings.",
      });
    const selectedId = selected.id;
    const sibling = selectedId ? all.providerInstances?.[selectedId] : undefined;
    if (!sibling || !selectedId) {
      return yield* new DevinCloudCliError({ stage: "sibling", reason: "missing" });
    }
    if (sibling.driver !== "acpRegistry") {
      return yield* new DevinCloudCliError({ stage: "sibling", reason: "not_acp_registry" });
    }
    const settings = yield* decodeSiblingSettings(sibling.config ?? {}).pipe(
      Effect.mapError((cause) => new DevinCloudCliError({ stage: "sibling", cause })),
    );
    // Local commands must be a direct Devin executable, not a generic shell wrapper.
    const localName = settings.commandPath.split(/[\\/]/u).pop() ?? "";
    if (sibling.enabled === false || !settings.enabled) {
      return yield* new DevinCloudCliError({ stage: "sibling", reason: "disabled" });
    }
    if (
      (settings.source === "registry" && settings.agentId !== "devin") ||
      (settings.source === "local" && !/^devin(?:\.exe)?$/iu.test(localName))
    ) {
      return yield* new DevinCloudCliError({ stage: "sibling", reason: "not_devin" });
    }
    const env = yield* mergeProviderInstanceEnvironment(sibling.environment).pipe(
      Effect.mapError((cause) => new DevinCloudCliError({ stage: "resolve", cause })),
    );
    const inspection = yield* catalog
      .inspect(settings, env)
      .pipe(Effect.mapError((cause) => new DevinCloudCliError({ stage: "resolve", cause })));
    // Package runners can inspect as ready before resolve installs their agent.
    // Cloud readiness needs an already selected executable, never an installer.
    if (inspection.status !== "ready") {
      return yield* new DevinCloudCliError({ stage: "resolve", reason: inspection.status });
    }
    if (
      (inspection.distribution === "npx" || inspection.distribution === "uvx") &&
      !settings.commandPath
    ) {
      return yield* new DevinCloudCliError({ stage: "resolve", reason: "package_runner" });
    }
    const resolved = yield* catalog
      .resolve(settings, cwd, env)
      .pipe(Effect.mapError((cause) => new DevinCloudCliError({ stage: "resolve", cause })));
    // Only executable and final credential/profile env are inherited. Never local ACP argv.
    const spawnEnv = resolved.spawn.env ?? env;
    const binding = yield* encodeBinding([
      selectedId,
      resolved.spawn.command,
      spawnEnv.HOME ?? "",
      spawnEnv.XDG_CONFIG_HOME ?? "",
      spawnEnv.XDG_DATA_HOME ?? "",
      spawnEnv.USERPROFILE ?? "",
      spawnEnv.APPDATA ?? "",
      spawnEnv.LOCALAPPDATA ?? "",
    ]).pipe(Effect.mapError((cause) => new DevinCloudCliError({ stage: "resolve", cause })));
    return {
      sourceInstanceId: selectedId,
      command: resolved.spawn.command,
      env: spawnEnv,
      cwd,
      binding,
    };
  });
  const probe = Effect.fn("DevinCloudCli.probe")(function* (launch: DevinCloudLaunch) {
    return yield* probeCli((args) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(launch.command, args, {
              cwd: launch.cwd,
              env: launch.env,
              shell: false,
              stdin: "ignore",
            }),
          );
          const [stdout, , exitCode] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.runDrain(handle.stderr),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { stdout, stderr: "", exitCode: Number(exitCode) };
        }),
      ).pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError((cause) => new DevinCloudCliError({ stage: "probe", cause })),
      ),
    );
  });
  return DevinCloudCli.of({ resolve, probe });
});
export const layer = Layer.effect(DevinCloudCli, make);
