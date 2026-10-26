#!/usr/bin/env node

// First, so an unsupported Node stops here before any other module loads.
import "./lib/dev-node-guard.ts";
import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import { resolveGitWorktreePath, resolveWorktreeHome } from "@goat/shared/devHome";
import { resolveGoatHome } from "@goat/shared/goatHome";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveSpawnCommand } from "@goat/shared/shell";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess } from "effect/process";

import { type DevShareError, shareDevServer, unshareDevServer } from "./lib/dev-share.ts";
import { prepareFirstStart } from "./lib/dev-first-start.ts";
import { withDevMaxHttpHeaderSize } from "./lib/dev-max-header-size.ts";
import { normalizeLegacyEnv } from "@goat/contracts/legacyT3Names";

import { loadRepoEnv } from "./lib/public-config.ts";

Object.assign(process.env, loadRepoEnv());
// Children run this build; legacy names would survive the deletes below.
normalizeLegacyEnv(process.env);

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;
const DESKTOP_DEV_LOOPBACK_HOST = "127.0.0.1";
// Browsers block these ports before networking even when curl accepts them.
// https://fetch.spec.whatwg.org/#port-blocking
const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);
// Dev binds loopback; other interfaces cannot establish port availability.
const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "::1"] as const;

/** Only loopback and wildcard binds keep the loopback proxy target reachable. */
export function isProxiableBindHost(host: string): boolean {
  const normalized = host.trim();
  return (
    normalized === "" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]"
  );
}

/** The home an implicit dev run uses; a dev state left in `~/.t3` keeps being used. */
export const DEFAULT_GOAT_HOME = resolveGoatHome(NodeOS.homedir(), "dev");

const MODE_ARGS = {
  dev: [
    "run",
    "--filter=@goat/contracts",
    "--filter=@goat/web",
    "--filter=goat",
    "--parallel",
    "dev",
  ],
  "dev:server": ["run", "--filter=goat", "dev"],
  "dev:web": ["run", "--filter=@goat/web", "dev"],
  "dev:desktop": ["run", "--filter=@goat/desktop", "--filter=@goat/web", "dev"],
} as const satisfies Record<string, ReadonlyArray<string>>;

// `--built`: the web package rebuilds into apps/web/dist and the backend serves
// it, so no Vite dev server runs.
const BUILT_DEV_ARGS = [
  "run",
  "--filter=@goat/web",
  "--filter=goat",
  "--parallel",
  "dev:built",
] as const;

type DevMode = keyof typeof MODE_ARGS;
// Only backend ports honor --host/GOAT_HOST; web ports stay loopback.
type PortAvailabilityCheck<R = never> = (
  port: number,
  role?: "server" | "web",
) => Effect.Effect<boolean, never, R>;

const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

export function isBrowserAllowedPort(port: number): boolean {
  return !FETCH_BAD_PORTS.has(port);
}

export class DevRunnerConfigurationError extends Schema.TaggedError<DevRunnerConfigurationError>()(
  "DevRunnerConfigurationError",
  {
    configKeys: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read dev-runner configuration: ${this.configKeys.join(", ")}.`;
  }
}

export class DevRunnerInvalidPortOffsetError extends Schema.TaggedError<DevRunnerInvalidPortOffsetError>()(
  "DevRunnerInvalidPortOffsetError",
  {
    configKey: Schema.Literal("GOAT_PORT_OFFSET"),
    portOffset: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.configKey} must be at least ${this.minimum}; received ${this.portOffset}.`;
  }
}

export class DevRunnerPortExhaustedError extends Schema.TaggedError<DevRunnerPortExhaustedError>()(
  "DevRunnerPortExhaustedError",
  {
    startOffset: Schema.Number,
    requireServerPort: Schema.Boolean,
    requireWebPort: Schema.Boolean,
    baseServerPort: Schema.Number,
    baseWebPort: Schema.Number,
    maximumPort: Schema.Number,
  },
) {
  override get message(): string {
    return `No required dev ports were available from offset ${this.startOffset} through maximum port ${this.maximumPort}.`;
  }
}

export class DevRunnerProcessError extends Schema.TaggedError<DevRunnerProcessError>()(
  "DevRunnerProcessError",
  {
    operation: Schema.Literals(["spawn", "wait-for-exit"]),
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]),
    executable: Schema.Literal("vp"),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Dev-runner process operation "${this.operation}" failed for mode "${this.mode}".`;
  }
}

export class DevRunnerProcessExitError extends Schema.TaggedError<DevRunnerProcessExitError>()(
  "DevRunnerProcessExitError",
  {
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]),
    executable: Schema.Literal("vp"),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Dev-runner process exited with code ${this.exitCode} in mode "${this.mode}".`;
  }
}

export class DevRunnerHostNotProxiableError extends Schema.TaggedError<DevRunnerHostNotProxiableError>()(
  "DevRunnerHostNotProxiableError",
  {
    mode: Schema.Literals(["dev", "dev:web"]),
    host: Schema.String,
  },
) {
  override get message(): string {
    return `--host ${this.host} cannot be combined with ${this.mode}: single-origin browser dev proxies the backend at localhost, and a backend bound only to ${this.host} leaves localhost unanswered, so every proxied request fails. Use a wildcard (0.0.0.0 or ::) to serve that interface and loopback together, or --share for remote access.`;
  }
}

export class DevRunnerBuiltNeedsShareError extends Schema.TaggedError<DevRunnerBuiltNeedsShareError>()(
  "DevRunnerBuiltNeedsShareError",
  {
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]),
  },
) {
  override get message(): string {
    return `--built only works with \`dev --share\` (got ${this.mode}${this.mode === "dev" ? " without --share" : ""}): the backend serves the built client on the tailnet URL.`;
  }
}

const optionalStringConfig = (name: string): Config.Config<string | undefined> =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalBooleanConfig = (name: string): Config.Config<boolean | undefined> =>
  Config.Boolean(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.Port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.Int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const OffsetConfig = Config.all({
  portOffset: optionalIntegerConfig("GOAT_PORT_OFFSET"),
  devInstance: optionalStringConfig("GOAT_DEV_INSTANCE"),
});

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
  readonly worktreePath?: string | undefined;
}): Effect.Effect<
  { readonly offset: number; readonly source: string },
  DevRunnerInvalidPortOffsetError
> {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      return Effect.fail(
        new DevRunnerInvalidPortOffsetError({
          configKey: "GOAT_PORT_OFFSET",
          portOffset: config.portOffset,
          minimum: 0,
        }),
      );
    }
    return Effect.succeed({
      offset: config.portOffset,
      source: `GOAT_PORT_OFFSET=${config.portOffset}`,
    });
  }

  const seed = config.devInstance?.trim();
  if (seed) {
    if (/^\d+$/.test(seed)) {
      return Effect.succeed({
        offset: Number(seed),
        source: `numeric GOAT_DEV_INSTANCE=${seed}`,
      });
    }

    const offset = ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;
    return Effect.succeed({ offset, source: `hashed GOAT_DEV_INSTANCE=${seed}` });
  }

  const worktreePath = config.worktreePath?.trim();
  if (worktreePath) {
    const offset = ((Hash.string(worktreePath) >>> 0) % MAX_HASH_OFFSET) + 1;
    return Effect.succeed({ offset, source: `worktree ${worktreePath}` });
  }

  return Effect.succeed({ offset: 0, source: "default ports" });
}

const resolveBaseDir = Effect.fn("dev-runner.resolveBaseDir")(function* (
  baseDir: string | undefined,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const configured = baseDir?.trim();

  if (configured) {
    return path.resolve(configured);
  }

  return yield* DEFAULT_GOAT_HOME;
});

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly goatHome: string | undefined;
  readonly browser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
}

export const createDevRunnerEnv = Effect.fn("dev-runner.createDevRunnerEnv")(function* ({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  goatHome,
  browser,
  autoBootstrapProjectFromCwd,
  logWebSocketEvents,
  host,
  port,
  devUrl,
}: CreateDevRunnerEnvInput): Effect.fn.Return<
  NodeJS.ProcessEnv,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
  const webPort = BASE_WEB_PORT + webOffset;
  const configuredBaseDir = goatHome?.trim() || undefined;
  const resolvedBaseDir = yield* resolveBaseDir(configuredBaseDir);
  const isDesktopMode = mode === "dev:desktop";

  const output: NodeJS.ProcessEnv = {
    ...baseEnv,
    PORT: String(webPort),
    VITE_DEV_SERVER_URL:
      devUrl?.toString() ??
      `http://${isDesktopMode ? DESKTOP_DEV_LOOPBACK_HOST : "localhost"}:${webPort}`,
  };

  if (configuredBaseDir !== undefined) {
    output.GOAT_HOME = resolvedBaseDir;
  } else {
    delete output.GOAT_HOME;
  }

  // A dev-runner server is never launcher-managed. A shell the managed goat service spawned (an
  // agent inside GOAT) leaks these, and the child then fails with "The service launcher started
  // a different goat version." (serviceLauncherClient.ts resolveStartup).
  delete output.GOAT_SERVICE_LAUNCHER_CONTEXT;
  delete output.GOAT_BOOT_SERVICE_UNIT;

  // Each worktree has its own state, so a dev server would count as a new
  // install of the developer's real accounts. Set it explicitly to opt in.
  output.GOAT_TELEMETRY_ENABLED = baseEnv.GOAT_TELEMETRY_ENABLED ?? "false";

  if (!isDesktopMode) {
    output.GOAT_PORT = String(serverPort);
    output.NODE_OPTIONS = withDevMaxHttpHeaderSize(output.NODE_OPTIONS);
    // An inherited HOST pins Vite's HMR socket via explicitHost in apps/web/vite.config.ts.
    // Only desktop mode should set it.
    delete output.HOST;
    if (mode === "dev" || mode === "dev:web") {
      // Browser dev is single-origin: everything (including /ws) is proxied
      // through Vite, so the client must resolve its backend from
      // window.location.origin rather than a baked-in localhost URL.
      delete output.VITE_HTTP_URL;
      delete output.VITE_WS_URL;
      // Deleting is not enough on its own: vite.config.ts calls loadRepoEnv,
      // which merges `.env`/`.env.local` *under* this env, so a developer
      // with either URL in their `.env` would get it back and silently lose
      // single-origin mode.
      output.GOAT_SINGLE_ORIGIN_DEV = "1";
    } else {
      output.VITE_HTTP_URL = `http://localhost:${serverPort}`;
      output.VITE_WS_URL = `ws://localhost:${serverPort}`;
      delete output.GOAT_SINGLE_ORIGIN_DEV;
    }
  } else {
    output.GOAT_PORT = String(serverPort);
    output.VITE_HTTP_URL = `http://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
    output.VITE_WS_URL = `ws://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
    // Desktop pins the renderer to loopback on purpose; an ambient marker
    // must not make Vite drop those URLs.
    delete output.GOAT_SINGLE_ORIGIN_DEV;
    delete output.GOAT_MODE;
    delete output.GOAT_NO_BROWSER;
    delete output.GOAT_HOST;
    delete output.GOAT_DEV_AUTH_TOKEN;
  }

  if (!isDesktopMode && host !== undefined) {
    output.GOAT_HOST = host;
  }

  if (!isDesktopMode) {
    output.GOAT_NO_BROWSER = browser === true ? "0" : "1";
  }

  if (autoBootstrapProjectFromCwd !== undefined) {
    output.GOAT_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
  } else {
    delete output.GOAT_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
  }

  if (logWebSocketEvents !== undefined) {
    output.GOAT_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
  } else {
    delete output.GOAT_LOG_WS_EVENTS;
  }

  if (mode === "dev") {
    output.GOAT_MODE = "web";
    delete output.GOAT_DESKTOP_WS_URL;
  }

  if (mode === "dev:server" || mode === "dev:web") {
    output.GOAT_MODE = "web";
    delete output.GOAT_DESKTOP_WS_URL;
  }

  if (isDesktopMode) {
    output.HOST = DESKTOP_DEV_LOOPBACK_HOST;
    delete output.GOAT_DESKTOP_WS_URL;
  }

  return output;
});

function portPairForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
} {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

export const checkPortAvailabilityOnHosts = Effect.fn("dev-runner.checkPortAvailabilityOnHosts")(
  function* <R>(
    port: number,
    hosts: ReadonlyArray<string>,
    canListenOnHost: (port: number, host: string) => Effect.Effect<boolean, never, R>,
  ): Effect.fn.Return<boolean, never, R> {
    for (const host of hosts) {
      if (!(yield* canListenOnHost(port, host))) {
        return false;
      }
    }

    return true;
  },
);

export function devPortProbeHosts(configuredHost: string | undefined): ReadonlyArray<string> {
  const host = configuredHost?.trim();
  if (!host || DEV_PORT_PROBE_HOSTS.includes(host as (typeof DEV_PORT_PROBE_HOSTS)[number])) {
    return DEV_PORT_PROBE_HOSTS;
  }
  return [...DEV_PORT_PROBE_HOSTS, host];
}

const makeDefaultCheckPortAvailability =
  (configuredHost: string | undefined): PortAvailabilityCheck<NetService.NetService> =>
  (port, role) =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const hosts = role === "web" ? DEV_PORT_PROBE_HOSTS : devPortProbeHosts(configuredHost);
      return yield* checkPortAvailabilityOnHosts(port, hosts, (candidatePort, host) =>
        net.canListenOnHost(candidatePort, host),
      );
    });

const defaultCheckPortAvailability = makeDefaultCheckPortAvailability(undefined);

interface FindFirstAvailableOffsetInput<R = NetService.NetService> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export const findFirstAvailableOffset = Effect.fn("dev-runner.findFirstAvailableOffset")(function* <
  R = NetService.NetService,
>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.fn.Return<number, DevRunnerPortExhaustedError, R> {
  const checkPort = (checkPortAvailability ??
    defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

  for (let candidate = startOffset; ; candidate += 1) {
    const { serverPort, webPort } = portPairForOffset(candidate);
    const serverPortOutOfRange = serverPort > MAX_PORT;
    const webPortOutOfRange = webPort > MAX_PORT;

    if (
      (requireServerPort && serverPortOutOfRange) ||
      (requireWebPort && webPortOutOfRange) ||
      (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
    ) {
      break;
    }

    if (requireWebPort && !isBrowserAllowedPort(webPort)) {
      continue;
    }

    const checks: Array<Effect.Effect<boolean, never, R>> = [];
    if (requireServerPort) {
      checks.push(checkPort(serverPort, "server"));
    }
    if (requireWebPort) {
      checks.push(checkPort(webPort, "web"));
    }

    if (checks.length === 0) {
      return candidate;
    }

    const availability = yield* Effect.all(checks);
    if (availability.every(Boolean)) {
      return candidate;
    }
  }

  return yield* new DevRunnerPortExhaustedError({
    startOffset,
    requireServerPort,
    requireWebPort,
    baseServerPort: BASE_SERVER_PORT,
    baseWebPort: BASE_WEB_PORT,
    maximumPort: MAX_PORT,
  });
});

interface ResolveModePortOffsetsInput<R = NetService.NetService> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export const resolveModePortOffsets = Effect.fn("dev-runner.resolveModePortOffsets")(function* <
  R = NetService.NetService,
>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.fn.Return<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerPortExhaustedError,
  R
> {
  const checkPort = (checkPortAvailability ??
    defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

  if (mode === "dev:web") {
    if (hasExplicitDevUrl) {
      return { serverOffset: startOffset, webOffset: startOffset };
    }

    const webOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: false,
      requireWebPort: true,
      checkPortAvailability: checkPort,
    });
    return { serverOffset: startOffset, webOffset };
  }

  if (mode === "dev:server") {
    if (hasExplicitServerPort) {
      return { serverOffset: startOffset, webOffset: startOffset };
    }

    const serverOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: true,
      requireWebPort: false,
      checkPortAvailability: checkPort,
    });
    return { serverOffset, webOffset: serverOffset };
  }

  const sharedOffset = yield* findFirstAvailableOffset({
    startOffset,
    requireServerPort: !hasExplicitServerPort,
    requireWebPort: !hasExplicitDevUrl,
    checkPortAvailability: checkPort,
  });

  return { serverOffset: sharedOffset, webOffset: sharedOffset };
});

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly goatHome: string | undefined;
  readonly browser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly share: boolean;
  readonly seed?: boolean | undefined;
  readonly built: boolean;
  readonly runArgs: ReadonlyArray<string>;
}

export const runDevRunnerWithInput = Effect.fn("dev-runner.runDevRunnerWithInput")(function* (
  input: DevRunnerCliInput,
) {
  const { portOffset, devInstance } = yield* OffsetConfig.pipe(
    Effect.mapError(
      (cause) =>
        new DevRunnerConfigurationError({
          configKeys: ["GOAT_PORT_OFFSET", "GOAT_DEV_INSTANCE"],
          cause,
        }),
    ),
  );

  if (
    (input.mode === "dev" || input.mode === "dev:web") &&
    input.host !== undefined &&
    !isProxiableBindHost(input.host)
  ) {
    return yield* new DevRunnerHostNotProxiableError({ mode: input.mode, host: input.host });
  }

  if (input.built && (input.mode !== "dev" || !input.share)) {
    return yield* new DevRunnerBuiltNeedsShareError({ mode: input.mode });
  }

  const worktreePath = yield* resolveGitWorktreePath(yield* HostProcess.WorkingDirectory);

  const { offset, source } = yield* resolveOffset({
    portOffset,
    devInstance,
    worktreePath,
  });

  const { serverOffset, webOffset } = yield* resolveModePortOffsets({
    mode: input.mode,
    startOffset: offset,
    hasExplicitServerPort: input.port !== undefined,
    hasExplicitDevUrl: input.devUrl !== undefined,
    checkPortAvailability: makeDefaultCheckPortAvailability(input.host),
  });

  const hostEnvironment = yield* HostProcess.Environment;
  // A dev server started inside a worktree defaults to that worktree's own
  // (gitignored) `.t3` — see @goat/shared/devHome for why this must
  // outrank an ambient GOAT_HOME. `--home-dir` still wins.
  const worktreeHome = yield* resolveWorktreeHome(yield* HostProcess.WorkingDirectory);
  // Trim before choosing: `--home-dir ""` is not a selection, and treating it
  // as one would skip the worktree default and land on the shared home —
  // exactly the outcome this precedence exists to prevent.
  const resolvedGoatHome =
    (input.goatHome?.trim() || undefined) ??
    worktreeHome ??
    (hostEnvironment.GOAT_HOME?.trim() || undefined);
  const env = yield* createDevRunnerEnv({
    mode: input.mode,
    baseEnv: hostEnvironment,
    serverOffset,
    webOffset,
    goatHome: resolvedGoatHome,
    browser: input.browser,
    autoBootstrapProjectFromCwd: input.autoBootstrapProjectFromCwd,
    logWebSocketEvents: input.logWebSocketEvents,
    host: input.host,
    port: input.port,
    devUrl: input.devUrl,
  });

  const selectionSuffix =
    serverOffset !== offset || webOffset !== offset
      ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
      : "";
  const baseDir = env.GOAT_HOME ?? (yield* DEFAULT_GOAT_HOME);

  yield* Effect.logInfo(
    `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.GOAT_PORT)} webPort=${String(env.PORT)} baseDir=${baseDir}`,
  );

  // Before the share block: --dry-run only resolves and prints. Sharing would
  // replace, then tear down, whatever mapping the port already had — a
  // surprising side effect from a command documented as inert.
  if (input.dryRun) {
    return;
  }

  const sharedWebPort = BASE_WEB_PORT + webOffset;
  let built = false;
  if (input.share) {
    if (input.mode === "dev:server") {
      yield* Effect.logInfo("[dev-runner] --share has no effect for dev:server (no web server).");
    } else if (input.mode === "dev:desktop") {
      yield* Effect.logWarning(
        "[dev-runner] --share is not supported for dev:desktop (the renderer is pinned to loopback). Use `dev`, which runs the whole browser stack.",
      );
    } else {
      // acquireRelease, not share-then-addFinalizer: the mapping outlives this
      // process (and reboots), so the cleanup has to be registered atomically
      // with creating it. An interrupt landing in between would otherwise
      // leave a mapping pointing at a port nothing is listening on.
      const shared = yield* Effect.acquireRelease(
        shareDevServer({
          webPort: sharedWebPort,
          // The backend binds 127.0.0.1 unless --host changes it. A wildcard
          // still answers there; `--host ::1` binds only the IPv6 loopback.
          ...(input.built
            ? {
                localTarget: {
                  port: Number(env.GOAT_PORT),
                  host: ["::1", "[::1]"].includes(input.host?.trim() ?? "") ? "[::1]" : "127.0.0.1",
                },
              }
            : {}),
        }),
        () =>
          unshareDevServer(sharedWebPort).pipe(
            Effect.flatMap((result) =>
              result.cleared
                ? Effect.void
                : Effect.logWarning(
                    `[dev-runner] could not remove the tailnet mapping for port ${String(sharedWebPort)}${
                      result.explanation ? `: ${result.explanation}` : ""
                    }. Remove it with \`tailscale serve --https=${String(sharedWebPort)} off\`.`,
                  ),
            ),
          ),
      ).pipe(
        Effect.tapError((error: DevShareError) =>
          Effect.logWarning(
            `[dev-runner] could not share on the tailnet: ${error.message}${
              error.hint ? ` — ${error.hint}` : ""
            }`,
          ),
        ),
        Effect.option,
        Effect.map(Option.getOrUndefined),
      );

      if (shared) {
        // The app is reached from the tailnet origin. Vite already allows
        // *.ts.net hosts; the backend needs the origin for credentialed
        // requests that bypass the proxy (desktop renderer, direct calls).
        env.GOAT_DEV_ALLOWED_ORIGINS = [env.GOAT_DEV_ALLOWED_ORIGINS, new URL(shared.url).origin]
          .filter((entry) => entry && entry.length > 0)
          .join(",");
        if (input.devUrl === undefined) {
          env.VITE_DEV_SERVER_URL = shared.url;
        }
        if (input.built) {
          built = true;
          env.GOAT_BUILT_DEV = "1";
        } else if (env.GOAT_BUNDLED_DEV === undefined) {
          // A shared origin serves a remote browser, where unbundled dev's
          // per-module requests each pay a tailnet round trip — a cold module
          // graph takes minutes to first paint. Bundled dev collapses that to a
          // few chunk requests.
          env.GOAT_BUNDLED_DEV = "1";
        }
        yield* Effect.logInfo(`[dev-runner] shared on tailnet: ${shared.url}`);
      } else if (input.built) {
        yield* Effect.logWarning(
          "[dev-runner] --built needs the tailnet share; running the Vite dev server instead.",
        );
      }
    }
  }

  // After sharing, so the warm step sees the same bundled-dev env as Vite.
  yield* prepareFirstStart({
    repoRoot: (yield* Path.Path).dirname(import.meta.dirname),
    mode: input.mode,
    seed: input.seed !== false,
    worktreeHome: baseDir === worktreeHome ? worktreeHome : undefined,
    env,
  });

  const args = [...(built ? BUILT_DEV_ARGS : MODE_ARGS[input.mode]), ...input.runArgs];
  const spawnCommand = yield* resolveSpawnCommand("vp", args, { env });
  const processContext = {
    mode: input.mode,
    executable: "vp" as const,
    argumentCount: args.length,
    shell: spawnCommand.shell,
  } as const;
  const child = yield* ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
    extendEnv: false,
    shell: spawnCommand.shell,
    // Keep Vite+ in the same process group so terminal signals (Ctrl+C)
    // reach it directly. Effect defaults to detached: true on non-Windows,
    // which would put the runner in a new group and require manual forwarding.
    detached: false,
    forceKillAfter: "1500 millis",
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DevRunnerProcessError({
          ...processContext,
          operation: "spawn",
          cause,
        }),
    ),
  );

  const exitCode = yield* child.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new DevRunnerProcessError({
          ...processContext,
          operation: "wait-for-exit",
          cause,
        }),
    ),
  );
  if (exitCode !== 0) {
    return yield* new DevRunnerProcessExitError({
      ...processContext,
      exitCode,
    });
  }
});

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.Literals("mode", DEV_RUNNER_MODES).pipe(
    Argument.withDescription("Development mode to run."),
  ),
  goatHome: Flag.String("home-dir").pipe(
    Flag.withDescription(
      "Explicit GOAT data directory; runtime state is stored under userdata (equivalent to GOAT_HOME). Inside a git worktree this defaults to that worktree's own .t3 so dev state stays off the shared home.",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  browser: Flag.Boolean("browser").pipe(
    Flag.withDescription("Open a browser automatically (disabled by default for web dev)."),
    Flag.withDefault(false),
  ),
  autoBootstrapProjectFromCwd: Flag.Boolean("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription(
      "Auto-bootstrap toggle (equivalent to GOAT_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("GOAT_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  ),
  logWebSocketEvents: Flag.Boolean("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle (equivalent to GOAT_LOG_WS_EVENTS)."),
    Flag.withAlias("log-ws-events"),
    Flag.withFallbackConfig(optionalBooleanConfig("GOAT_LOG_WS_EVENTS")),
  ),
  host: Flag.String("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to GOAT_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("GOAT_HOST")),
  ),
  port: Flag.Int("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to GOAT_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("GOAT_PORT")),
  ),
  devUrl: Flag.String("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription(
      "Explicit web dev URL override (forwards to VITE_DEV_SERVER_URL). Ambient VITE_DEV_SERVER_URL values are ignored so a parent dev app cannot redirect the child runner.",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Resolve mode/ports/env and print, but do not spawn Vite+."),
    Flag.withDefault(false),
  ),
  share: Flag.Boolean("share").pipe(
    Flag.withDescription(
      "Publish the web dev server on this machine's tailnet over HTTPS (via `tailscale serve`) and print the pairing URL for it. Removed again on exit.",
    ),
    Flag.withDefault(false),
  ),
  seed: Flag.Boolean("seed").pipe(
    Flag.withDescription(
      "Seed an empty worktree database from ~/.goat (or ~/.t3) on first start (read-only, via migrate-dev-db) if the source is at most 500 MiB. On by default; --no-seed or GOAT_DEV_SEED=0 skips it.",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("GOAT_DEV_SEED")),
  ),
  built: Flag.Boolean("built").pipe(
    Flag.withDescription(
      "With --share: serve a production web build from the backend instead of the Vite dev server. Rebuilds on change, no HMR, much smaller remote loads.",
    ),
    Flag.withDefault(false),
  ),
  runArgs: Argument.String("run-arg").pipe(
    Argument.withDescription("Additional Vite+ run args (pass after `--`)."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Run monorepo development modes with deterministic port/env wiring."),
  Command.withHandler((input) => runDevRunnerWithInput(input)),
);

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

if (import.meta.main) {
  Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
