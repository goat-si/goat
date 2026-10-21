import { CodexSettings, DEFAULT_OPENCODEX_BASE_URL, type CodexRouteStatus } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { expandHomePath } from "@goat/provider-core/server/pathExpansion";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { parse } from "smol-toml";
import { createTranscriptJsonReader } from "../project/AgentSessionJson.ts";

export class OpenCodexRouteUnavailable extends Schema.TaggedError<OpenCodexRouteUnavailable>()(
  "OpenCodexRouteUnavailable",
  { detail: Schema.String, code: Schema.optionalKey(Schema.Literal("connection_refused")) },
) {
  override get message() {
    return `Codex via OpenCodex Home is unavailable: ${this.detail}. GOAT didn't switch to another account.`;
  }
}
export type RouteInput = {
  readonly settings: CodexSettings;
  readonly execution: {
    readonly binaryPath: string;
    readonly home: string;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly configArgv: ReadonlyArray<string>;
  };
};
const isUnavailable = Schema.is(OpenCodexRouteUnavailable);
const unavailable = (detail: string) => new OpenCodexRouteUnavailable({ detail });
const connectionRefused = (error: unknown, depth = 0): boolean => {
  const value = record(error);
  return (
    depth < 8 &&
    value !== undefined &&
    (value.code === "ECONNREFUSED" ||
      [value.cause, value.reason, value.error].some((nested) =>
        connectionRefused(nested, depth + 1),
      ))
  );
};
const STATUS_UNAVAILABLE =
  "Couldn't read OpenCodex status. Check that OpenCodex is running, then check status.";
const MISMATCH =
  "OpenCodex on this machine uses a different address. Update the URL, then check status.";
const TEMPORARY = "Reconnecting to Home…";
const INVALID_ADDRESS = "Enter a local OpenCodex address such as http://127.0.0.1:10100/v1.";
const endpointFailureReason = (baseUrl: string) =>
  `OpenCodex didn't answer correctly at ${baseUrl}. Check that OpenCodex is running, then check status.`;
const CATALOG_MISSING = "Could not find OpenCodex's model catalog";
const CONFIG_UNVERIFIED = "Could not verify the effective Codex endpoint.";

/** Only a host-local, credential-free API can be used as a Home route. */
export function normalizeOpenCodexBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim() || DEFAULT_OPENCODEX_BASE_URL);
  } catch {
    throw unavailable(INVALID_ADDRESS);
  }
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/v1", "/v1/"].includes(url.pathname) ||
    Number(url.port || 80) === 0
  )
    throw unavailable(INVALID_ADDRESS);
  return url.toString().replace(/\/+$/, "");
}
const codexRouteEnvironment = (
  settings: Pick<CodexSettings, "setupMode" | "modelRoute" | "opencodexBaseUrl">,
  environment: NodeJS.ProcessEnv,
) => {
  if (settings.modelRoute !== "opencodex") return environment;
  if (settings.setupMode === "managed")
    throw unavailable("OpenCodex routing needs a Codex instance that uses your Codex CLI.");
  return { ...environment, OPENAI_BASE_URL: normalizeOpenCodexBaseUrl(settings.opencodexBaseUrl) };
};

/** Call after shadow/reception home preparation, using the actual spawn cwd and environment. */
export const resolveCodexRouteContext = (input: {
  readonly settings: CodexSettings;
  readonly binaryPath: string;
  readonly home?: string | undefined;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly configArgv: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const userHome = yield* HostProcess.HomeDirectory;
    const home = path.resolve(
      input.cwd,
      expandHomePath(
        input.home || input.environment.CODEX_HOME || path.join(userHome, ".codex"),
        userHome,
      ),
    );
    const environment = yield* Effect.try({
      try: () => codexRouteEnvironment(input.settings, { ...input.environment, CODEX_HOME: home }),
      catch: (error) => (isUnavailable(error) ? error : unavailable(INVALID_ADDRESS)),
    });
    return {
      settings: input.settings,
      execution: {
        binaryPath: input.binaryPath,
        home,
        cwd: path.resolve(input.cwd),
        environment,
        configArgv: input.configArgv,
      },
    } satisfies RouteInput;
  });
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
/** Configuration wins only where the selected provider's endpoint is actually observable. */
export function readEffectiveBaseUrl(
  config: unknown,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const root = record(config);
  if (!root) return undefined;
  const provider = root.model_provider ?? "openai";
  const selected =
    typeof provider === "string" ? record(record(root.model_providers)?.[provider]) : undefined;
  const configured = root.openai_base_url ?? selected?.base_url;
  if (
    provider === "openai" &&
    environment.OPENAI_BASE_URL !== undefined &&
    configured !== environment.OPENAI_BASE_URL
  )
    return undefined;
  const base =
    provider === "openai" ? (configured ?? "https://api.openai.com/v1") : selected?.base_url;
  if (typeof base !== "string") return undefined;
  try {
    const url = new URL(base);
    return url.username || url.password || url.search || url.hash
      ? undefined
      : url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}
export const verifyEffectiveCodexRoute = (
  input: RouteInput,
  config: unknown,
  expectedCatalogPath: string,
) =>
  Effect.gen(function* () {
    if (input.settings.modelRoute !== "opencodex") return;
    const path = yield* Path.Path;
    const userHome = yield* HostProcess.HomeDirectory;
    const root = record(config);
    const pointer = root?.model_catalog_json;
    if (
      root?.model_provider !== "openai" ||
      root.openai_base_url !== normalizeOpenCodexBaseUrl(input.settings.opencodexBaseUrl) ||
      readEffectiveBaseUrl(root, input.execution.environment) !==
        normalizeOpenCodexBaseUrl(input.settings.opencodexBaseUrl) ||
      typeof pointer !== "string" ||
      path.resolve(input.execution.cwd, expandHomePath(pointer, userHome)) !== expectedCatalogPath
    )
      return yield* unavailable(CONFIG_UNVERIFIED);
  });
const Status = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  proxy: Schema.Struct({
    running: Schema.Boolean,
    pid: Schema.NullOr(Schema.Int),
    health: Schema.Struct({ ok: Schema.Boolean, url: Schema.String }),
  }),
  listen: Schema.Struct({ hostname: Schema.NullOr(Schema.String), port: Schema.Int }),
  connection: Schema.Struct({
    state: Schema.String,
    credentialFile: Schema.String,
    readiness: Schema.optional(Schema.String),
  }),
});
const Health = Schema.Struct({
  service: Schema.Literal("opencodex"),
  version: Schema.String,
  pid: Schema.Int,
  port: Schema.Int,
  role: Schema.optional(Schema.Literal("client")),
  status: Schema.optional(Schema.String),
  protocolVersion: Schema.optional(Schema.Int),
});
const Models = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const Link = Schema.Struct({ role: Schema.String });
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const encodeCacheKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(Status));
const decodeHealth = Schema.decodeUnknownEffect(Health);
const decodeModels = Schema.decodeUnknownEffect(Models);
const decodeLink = Schema.decodeUnknownEffect(Schema.fromJsonString(Link));
export class OpenCodexRoute extends Context.Service<
  OpenCodexRoute,
  {
    readonly inspect: (input: RouteInput) => Effect.Effect<CodexRouteStatus>;
    readonly launchArgs: (
      input: RouteInput,
    ) => Effect.Effect<ReadonlyArray<string>, OpenCodexRouteUnavailable>;
    readonly requireAvailable: (
      input: RouteInput,
    ) => Effect.Effect<void, OpenCodexRouteUnavailable>;
  }
>()("goat/provider/OpenCodexRoute") {}
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userHome = yield* HostProcess.HomeDirectory;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const positives = new Map<string, number>();
  const catalog = (input: RouteInput) =>
    Effect.gen(function* () {
      if (input.settings.setupMode === "managed")
        return yield* unavailable(
          "OpenCodex routing needs a Codex instance that uses your Codex CLI.",
        );
      const configPath = path.join(input.execution.home, "config.toml");
      let pointer: unknown;
      if (yield* fs.exists(configPath)) {
        const stat = yield* fs.stat(configPath);
        if (Number(stat.size) > 1024 * 1024) return yield* unavailable(CATALOG_MISSING);
        let configBytes = 0;
        const text = yield* fs.stream(configPath).pipe(
          Stream.tap((chunk) =>
            Effect.gen(function* () {
              configBytes += chunk.byteLength;
              if (configBytes > 1024 * 1024) return yield* unavailable(CATALOG_MISSING);
            }),
          ),
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
          Effect.timeout("5 seconds"),
        );
        const config = yield* Effect.try(() => parse(text));
        pointer = config.model_catalog_json;
        if (pointer !== undefined && typeof pointer !== "string")
          return yield* unavailable(CATALOG_MISSING);
      }
      const filename =
        typeof pointer === "string"
          ? path.resolve(input.execution.cwd, expandHomePath(pointer, userHome))
          : path.join(input.execution.home, "opencodex-catalog.json");
      const stat = yield* fs.stat(filename);
      if (stat.type !== "File") return yield* unavailable(CATALOG_MISSING);
      yield* Effect.scoped(fs.open(filename, { flag: "r" }));
      return {
        filename,
        identity: `${filename}:${Option.getOrElse(stat.ino, () => 0)}:${Option.getOrElse(
          Option.map(stat.mtime, (date) => date.getTime()),
          () => 0,
        )}:${stat.size}`,
      };
    }).pipe(
      Effect.mapError((error) => (isUnavailable(error) ? error : unavailable(CATALOG_MISSING))),
    );
  const cli = (input: RouteInput, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("ocx", args, {
            cwd: input.execution.cwd,
            env: input.execution.environment,
            stdin: "ignore",
            forceKillAfter: "1 second",
          }),
        );
        let bytes = 0;
        const stdout = child.stdout.pipe(
          Stream.tap((chunk) =>
            Effect.gen(function* () {
              bytes += chunk.byteLength;
              if (bytes > 4 * 1024 * 1024) return yield* unavailable(STATUS_UNAVAILABLE);
            }),
          ),
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        );
        const [text, , code] = yield* Effect.all(
          [stdout, child.stderr.pipe(Stream.runDrain), child.exitCode],
          { concurrency: "unbounded" },
        );
        if (code !== 0) return yield* unavailable(STATUS_UNAVAILABLE);
        return text;
      }),
    ).pipe(
      Effect.timeout("5 seconds"),
      Effect.mapError(() => unavailable(STATUS_UNAVAILABLE)),
    );
  const json = (url: string, baseUrl: string, models = false) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* http.execute(HttpClientRequest.get(url)).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            credentials: "omit",
          }),
        );
        if (response.status >= 300 && response.status < 400)
          return yield* unavailable("OpenCodex endpoint redirected the request");
        const successful = response.status >= 200 && response.status < 300;
        const largeModels = models && successful;
        const limit = largeModels ? 128 * 1024 * 1024 : 64 * 1024;
        if (Number(response.headers["content-length"]) > limit)
          return yield* unavailable("OpenCodex response exceeded its size limit");
        let bytes = 0;
        let allocated = 0;
        const reader = createTranscriptJsonReader(
          (size) => {
            allocated += size;
            if (allocated > (largeModels ? 16 * 1024 * 1024 : limit * 4))
              throw unavailable("OpenCodex response exceeded its size limit");
          },
          (keys) =>
            !largeModels ||
            keys.length === 0 ||
            (keys[0] === "data" && (keys.length <= 2 || keys[2] === "id")),
        );
        yield* response.stream.pipe(
          Stream.tap((chunk) =>
            Effect.gen(function* () {
              bytes += chunk.byteLength;
              if (bytes > limit)
                return yield* unavailable("OpenCodex response exceeded its size limit");
            }),
          ),
          Stream.decodeText(),
          Stream.runForEach((chunk) => Effect.try(() => reader.write(chunk))),
        );
        const body = yield* Effect.try(() => reader.finish());
        if (!successful) {
          const error = record(body);
          if (
            response.status === 503 &&
            ((url.endsWith("/readyz") && error?.status === "pending") ||
              (models &&
                error?.error === "link tunnel unavailable" &&
                Number(response.headers["retry-after"]) > 0))
          )
            return yield* unavailable(TEMPORARY);
          return yield* unavailable(
            url.endsWith("/readyz") && error?.status === "failed"
              ? "OpenCodex readiness failed"
              : "OpenCodex endpoint rejected the request",
          );
        }
        if (models)
          yield* decodeModels(body).pipe(
            Effect.mapError(() => unavailable("OpenCodex response was invalid")),
          );
        else
          yield* decodeHealth(body).pipe(
            Effect.mapError(() => unavailable("OpenCodex response was invalid")),
          );
        return body;
      }),
    ).pipe(
      Effect.timeout(models ? "15 seconds" : "5 seconds"),
      Effect.catch((error) => {
        if (isUnavailable(error) && error.detail === TEMPORARY) return Effect.fail(error);
        const failure = new OpenCodexRouteUnavailable({
          detail: endpointFailureReason(baseUrl),
          ...(connectionRefused(error) ? { code: "connection_refused" as const } : {}),
        });
        return Effect.logDebug("OpenCodex endpoint probe failed", {
          detail: isUnavailable(error) ? error.detail : "Endpoint transport or response failed",
        }).pipe(Effect.andThen(Effect.fail(failure)));
      }),
    );
  const launchArgs = (input: RouteInput) =>
    Effect.gen(function* () {
      if (input.settings.modelRoute !== "opencodex") return [];
      const baseUrl = yield* Effect.try({
        try: () => normalizeOpenCodexBaseUrl(input.settings.opencodexBaseUrl),
        catch: () => unavailable(INVALID_ADDRESS),
      });
      const selected = yield* catalog(input);
      return [
        "-c",
        'model_provider="openai"',
        "-c",
        `openai_base_url=${encodeString(baseUrl)}`,
        "-c",
        `model_catalog_json=${encodeString(selected.filename)}`,
      ];
    });
  const inspect = (input: RouteInput, fresh = false) =>
    Effect.gen(function* () {
      if (input.settings.modelRoute !== "opencodex") return { modelRoute: "default" as const };
      const base = yield* Effect.try({
        try: () => normalizeOpenCodexBaseUrl(input.settings.opencodexBaseUrl),
        catch: () => unavailable(INVALID_ADDRESS),
      });
      const origin = new URL(base).origin;
      const selected = yield* catalog(input);
      const observed = yield* json(`${origin}/healthz`, base).pipe(
        Effect.flatMap(decodeHealth),
        Effect.result,
      );
      if (observed._tag === "Failure") {
        const error = observed.failure;
        if (isUnavailable(error) && error.code === "connection_refused") {
          const stopped = yield* cli(input, ["status", "--json"]).pipe(
            Effect.flatMap(decodeStatus),
          );
          const stoppedUrl = yield* Effect.try(() => new URL(stopped.proxy.health.url));
          if (
            stopped.listen.port !== Number(new URL(base).port || 80) ||
            stoppedUrl.port !== new URL(base).port ||
            stoppedUrl.protocol !== "http:" ||
            !["localhost", "127.0.0.1", "[::1]"].includes(stoppedUrl.hostname)
          )
            return yield* unavailable(MISMATCH);
          if (!stopped.proxy.running && !stopped.proxy.health.ok)
            return {
              modelRoute: "opencodex" as const,
              state: "not_running" as const,
              reason: "OpenCodex isn't running on this machine.",
            };
        }
        return yield* error;
      }
      const health = observed.success;
      const ready = yield* json(`${origin}/readyz`, base).pipe(Effect.flatMap(decodeHealth));
      if (
        health.pid !== ready.pid ||
        health.port !== ready.port ||
        health.version !== ready.version ||
        health.role !== ready.role ||
        (health.role === "client" && ready.protocolVersion !== 1) ||
        health.port !== Number(new URL(base).port || 80)
      )
        return yield* unavailable(MISMATCH);
      if (ready.status === "pending") return yield* unavailable(TEMPORARY);
      if (ready.status !== "ready")
        return yield* Effect.logDebug("OpenCodex endpoint probe failed", {
          detail: "OpenCodex readiness failed",
        }).pipe(Effect.andThen(Effect.fail(unavailable(endpointFailureReason(base)))));
      const key = encodeCacheKey([
        origin,
        health.pid,
        health.port,
        health.version,
        health.role,
        input.execution.binaryPath,
        input.execution.home,
        input.execution.cwd,
        selected.identity,
      ]);
      const now = yield* Clock.currentTimeMillis;
      if (!fresh && (positives.get(key) ?? 0) > now)
        return {
          modelRoute: "opencodex" as const,
          effectiveBaseUrl: base,
          state: health.role === "client" ? ("connected" as const) : ("home" as const),
        };
      const status = yield* cli(input, ["status", "--json"]).pipe(Effect.flatMap(decodeStatus));
      const statusUrl = yield* Effect.try(() => new URL(status.proxy.health.url));
      if (
        !status.proxy.running ||
        !status.proxy.health.ok ||
        status.proxy.pid !== health.pid ||
        status.listen.port !== health.port ||
        !["localhost", "127.0.0.1", "::1", "[::1]"].includes(status.listen.hostname ?? "") ||
        statusUrl.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(statusUrl.hostname) ||
        statusUrl.username ||
        statusUrl.password ||
        statusUrl.search ||
        statusUrl.hash ||
        statusUrl.pathname !== "/healthz" ||
        statusUrl.port !== new URL(base).port
      )
        return yield* unavailable(MISMATCH);
      // The public stored connection has no active-listener/binary binding. Its
      // credential/readiness fields are N/A, particularly for a disconnected Home.
      // K16's local fallback must never override a directly observed Child role.
      if (health.role !== "client") {
        const link = yield* cli(input, ["link", "status", "--json"]).pipe(
          Effect.flatMap(decodeLink),
        );
        if (link.role !== "home")
          return {
            modelRoute: "opencodex" as const,
            effectiveBaseUrl: base,
            state: "not_linked" as const,
            reason: "OpenCodex is not linked to Home",
          };
      }
      yield* json(`${base}/models`, base, true).pipe(Effect.flatMap(decodeModels));
      const after = yield* json(`${origin}/healthz`, base).pipe(Effect.flatMap(decodeHealth));
      if (
        after.pid !== health.pid ||
        after.port !== health.port ||
        after.version !== health.version ||
        after.role !== health.role
      )
        return yield* unavailable(MISMATCH);
      if (positives.size >= 64) positives.delete(positives.keys().next().value!);
      positives.set(key, now + 30_000);
      return {
        modelRoute: "opencodex" as const,
        effectiveBaseUrl: base,
        state: health.role === "client" ? ("connected" as const) : ("home" as const),
      };
    }).pipe(
      Effect.catch((error) => {
        positives.clear();
        const reason = isUnavailable(error) ? error.detail : STATUS_UNAVAILABLE;
        return Effect.succeed({
          modelRoute: "opencodex" as const,
          state: reason === TEMPORARY ? ("reconnecting" as const) : ("failed" as const),
          reason,
        });
      }),
    );
  const inFlight = new Map<string, Effect.Effect<CodexRouteStatus>>();
  const inspectShared = (input: RouteInput, fresh: boolean) =>
    Effect.gen(function* () {
      const key = encodeCacheKey([
        input.execution.binaryPath,
        input.execution.home,
        input.execution.cwd,
        input.settings.modelRoute,
        input.settings.opencodexBaseUrl,
        fresh,
      ]);
      const existing = inFlight.get(key);
      if (existing) return yield* existing;
      const check = yield* Effect.cached(
        inspect(input, fresh).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              inFlight.delete(key);
            }),
          ),
        ),
      );
      inFlight.set(key, check);
      return yield* check;
    });
  return OpenCodexRoute.of({
    launchArgs,
    inspect: (input) => inspectShared(input, true),
    requireAvailable: (input) =>
      inspectShared(input, false).pipe(
        Effect.flatMap((status) =>
          status.modelRoute === "default" || status.state === "connected" || status.state === "home"
            ? Effect.void
            : Effect.fail(unavailable(status.reason ?? STATUS_UNAVAILABLE)),
        ),
      ),
  });
});
export const layer = Layer.effect(OpenCodexRoute, make);
