import {
  AuthGrantScope,
  type DesktopSshEnvironmentTarget,
  GOAT_RUNTIME_CONTROL_HEADER,
  GOAT_RUNTIME_SESSION_PATH,
  ORCHESTRATION_PROTOCOL_VERSION,
  RuntimeMode,
  type RuntimeSessionRequest,
  type SshHostResult,
} from "@goat/contracts";
import { GOAT_ACTIVITY_PATH, GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import { fromLenientJson } from "@goat/shared/schemaJson";
import { compareRuntimeProtocols, ownRuntimeProtocolRanges } from "@goat/shared/sshRuntimeProtocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type * as SshAuth from "./auth.ts";
import { runSshCommand } from "./command.ts";
import { SshCommandError, SshInvalidTargetError, SshPairingError } from "./errors.ts";
import {
  applyScriptPlaceholders,
  type PreparedRemoteRuntime,
  type RemoteGoatRunnerOptions,
  requestedRuntime,
  shellSingleQuote,
  sshTargetLogFields,
} from "./remoteRuntime.ts";

// The packaged GOAT app runs its own server on ~/.goat/desktop (resolveDesktopBaseDir), beside the
// server SSH clients start on ~/.goat. A host user should have one server their remote hubs reach,
// and the app's holds the person's own threads, so an SSH client attaches to it whenever it runs
// and can be attached. Only otherwise does it start or reuse the managed server. Windows hosts are
// skipped: these POSIX scripts cannot reach the app there.
const APP_SERVER_PREAMBLE = String.raw`set -eu
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) printf 'GOAT_APP_SERVER=none\n'; exit 0 ;; esac
app_userdata="$HOME/.goat/desktop/userdata"
app_record="$app_userdata/server-runtime.json"
app_token="$app_userdata/runtime-control.token"
app_none() { printf 'GOAT_APP_SERVER=%s\n' "$1"; exit 0; }
[ -f "$app_record" ] || app_none none
[ ! -L "$app_record" ] || app_none symlink
app_line="$(tr '\n' ' ' <"$app_record")"
app_pid="$(printf '%s\n' "$app_line" | sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
app_port="$(printf '%s\n' "$app_line" | sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
case "$app_pid:$app_port" in *[!0-9:]* | :* | *:) app_none none ;; esac
[ "$app_pid" -gt 0 ] && [ "$app_port" -ge 1 ] && [ "$app_port" -le 65535 ] || app_none none
kill -0 "$app_pid" 2>/dev/null || app_none none
command -v curl >/dev/null 2>&1 || app_none no-curl
[ -f "$app_token" ] && [ ! -L "$app_token" ] && [ -s "$app_token" ] || app_none no-token
`;

const APP_SERVER_PROBE_SCRIPT = String.raw`${APP_SERVER_PREAMBLE}app_descriptor="$(curl -fsS --max-time 5 "http://127.0.0.1:$app_port@@GOAT_ENVIRONMENT_PATH@@" 2>/dev/null | tr '\n' ' ')" || app_none unreachable
printf 'GOAT_APP_SERVER=live %s %s\n%s\n' "$app_pid" "$app_port" "$app_descriptor"
`;

// The token reaches curl through its config on stdin, never argv. The record must still name the
// port the probe saw, so a credential request never goes to whatever replaced that server.
const APP_SERVER_SESSION_SCRIPT = String.raw`${APP_SERVER_PREAMBLE}[ "$app_port" = @@GOAT_PORT@@ ] || { printf 'The GOAT app server on this host restarted; reconnect.\n' >&2; exit 1; }
app_secret="$(tr -d '\r\n' <"$app_token")"
printf 'header = "@@GOAT_HEADER@@: %s"\n' "$app_secret" |
  curl -sS --max-time 20 -K - -H 'content-type: application/json' --data-binary @@GOAT_BODY@@ \
    -w '\nGOAT_HTTP_STATUS=%{http_code}\n' "http://127.0.0.1:$app_port@@GOAT_SESSION_PATH@@"
`;

const AppServerDescriptor = Schema.Struct({
  serverVersion: Schema.String,
  sshRuntimeProtocolVersion: Schema.optionalKey(Schema.Number),
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Number),
  protocol: Schema.optionalKey(
    Schema.Struct({
      ssh: Schema.Struct({ min: Schema.Number, max: Schema.Number }),
      orchestration: Schema.Struct({ min: Schema.Number, max: Schema.Number }),
    }),
  ),
  capabilities: Schema.Struct({ runtimeSessions: Schema.optionalKey(Schema.Boolean) }),
});
const decodeAppServerDescriptor = Schema.decodeUnknownOption(fromLenientJson(AppServerDescriptor));

/** Names the probe's SSH command, so traces can tell it from other scripts. */
const APP_SERVER_PROBE_COMMAND = "goat-app-server-probe";

const CLIENT_PROTOCOL_RANGES = ownRuntimeProtocolRanges(ORCHESTRATION_PROTOCOL_VERSION);
const isGrantScope = Schema.is(AuthGrantScope);
const isRuntimeMode = Schema.is(RuntimeMode);

/**
 * `attach`: use the app's server. `declined`: it runs but cannot be attached (too old to issue
 * sessions, an incompatible protocol, unreachable on loopback, no curl), so the managed server
 * serves this client. `none`: no app server runs here.
 */
export type AppServerProbe =
  | { readonly kind: "attach"; readonly port: number; readonly version: string }
  | { readonly kind: "declined"; readonly reason: string }
  | { readonly kind: "none" };

/** Reads the probe script's answer. Exported for tests. */
export const parseAppServerProbe = (stdout: string): AppServerProbe => {
  const lines = stdout.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.startsWith("GOAT_APP_SERVER="));
  const marker = lines[index];
  if (marker === undefined) return { kind: "none" };
  const [status, , port] = marker.slice("GOAT_APP_SERVER=".length).split(" ");
  if (status === "none") return { kind: "none" };
  if (status !== "live") return { kind: "declined", reason: status ?? "unknown" };
  const remotePort = Number(port);
  const descriptor = decodeAppServerDescriptor(lines[index + 1] ?? "");
  if (
    !Number.isInteger(remotePort) ||
    remotePort < 1 ||
    remotePort > 65535 ||
    Option.isNone(descriptor)
  )
    return { kind: "declined", reason: "unreadable" };
  if (descriptor.value.capabilities.runtimeSessions !== true)
    return { kind: "declined", reason: "no-runtime-sessions" };
  const verdict = compareRuntimeProtocols(CLIENT_PROTOCOL_RANGES, descriptor.value);
  if (verdict !== "compatible") return { kind: "declined", reason: verdict };
  return { kind: "attach", port: remotePort, version: descriptor.value.serverVersion };
};

type AppServerContext = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

const sshOptions = (input: SshAuth.SshAuthOptions | undefined) => ({
  ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
  ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
  ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
});

/**
 * Whether the host's GOAT app server can serve this client. A check that cannot run answers
 * `declined`, so the host keeps working through the managed server and stays there.
 */
export const probeAppServer = Effect.fn("ssh/appServer.probe")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuth.SshAuthOptions,
): Effect.fn.Return<AppServerProbe, never, AppServerContext> {
  const result = yield* runSshCommand(target, {
    // The trailing word is only $1 to the script; it names this call in traces and tests.
    remoteCommandArgs: ["sh", "-s", APP_SERVER_PROBE_COMMAND],
    stdin: applyScriptPlaceholders(APP_SERVER_PROBE_SCRIPT, {
      GOAT_ENVIRONMENT_PATH: GOAT_ENVIRONMENT_PATH,
    }),
    timeoutMs: 20_000,
    ...sshOptions(input),
  }).pipe(Effect.option);
  const probe = Option.match(result, {
    // Unknown is not absent: the managed server may still report the app, so stay put.
    onNone: (): AppServerProbe => ({ kind: "declined", reason: "probe-failed" }),
    onSome: (output) => parseAppServerProbe(output.stdout),
  });
  if (probe.kind !== "none")
    yield* Effect.logInfo("ssh.appServer.probed", {
      ...sshTargetLogFields(target),
      ...probe,
    });
  return probe;
});

/** The script that asks the app server on `port` for a credential. */
const buildAppServerCredentialScript = (port: number, request: RuntimeSessionRequest) =>
  applyScriptPlaceholders(APP_SERVER_SESSION_SCRIPT, {
    GOAT_PORT: String(port),
    GOAT_HEADER: GOAT_RUNTIME_CONTROL_HEADER,
    GOAT_BODY: shellSingleQuote(JSON.stringify(request)),
    GOAT_SESSION_PATH: GOAT_RUNTIME_SESSION_PATH,
  });

/**
 * Issues a credential from the app server attached on `port` and returns the JSON body, the
 * same output `goat auth ... --json` prints, so the callers' existing decoders read it.
 */
export const issueAppServerCredential = Effect.fn("ssh/appServer.issueCredential")(function* (
  target: DesktopSshEnvironmentTarget,
  port: number,
  request: RuntimeSessionRequest,
  input?: SshAuth.SshAuthOptions,
): Effect.fn.Return<
  string,
  SshCommandError | SshInvalidTargetError | SshPairingError,
  AppServerContext
> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s", "goat-app-server-credential"],
    timeoutStage: "pairing",
    stdin: buildAppServerCredentialScript(port, request),
    ...sshOptions(input),
  });
  const marker = /^GOAT_HTTP_STATUS=(\d{3})$/mu.exec(result.stdout);
  const body = marker === null ? result.stdout : result.stdout.slice(0, marker.index).trim();
  if (marker?.[1] !== "200")
    return yield* new SshPairingError({
      message: `The GOAT app server on ${target.alias} did not issue a credential (HTTP ${marker?.[1] ?? "no answer"}).`,
      stdout: body,
    });
  yield* Effect.logInfo("ssh.appServer.credential.issued", {
    ...sshTargetLogFields(target),
    kind: request.kind,
  });
  return body;
});

/**
 * The session request matching what a remote session script would pass to `goat auth`, or none
 * when the CLI would refuse it too (a scope it cannot grant, an unknown runtime mode).
 */
export const appServerSessionRequest = (input: {
  readonly subject: string;
  readonly scopes: ReadonlyArray<string>;
  readonly ttl: string;
  readonly label: string;
  readonly runtimeModeCeiling?: string | null;
}): Option.Option<RuntimeSessionRequest> => {
  const [first, ...rest] = input.scopes;
  if (first === undefined || !isGrantScope(first) || !rest.every(isGrantScope))
    return Option.none();
  const ceiling = input.runtimeModeCeiling ?? undefined;
  if (ceiling !== undefined && !isRuntimeMode(ceiling)) return Option.none();
  return Option.some({
    kind: "session",
    subject: input.subject,
    scopes: [first, ...rest],
    ttl: input.ttl,
    label: input.label,
    ...(ceiling === undefined ? {} : { runtimeModeCeiling: ceiling }),
  });
};

const decodeActivity = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ activity: Schema.Literals(["idle", "busy"]) })),
);

/**
 * Whether an attachment to the managed server should move to the host's GOAT app server, which
 * the managed server reports as `appServerLive` in its descriptor. Only an idle managed server is
 * left, so threads already running there finish where they started and their watchers can still
 * read them. An attachment whose launch found the app server unusable stays, and so does one that
 * cannot learn the managed server's activity.
 */
export const shouldMoveToAppServer = Effect.fn("ssh/appServer.shouldMove")(function* (input: {
  readonly descriptor: { readonly appServerLive?: boolean } | undefined;
  readonly remoteServerKind: "app" | "external" | "managed" | null;
  readonly selection: Pick<PreparedRemoteRuntime, "appServerDeclined">;
  readonly httpBaseUrl: string;
  readonly timeoutMs: number;
}) {
  if (
    input.descriptor?.appServerLive !== true ||
    input.remoteServerKind === "app" ||
    input.selection.appServerDeclined === true
  )
    return false;
  const client = yield* HttpClient.HttpClient;
  return yield* client.get(new URL(GOAT_ACTIVITY_PATH, input.httpBaseUrl).toString()).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.text.pipe(
            Effect.flatMap(decodeActivity),
            Effect.map((answer) => answer.activity === "idle"),
          )
        : Effect.succeed(false),
    ),
    Effect.timeoutOption(`${input.timeoutMs} millis`),
    Effect.map((idle) => Option.isSome(idle) && idle.value),
    Effect.orElseSucceed(() => false),
  );
});

const decodeForwardDescriptor = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      serverVersion: Schema.optionalKey(Schema.String),
      appServerLive: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);

/**
 * What the server behind an open forward reports now. A server replaced on the same port
 * (another client's update, a self-update, a manual restart) still answers the forward, so
 * readiness alone would keep reporting the version this client attached to. `appServerLive`
 * is the managed server saying the host's GOAT app server runs beside it.
 */
export const readForwardDescriptor = Effect.fn("ssh/appServer.readForwardDescriptor")(function* (
  httpBaseUrl: string,
  timeoutMs: number,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.get(new URL(GOAT_ENVIRONMENT_PATH, httpBaseUrl).toString()).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.text.pipe(Effect.flatMap(decodeForwardDescriptor))
        : Effect.succeed(undefined),
    ),
    Effect.timeoutOption(`${timeoutMs} millis`),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
});

/** The launch result for an attachable app server; nothing on the host is started or written. */
export const appServerLaunch = Effect.fn("ssh/appServer.launch")(function* (
  target: DesktopSshEnvironmentTarget,
  app: Extract<AppServerProbe, { readonly kind: "attach" }>,
  runner: RemoteGoatRunnerOptions | undefined,
) {
  yield* Effect.logInfo("ssh.remoteServer.launch.ready", {
    ...sshTargetLogFields(target),
    remotePort: app.port,
    remoteServerKind: "app",
    selectedVersion: app.version,
    requestedVersion: runner?.archiveVersion?.trim() ?? null,
  });
  return {
    status: "ready" as const,
    remotePort: app.port,
    remoteServerKind: "app" as const,
    selectedRuntime: {
      ...requestedRuntime(runner),
      version: app.version,
      source: "app" as const,
      appServerPort: app.port,
      mayUpgradeOwnedServer: false,
    },
  };
});

/** Host status for an app attachment on `port`, or none when that app server no longer serves it. */
export const appServerStatus = Effect.fn("ssh/appServer.status")(function* (
  target: DesktopSshEnvironmentTarget,
  port: number,
  requestedVersion: string,
  observed: SshHostResult | undefined,
) {
  const app = yield* probeAppServer(target, { batchMode: "yes", interactiveAuth: false });
  if (app.kind !== "attach" || app.port !== port) return undefined;
  const providers = observed?.status?.providers;
  return {
    kind: "ok",
    status: {
      host: target.alias || target.hostname,
      requestedVersion,
      runtimeVersion: app.version,
      state: providers?.ready === false ? "providers_not_ready" : "ready",
      ...(providers === undefined ? {} : { providers }),
    },
  } satisfies SshHostResult;
});

/**
 * Prints the GOAT environment id of the server SSH clients use on this host, starting nothing.
 * `attached` is the kind of server a connection to it already uses. With none, the app server's
 * id is printed only while it could be attached (live, holding its control token, advertising
 * `runtimeSessions`), else the managed home's.
 */
export const hostEnvironmentIdScript = (attached: "app" | "external" | "managed" | null) =>
  `attached=${attached ?? "none"}` +
  String.raw`
home="$HOME/.goat/userdata"; app="$HOME/.goat/desktop/userdata"
case "$attached" in
  app) home="$app" ;;
  none)
    rec="$(tr '\n' ' ' <"$app/server-runtime.json" 2>/dev/null || true)"
    pid="$(printf '%s\n' "$rec" | sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
    port="$(printf '%s\n' "$rec" | sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
    if [ -n "$pid" ] && [ -n "$port" ] && kill -0 "$pid" 2>/dev/null && [ -s "$app/runtime-control.token" ] &&
      command -v curl >/dev/null 2>&1 &&
      curl -fsS --max-time 5 "http://127.0.0.1:$port${GOAT_ENVIRONMENT_PATH}" 2>/dev/null | grep -q '"runtimeSessions":true'; then
      home="$app"
    fi ;;
esac
if [ -f "$home/environment-id" ]; then cat "$home/environment-id"; fi
`;
