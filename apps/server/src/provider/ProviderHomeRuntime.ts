import {
  ProviderHomeRouteConfig,
  ProviderInstanceEnvironment,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@goat/contracts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@goat/provider-core/server/pathExpansion";
import { tokenizeCliArgs } from "@goat/shared/cliArgs";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- names a published Pi directory by its content digest.
import * as NodeCrypto from "node:crypto";
import * as Config from "../config.ts";
import * as Installation from "../opencodex/OpenCodexInstallation.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as Runner from "../processRunner.ts";
import { assertClaudeHomeEnforceable, CLAUDE_HOME_ROUTE_MARKER } from "./ClaudeHomeSettings.ts";
import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { normalizeOpenCodexBaseUrl } from "./OpenCodexRoute.ts";
import type { ProviderHomeOverlayDriver } from "./ProviderHomeAdapters.ts";

class ProviderHomeRuntimeError extends Schema.TaggedError<ProviderHomeRuntimeError>()(
  "ProviderHomeRuntimeError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}
const fail = (detail: string) => new ProviderHomeRuntimeError({ detail });
const isRuntimeError = Schema.is(ProviderHomeRuntimeError);
type JsonRecord = Record<string, unknown>;
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeRoute = Schema.decodeUnknownEffect(ProviderHomeRouteConfig);
const decodeEnvironment = Schema.decodeEffect(ProviderInstanceEnvironment);
/** A malformed document is an error, never an empty object; absent maps are empty. */
const recordOf = (value: unknown): JsonRecord => {
  const decoded = decodeRecord(value);
  if (Option.isNone(decoded)) throw fail("Invalid OpenCodex client document.");
  return decoded.value;
};
const decodePiRows = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) })),
);
const LOOPBACK_KEY = "opencodex-loopback";
const PI_API = "openai-completions";
const NO_MODELS =
  "Home exported no usable models. Configure models on Home and reconnect this instance.";
const CONTROLLED_ARGS: Record<"claudeAgent" | "pi", ReadonlyArray<string>> = {
  claudeAgent: ["--settings", "--model", "--fallback-model"],
  pi: ["--provider", "--model", "--models", "--api-key", "--extension", "-e"],
};

export type ProviderHomeRuntimeEnv =
  | Config.ServerConfig
  | Inventory.OpenCodexInventory
  | Runner.ProcessRunner
  | FileSystem.FileSystem
  | Path.Path;
/** Routed drivers and their approvals read this machine's selected OpenCodex executable. */
export const layerProviderHomeInventory = Inventory.layer.pipe(Layer.provide(Installation.layer));
export type ProviderHomeRuntime = {
  readonly baseUrl: string;
  readonly environment: ProviderInstanceEnvironment;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly allowedModels: ReadonlySet<string>;
};
/** A validated route that has not changed anything on disk yet. */
export type ProviderHomeCandidate = Omit<ProviderHomeRuntime, "environment"> & {
  readonly environment: ProviderInstanceEnvironment | undefined;
  readonly overlay: Readonly<Record<string, string>>;
  readonly pi?: {
    readonly instanceId: ProviderInstanceId;
    readonly block: JsonRecord;
    readonly defaultModel: string;
  };
};
type ExportedModels = { readonly ids: ReadonlyArray<string>; readonly names: Map<string, string> };

const readPiExport = (document: JsonRecord, baseUrl: string) => {
  const block = recordOf(recordOf(document.providers ?? {}).opencodex);
  if (block.baseUrl !== baseUrl || block.api !== PI_API) throw fail("Pi export endpoint mismatch.");
  const rows = Option.getOrUndefined(decodePiRows(block.models));
  if (rows === undefined) throw fail("Pi export models are invalid.");
  return {
    block,
    ids: rows.map((row) => row.id),
    names: new Map(rows.map((row) => [row.id, row.name ?? row.id])),
  };
};

/** Both OpenCode generations must point at the selected loopback endpoint with one model set. */
const readOpenCodeExport = (document: JsonRecord, baseUrl: string) => {
  const v1 = recordOf(recordOf(document.provider ?? {}).opencodex);
  const v2 = recordOf(recordOf(document.providers ?? {}).opencodex);
  const options = recordOf(v1.options ?? {});
  const settings = recordOf(v2.settings ?? {});
  if (
    options.baseURL !== baseUrl ||
    settings.baseURL !== baseUrl ||
    options.headers !== undefined ||
    settings.headers !== undefined
  )
    throw fail("OpenCode export endpoint mismatch.");
  const ids = Object.keys(recordOf(v1.models ?? {}));
  const second = recordOf(v2.models ?? {});
  if (ids.length !== Object.keys(second).length || ids.some((id) => !(id in second)))
    throw fail("OpenCode export generations disagree.");
  // Only the loopback placeholder enters the provider process; export env references are not credentials.
  return {
    v1: { ...v1, options: { ...options, apiKey: LOOPBACK_KEY } },
    v2: { ...v2, settings: { ...settings, apiKey: LOOPBACK_KEY } },
    ids,
    names: new Map(ids.map((id) => [id, id])),
  };
};

const mergeOpenCodeInline = (
  inherited: string | undefined,
  exported: ReturnType<typeof readOpenCodeExport>,
) => {
  const existing = inherited?.trim() ? recordOf(JSON.parse(inherited)) : {};
  const provider = recordOf(existing.provider ?? {});
  const providers = recordOf(existing.providers ?? {});
  return JSON.stringify({
    ...existing,
    provider: { ...provider, opencodex: exported.v1 },
    providers: { ...providers, opencodex: exported.v2 },
  });
};

const piAgentFiles = (block: JsonRecord, defaultModel: string) => {
  const files: ReadonlyArray<readonly [string, string]> = [
    [
      "models.json",
      JSON.stringify({ providers: { opencodex: { ...block, apiKey: LOOPBACK_KEY } } }, null, 2),
    ],
    ["settings.json", JSON.stringify({ defaultProvider: "opencodex", defaultModel }, null, 2)],
  ];
  const digest = NodeCrypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { files, name: digest.slice(0, 16) };
};

/**
 * Publishes routed Pi configuration under a name derived from its content: it is staged in a
 * candidate directory and renamed into place, so a running Pi never reads a partial or replaced
 * file. Native sessions stay in the user's session directory, so recreation does not move them.
 */
const publishPiAgentDirectory = Effect.fn("ProviderHomeRuntime.publishPiAgentDirectory")(function* (
  instanceId: ProviderInstanceId,
  block: JsonRecord,
  defaultModel: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* Config.ServerConfig;
  const { files, name } = piAgentFiles(block, defaultModel);
  const root = path.join(server.stateDir, "providers", "pi", instanceId, "home-agent");
  const target = path.join(root, name);
  if (yield* fs.exists(target)) return target;
  yield* fs.makeDirectory(root, { recursive: true });
  const candidate = yield* fs.makeTempDirectory({ directory: root, prefix: ".candidate-" });
  yield* Effect.forEach(
    files,
    ([name, text]) => fs.writeFileString(path.join(candidate, name), text),
    { discard: true },
  ).pipe(
    Effect.andThen(fs.rename(candidate, target)),
    // Another publication of the same content may have won the rename.
    Effect.catch((error) =>
      fs
        .exists(target)
        .pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(error)))),
    ),
    Effect.ensuring(fs.remove(candidate, { recursive: true }).pipe(Effect.ignore)),
  );
  return target;
});

const piSessionDirectory = Effect.fn("ProviderHomeRuntime.piSessionDirectory")(function* (
  merged: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const sessions = merged.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (sessions) return path.resolve(expandHomePath(sessions, home));
  const agent = merged.PI_CODING_AGENT_DIR?.trim();
  return path.resolve(
    agent ? expandHomePath(agent, home) : path.join(home, ".pi", "agent"),
    "sessions",
  );
});

const exportDocument = Effect.fn("ProviderHomeRuntime.export")(function* (
  driver: ProviderHomeOverlayDriver,
  baseUrl: string,
  environment: NodeJS.ProcessEnv,
) {
  // A fresh read: the 30 second cache can name a binary or port that changed since.
  const observed = yield* (yield* Inventory.OpenCodexInventory).readParity;
  const binary = observed.binaries[0]?.path;
  if (
    !binary ||
    !observed.runtime.healthy ||
    !observed.runtime.ready ||
    observed.link.role === "none"
  )
    return yield* fail(
      "Start local OpenCodex and link it to Home before connecting this instance.",
    );
  if (Number(new URL(baseUrl).port || 80) !== observed.runtime.port)
    return yield* fail("The configured address differs from this machine's running OpenCodex.");
  const exported = yield* (yield* Runner.ProcessRunner)
    .run({
      command: binary,
      args: ["export", "--client", driver === "pi" ? "pi" : "opencode", "--json"],
      env: environment,
      timeout: "10 seconds",
      maxOutputBytes: 8 * 1024 * 1024,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(() =>
        fail("OpenCodex client export failed. Check its export support or update OpenCodex."),
      ),
    );
  if (
    exported.code !== 0 ||
    exported.timedOut ||
    exported.stdoutTruncated ||
    exported.stdoutInvalidUtf8
  )
    return yield* fail(
      "OpenCodex could not export this client's configuration. Check its export support or update OpenCodex.",
    );
  return yield* decodeJsonRecord(exported.stdout).pipe(
    Effect.mapError(() => fail("OpenCodex returned an invalid client export.")),
  );
});

/**
 * Validates a routed Claude Code, OpenCode or Pi instance against this machine's OpenCodex and
 * returns its process-only overlay without writing anything, so approvals can check it first.
 */
export const inspectProviderHomeRuntime = Effect.fn("ProviderHomeRuntime.inspect")(
  function* (
    driver: ProviderHomeOverlayDriver,
    instanceId: ProviderInstanceId,
    config: unknown,
    environment: ProviderInstanceEnvironment | undefined,
  ) {
    const route = yield* decodeRoute(config).pipe(
      Effect.mapError(() => fail("Invalid Home route settings.")),
    );
    const baseUrl = yield* Effect.try({
      try: () => normalizeOpenCodexBaseUrl(route.opencodexBaseUrl),
      catch: () => fail("Enter a local OpenCodex /v1 address on this instance's machine."),
    });
    const raw = yield* Effect.try({
      try: () => recordOf(config),
      catch: () => fail("Invalid provider settings."),
    });
    if (driver === "opencode" && typeof raw.serverUrl === "string" && raw.serverUrl.trim())
      return yield* fail(
        "Clear the external OpenCode server URL before routing this instance through Home.",
      );
    if (driver === "pi" || driver === "claudeAgent") {
      const args = tokenizeCliArgs(typeof raw.launchArgs === "string" ? raw.launchArgs : "");
      const controlled = CONTROLLED_ARGS[driver];
      if (args.some((arg) => controlled.some((flag) => arg === flag || arg.startsWith(`${flag}=`))))
        return yield* fail(
          "Remove launch arguments that override the approved Home model, credentials, or configuration.",
        );
    }
    const merged = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    if (driver === "claudeAgent") {
      const home = yield* resolveClaudeHomePath(
        { homePath: typeof raw.homePath === "string" ? raw.homePath : "" },
        merged,
      );
      yield* assertClaudeHomeEnforceable(home).pipe(Effect.mapError(({ detail }) => fail(detail)));
    }
    const document = yield* exportDocument(driver, baseUrl, merged);
    let exported: ExportedModels;
    let overlay: Record<string, string>;
    let pi: ProviderHomeCandidate["pi"];
    if (driver === "pi") {
      const piExport = yield* Effect.try({
        try: () => readPiExport(document, baseUrl),
        catch: () => fail("OpenCodex's Pi export must describe the selected loopback endpoint."),
      });
      exported = piExport;
      const [first] = piExport.ids;
      if (first === undefined || piExport.ids.some((id) => !id.trim()))
        return yield* fail(NO_MODELS);
      pi = { instanceId, block: piExport.block, defaultModel: first };
      overlay = { PI_CODING_AGENT_SESSION_DIR: yield* piSessionDirectory(merged) };
    } else {
      const openCode = yield* Effect.try({
        try: () => readOpenCodeExport(document, baseUrl),
        catch: () =>
          fail(
            "OpenCodex export must describe the selected loopback endpoint, both supported OpenCode generations, and credential-free admission.",
          ),
      });
      exported = openCode;
      overlay =
        driver === "claudeAgent"
          ? {
              ANTHROPIC_BASE_URL: baseUrl.slice(0, -"/v1".length),
              ANTHROPIC_AUTH_TOKEN: LOOPBACK_KEY,
              ANTHROPIC_API_KEY: "",
              CLAUDE_CODE_OAUTH_TOKEN: "",
              CLAUDE_CODE_USE_BEDROCK: "",
              CLAUDE_CODE_USE_VERTEX: "",
              CLAUDE_CODE_USE_FOUNDRY: "",
              [CLAUDE_HOME_ROUTE_MARKER]: "1",
            }
          : {
              OPENCODE_CONFIG_CONTENT: yield* Effect.try({
                try: () => mergeOpenCodeInline(merged.OPENCODE_CONFIG_CONTENT, openCode),
                catch: () =>
                  fail("OPENCODE_CONFIG_CONTENT must be a valid object with object provider maps."),
              }),
              OPENCODEX_API_KEY: LOOPBACK_KEY,
            };
    }
    if (exported.ids.length === 0 || exported.ids.some((id) => !id.trim()))
      return yield* fail(NO_MODELS);
    const models = exported.ids.map((id) => ({
      slug: driver === "claudeAgent" ? id : `opencodex/${id}`,
      name: exported.names.get(id) ?? id,
      isCustom: true,
      capabilities: null,
    }));
    return {
      baseUrl,
      environment,
      overlay,
      ...(pi === undefined ? {} : { pi }),
      models,
      allowedModels: new Set(models.map((model) => model.slug)),
    } satisfies ProviderHomeCandidate;
  },
  Effect.mapError((error) =>
    isRuntimeError(error)
      ? error
      : fail("Could not prepare this instance's Home runtime. Refresh and retry."),
  ),
);

/** Applies an inspected route: publishes Pi's files and returns the launch environment. */
const publishProviderHomeRuntime = Effect.fn("ProviderHomeRuntime.publish")(function* (
  candidate: ProviderHomeCandidate,
) {
  const { pi } = candidate;
  const overlay =
    pi === undefined
      ? candidate.overlay
      : {
          ...candidate.overlay,
          PI_CODING_AGENT_DIR: yield* publishPiAgentDirectory(
            pi.instanceId,
            pi.block,
            pi.defaultModel,
          ).pipe(
            Effect.mapError(() => fail("Could not write this instance's Pi Home configuration.")),
          ),
        };
  const overridden = new Set(Object.keys(overlay));
  const environment = yield* decodeEnvironment([
    ...(candidate.environment ?? []).filter(({ name }) => !overridden.has(name)),
    ...Object.entries(overlay).map(([name, value]) => ({ name, value, sensitive: false })),
  ]).pipe(Effect.mapError(() => fail("Could not build this instance's Home environment.")));
  return {
    baseUrl: candidate.baseUrl,
    environment,
    models: candidate.models,
    allowedModels: candidate.allowedModels,
  } satisfies ProviderHomeRuntime;
});

/** Inspects and then publishes a route; only runtime construction after admission calls this. */
export const prepareProviderHomeRuntime = Effect.fn("ProviderHomeRuntime.prepare")(function* (
  ...input: Parameters<typeof inspectProviderHomeRuntime>
) {
  return yield* publishProviderHomeRuntime(yield* inspectProviderHomeRuntime(...input));
});
