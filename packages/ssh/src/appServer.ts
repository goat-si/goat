import {
  AuthGrantScope,
  type DesktopSshEnvironmentTarget,
  GOAT_RUNTIME_CONTROL_HEADER,
  GOAT_RUNTIME_SESSION_PATH,
  ORCHESTRATION_PROTOCOL_VERSION,
  RuntimeMode,
  type RuntimeSessionRequest,
} from "@goat/contracts";
import { GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import { fromLenientJson } from "@goat/shared/schemaJson";
import { compareRuntimeProtocols, ownRuntimeProtocolRanges } from "@goat/shared/sshRuntimeProtocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type * as SshAuth from "./auth.ts";
import { runSshCommand } from "./command.ts";
import { SshCommandError, SshInvalidTargetError, SshPairingError } from "./errors.ts";
import { applyScriptPlaceholders, shellSingleQuote, sshTargetLogFields } from "./remoteRuntime.ts";

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
[ -f "$app_record" ] && [ ! -L "$app_record" ] || app_none none
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
  if (index < 0) return { kind: "none" };
  const [status, , port] = lines[index]!.slice("GOAT_APP_SERVER=".length).split(" ");
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
 * Whether the host's GOAT app server can serve this client. Fails open to `none` when the
 * check itself cannot run, so a host keeps working through the managed server.
 */
export const probeAppServer = Effect.fn("ssh/appServer.probe")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuth.SshAuthOptions,
): Effect.fn.Return<AppServerProbe, never, AppServerContext> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: applyScriptPlaceholders(APP_SERVER_PROBE_SCRIPT, {
      GOAT_ENVIRONMENT_PATH: GOAT_ENVIRONMENT_PATH,
    }),
    timeoutMs: 20_000,
    ...sshOptions(input),
  }).pipe(Effect.option);
  const probe = Option.match(result, {
    onNone: (): AppServerProbe => ({ kind: "none" }),
    onSome: (output) => parseAppServerProbe(output.stdout),
  });
  if (probe.kind !== "none")
    yield* Effect.logInfo("ssh.appServer.probed", {
      ...sshTargetLogFields(target),
      ...probe,
    });
  return probe;
});

/** The script that asks the app server on `port` for a credential. Exported for tests. */
export const buildAppServerCredentialScript = (port: number, request: RuntimeSessionRequest) =>
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
    remoteCommandArgs: ["sh", "-s"],
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
