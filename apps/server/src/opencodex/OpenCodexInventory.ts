import {
  ForwardCompatibleOptional,
  OpenCodexDeviceFallback,
  OpenCodexInventorySnapshot,
  OpenCodexProtocolEvidence,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
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

import * as ProcessRunner from "../processRunner.ts";

const MAX_BYTES = 256 * 1024;
const PROBE_TIMEOUT = "2 seconds";
const COMMAND_TIMEOUT = "3 seconds";
const CACHE_TTL = "30 seconds";
const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
const Role = Schema.Literals(["standalone", "hub", "client"]);
const Settings = Schema.Struct({
  fastMode: Schema.NullOr(Schema.Boolean),
  multiAgentMode: Schema.NullOr(Schema.Literals(["v1", "default", "v2"])),
  webSearchSidecarEnabled: Schema.Boolean,
  subagentDefaults: Schema.NullOr(
    Schema.Struct({ model: Schema.String, reasoningEffort: Schema.NullOr(Schema.String) }),
  ),
});
const SettingsRecord = Schema.Struct({
  linkId: Schema.String,
  fetchedAt: Schema.DateTimeUtcFromString,
  document: Schema.Struct({
    version: Schema.Literal(1),
    home: Schema.Struct({
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
      version: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    }),
    settings: Settings,
  }),
});
const decodeSettingsRecord = Schema.decodeUnknownOption(Schema.fromJsonString(SettingsRecord), {
  onExcessProperty: "error",
});
const Config = Schema.Struct({
  port: Schema.optional(Port),
  runtimeRole: Schema.optional(Role),
  client: Schema.optional(
    Schema.Struct({
      transport: Schema.optional(Schema.String),
      link: Schema.optional(Schema.Struct({ linkId: Schema.String })),
    }),
  ),
  fastMode: Schema.optional(Schema.Boolean),
  multiAgentMode: Schema.optional(Schema.Literals(["v1", "default", "v2"])),
  webSearchSidecar: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
  syncCodexSubagentDefaults: Schema.optional(Schema.Boolean),
  injectionModel: Schema.optional(Schema.String),
  injectionEffort: Schema.optional(Schema.String),
});
const Health = Schema.Struct({
  service: Schema.Literal("opencodex"),
  version: Schema.optional(Schema.String),
  role: Schema.optional(Role),
  port: Schema.optional(Port),
  uptime: ForwardCompatibleOptional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  instanceId: ForwardCompatibleOptional(Schema.String),
});
const Ready = Schema.Struct({
  ...Health.fields,
  ...OpenCodexProtocolEvidence.fields,
  status: Schema.Literals(["ready", "pending", "failed"]),
});
const Status = Schema.Struct({
  runtimeRole: Schema.optional(Role),
  appliedCodexSettingsDigest: ForwardCompatibleOptional(Schema.String),
  remoteHub: Schema.optional(
    Schema.Struct({ link: Schema.optional(Schema.Struct({ linkId: Schema.String })) }),
  ),
  // OCX-11 `ocx.fallback/1`. Rows are keyed by link id or Hub-client key id; a Child's read
  // through the link omits aliases, so this device finds its row by its own id.
  fallback: ForwardCompatibleOptional(
    Schema.Struct({
      schema: Schema.Literal("ocx.fallback/1"),
      source: OpenCodexDeviceFallback.fields.source,
      devices: Schema.Array(Schema.Struct({ id: Schema.String, localFallback: Schema.Boolean })),
    }),
  ),
});
const Link = Schema.Struct({
  role: Schema.Literals(["home", "child", "standalone"]),
  links: OpenCodexInventorySnapshot.fields.link.fields.links,
});
const Models = Schema.Struct({
  data: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
      Schema.Record(Schema.String, Schema.Json),
    ]),
  ),
});
const Providers = Schema.Struct({
  configured: Schema.Array(
    Schema.Struct({
      disabled: Schema.optional(Schema.Boolean),
      active: Schema.optional(Schema.Boolean),
    }),
  ),
});
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (value: Schema.Json): Schema.Json =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => compareText(a, b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const Connect = OpenCodexInventorySnapshot.fields.hubClient;
const Service = Schema.Struct({
  installed: Schema.optional(Schema.Boolean),
  running: Schema.optional(Schema.Boolean),
  backend: OpenCodexInventorySnapshot.fields.service.fields.backend,
});
const decodeProtocols = Schema.decodeUnknownOption(OpenCodexProtocolEvidence);

class InventoryReadError extends Schema.TaggedError<InventoryReadError>()("InventoryReadError", {
  stage: Schema.Literals(["http", "size"]),
}) {}

/** The installer may supply this only for an install GOAT created; discovery never adopts ownership. */
export const ManagedInstall = Context.Reference<boolean>("goat/opencodex/ManagedInstall", {
  defaultValue: () => false,
});

export class OpenCodexInventory extends Context.Service<
  OpenCodexInventory,
  {
    readonly read: Effect.Effect<OpenCodexInventorySnapshot>;
    readonly readParity: Effect.Effect<OpenCodexInventorySnapshot>;
  }
>()("goat/opencodex/OpenCodexInventory") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const cwd = yield* HostProcess.WorkingDirectory;
  const managed = yield* ManagedInstall;
  const runner = yield* ProcessRunner.ProcessRunner;
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const crypto = yield* Crypto.Crypto;
  const digest = (value: unknown) =>
    crypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))).pipe(
      Effect.map(Hex.encode),
      Effect.orElseSucceed(() => undefined),
    );
  const ocxHome = path.resolve(cwd, environment.OPENCODEX_HOME || path.join(home, ".opencodex"));
  const decodeJson = <A, I>(schema: Schema.Codec<A, I>, text: string) =>
    Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text));

  const readFile = Effect.fn("OpenCodexInventory.readFile")(
    function* (filename: string) {
      const stat = yield* fs.stat(filename);
      if (stat.size > MAX_BYTES) return undefined;
      return yield* fs.readFileString(filename);
    },
    Effect.orElseSucceed(() => undefined),
  );

  const command = Effect.fn("OpenCodexInventory.command")(
    function* (binary: string, args: ReadonlyArray<string>) {
      const output = yield* runner.run({
        command: binary,
        args,
        env: environment,
        cwd,
        timeout: COMMAND_TIMEOUT,
        maxOutputBytes: MAX_BYTES,
      });
      return output.code === 0 &&
        !output.timedOut &&
        !output.stdoutTruncated &&
        !output.stdoutInvalidUtf8
        ? output.stdout
        : undefined;
    },
    Effect.timeout(COMMAND_TIMEOUT),
    Effect.orElseSucceed(() => undefined),
  );

  const probe = Effect.fn("OpenCodexInventory.probe")(
    function* (port: number, endpoint: "healthz" | "readyz" | "v1/models") {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* http
            .execute(HttpClientRequest.get(`http://127.0.0.1:${port}/${endpoint}`))
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, {
                redirect: "manual",
                credentials: "omit",
              }),
            );
          // Never follow a local service's redirect to another machine or disclose auth state.
          if (
            response.status !== 200 &&
            !(endpoint === "readyz" && response.status === 503) &&
            endpoint !== "v1/models"
          ) {
            return yield* new InventoryReadError({ stage: "http" });
          }
          let size = 0;
          const text = yield* response.stream.pipe(
            Stream.tap((chunk) => {
              size += chunk.byteLength;
              return size > MAX_BYTES
                ? Effect.fail(new InventoryReadError({ stage: "size" }))
                : Effect.void;
            }),
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (body, chunk) => body + chunk,
            ),
          );
          return {
            text,
            status: response.status,
            servedBy: response.headers["x-opencodex-served-by"],
            observedAt: yield* Clock.currentTimeMillis,
          };
        }),
      ).pipe(Effect.timeout(PROBE_TIMEOUT));
    },
    Effect.orElseSucceed(() => undefined),
  );

  const collect = Effect.fn("OpenCodexInventory.collect")(function* (parity = false) {
    const configText = yield* readFile(path.join(ocxHome, "config.json"));
    const config = configText === undefined ? undefined : decodeJson(Config, configText);
    const port = config?.port ?? 10100;
    const [healthResponse, readyResponse] = yield* Effect.all(
      [probe(port, "healthz"), probe(port, "readyz")],
      { concurrency: 2 },
    );
    const healthBody = healthResponse && decodeJson(Health, healthResponse.text);
    const health =
      healthBody && (healthBody.port === undefined || healthBody.port === port)
        ? healthBody
        : undefined;
    const readyBody = readyResponse && decodeJson(Ready, readyResponse.text);
    const ready =
      readyBody && (readyBody.port === undefined || readyBody.port === port)
        ? readyBody
        : undefined;

    // Match remoteOcxArgv: Desktop and system installs win over interactive PATH shims.
    const directories = [
      ...(environment.PATH ?? "").split(platform === "win32" ? ";" : ":"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];
    const candidates = [
      ...new Set([
        path.join(home, ".opencodex-desktop", "bin", "ocx"),
        "/Applications/OpenCodex.app/Contents/MacOS/ocx",
        "/usr/bin/ocx",
        ...directories.flatMap((directory) =>
          platform === "win32"
            ? [
                path.resolve(cwd, directory || ".", "ocx.exe"),
                path.resolve(cwd, directory || ".", "ocx.cmd"),
                path.resolve(cwd, directory || ".", "ocx.bat"),
                path.resolve(cwd, directory || ".", "ocx"),
              ]
            : [path.resolve(cwd, directory || ".", "ocx")],
        ),
      ]),
    ];
    const verified = new Map<string, string>();
    yield* Effect.forEach(
      candidates,
      (candidate) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))))
            return undefined;
          const output = yield* command(candidate, ["--version"]);
          const version = output
            ?.trim()
            .match(/^(?:ocx\s+|OpenCodex\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/i)?.[1];
          if (version) verified.set(candidate, version);
        }),
      { concurrency: 4, discard: true },
    ).pipe(
      Effect.timeout(COMMAND_TIMEOUT),
      // A hanging PATH shim must not erase an already verified Desktop install.
      Effect.ignore,
    );
    const binaries = candidates.flatMap((candidate) => {
      const version = verified.get(candidate);
      return version ? [{ path: candidate, version }] : [];
    });
    const binary = binaries[0]?.path;
    const outputs = binary
      ? yield* Effect.all(
          [
            command(binary, ["status", "--json"]),
            command(binary, ["link", "status", "--json"]),
            command(binary, ["connect", "status", "--json"]),
            command(binary, ["service", "status", "--json"]),
          ],
          { concurrency: 4 },
        )
      : [];
    const status = outputs[0] === undefined ? undefined : decodeJson(Status, outputs[0]);
    const link = outputs[1] === undefined ? undefined : decodeJson(Link, outputs[1]);
    const connect = outputs[2] === undefined ? undefined : decodeJson(Connect, outputs[2]);
    const serviceBody = outputs[3] === undefined ? undefined : decodeJson(Service, outputs[3]);
    const service =
      serviceBody && Object.values(serviceBody).some((value) => value !== undefined)
        ? serviceBody
        : undefined;
    const protocols = ready && Option.getOrUndefined(decodeProtocols(ready));
    const role =
      health?.role ??
      status?.runtimeRole ??
      config?.runtimeRole ??
      (health ? "standalone" : undefined);
    const linkRole =
      link?.role === "home"
        ? "home"
        : link?.role === "child" || (role === "client" && config?.client?.transport === "link")
          ? "child"
          : "none";
    const childSettingsApplied = yield* fs
      .exists(path.join(ocxHome, "link", "home-codex-settings.json"))
      .pipe(Effect.orElseSucceed(() => null));
    const childLinkId = config?.client?.link?.linkId ?? status?.remoteHub?.link?.linkId;
    const hubClient = connect && linkRole !== "child" && connect.apiKeyId ? connect : undefined;
    const ownDeviceId = linkRole === "child" ? childLinkId : hubClient?.apiKeyId;
    const fallbackRow =
      ownDeviceId === undefined
        ? undefined
        : status?.fallback?.devices.find(({ id }) => id === ownDeviceId);
    const installed = binaries.length > 0 || health !== undefined || ready !== undefined;
    let parityEvidence: OpenCodexInventorySnapshot["parityEvidence"];
    if (parity) {
      const observedAt = yield* Clock.currentTimeMillis;
      const modelsResponse = yield* probe(port, "v1/models");
      const providerText = binary
        ? yield* command(binary, ["provider", "list", "--json"])
        : undefined;
      const providers =
        providerText === undefined ? undefined : decodeJson(Providers, providerText);
      // Legacy provider list reports configuration, not activity. On a Child those
      // rows can be inactive; only an empty list or explicit activity proves P8.
      const localProviderCount = providers?.configured.every(
        (provider) => provider.active !== undefined || provider.disabled === true,
      )
        ? providers.configured.filter(
            (provider) => provider.active === true && provider.disabled !== true,
          ).length
        : undefined;
      const models =
        modelsResponse?.status === 200 ? decodeJson(Models, modelsResponse.text) : undefined;
      const recordText =
        linkRole === "child"
          ? yield* readFile(path.join(ocxHome, "link", "home-codex-settings.json"))
          : undefined;
      const record =
        recordText === undefined
          ? undefined
          : Option.getOrUndefined(decodeSettingsRecord(recordText));
      // Project only Home policy, matching OpenCodex's version-1 settings document. Home labels
      // and release numbers describe the publisher and must not manufacture settings drift.
      const settings =
        (record
          ? { version: record.document.version, settings: record.document.settings }
          : undefined) ??
        (linkRole === "home" && config
          ? {
              version: 1,
              settings: {
                fastMode: config.fastMode ?? null,
                multiAgentMode: config.multiAgentMode ?? null,
                webSearchSidecarEnabled: config.webSearchSidecar?.enabled !== false,
                subagentDefaults:
                  config.syncCodexSubagentDefaults === true && config.injectionModel?.trim()
                    ? {
                        model: config.injectionModel.trim(),
                        reasoningEffort: config.injectionEffort?.trim() || null,
                      }
                    : null,
              },
            }
          : undefined);
      parityEvidence = {
        observedAt,
        ...(health ? { healthRole: health.role ?? "standalone" } : {}),
        ...(health?.instanceId ? { instanceId: health.instanceId } : {}),
        ...(health?.uptime !== undefined && healthResponse
          ? { startedAt: healthResponse.observedAt - health.uptime * 1000 }
          : {}),
        ...(childLinkId ? { childLinkId } : {}),
        ...(record ? { settingsLinkId: record.linkId } : {}),
        ...(settings ? { settingsDigest: yield* digest(settings) } : {}),
        ...(status?.appliedCodexSettingsDigest
          ? { appliedSettingsDigest: status.appliedCodexSettingsDigest }
          : {}),
        ...(modelsResponse ? { modelsStatus: modelsResponse.status } : {}),
        // Model order is not routing drift; duplicate ids still change the digest.
        ...(models
          ? {
              catalogDigest: yield* digest(
                models.data
                  .map(canonical)
                  .sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b))),
              ),
            }
          : {}),
        ...(modelsResponse?.servedBy ? { servedBy: modelsResponse.servedBy } : {}),
        ...(localProviderCount !== undefined ? { localProviderCount } : {}),
      };
    }
    return {
      installed,
      binaries,
      ownership: installed ? (managed ? "managed" : "adopted") : "none",
      service: { available: service !== undefined, ...service },
      runtime: {
        ...protocols,
        ...(health?.version
          ? { version: health.version }
          : ready?.version
            ? { version: ready.version }
            : {}),
        ...(role ? { role } : {}),
        port,
        healthy: health !== undefined,
        ready: readyResponse?.status === 200 && ready?.status === "ready",
      },
      link: {
        role: linkRole,
        available: link !== undefined,
        links: linkRole === "home" ? (link?.links ?? []) : [],
        childSettingsApplied,
      },
      ...(hubClient ? { hubClient } : {}),
      ...(parityEvidence ? { parityEvidence } : {}),
      ...(status?.fallback
        ? {
            fallback: {
              source: status.fallback.source,
              ...(fallbackRow ? { localFallback: fallbackRow.localFallback } : {}),
            },
          }
        : {}),
    } satisfies OpenCodexInventorySnapshot;
  });

  // Host status is polled by several clients; share in-flight work and avoid spawning ocx on every poll.
  const read = yield* Effect.cachedWithTTL(collect(), CACHE_TTL);
  return OpenCodexInventory.of({ read, readParity: collect(true) });
});

export const layer = Layer.effect(OpenCodexInventory, make);
