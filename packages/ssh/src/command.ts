import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { buildSshChildEnvironment, type SshAuthOptions } from "./auth.ts";
import { SshCommandError, SshInvalidTargetError } from "./errors.ts";

const DEFAULT_SSH_COMMAND_TIMEOUT_MS = 60_000;
const SSH_COMMAND_SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_SSH_ERROR_OUTPUT_LENGTH = 4_000;
const SSH_STDIN_CHUNK_BYTES = 1024 * 1024;
const MAX_SSH_DIAGNOSTIC_PREFIX_LENGTH = 512;

/**
 * ssh is a real executable everywhere (`ssh.exe` on Windows), so it is always
 * spawned directly — cmd.exe shell mode would re-tokenize arguments such as
 * identity-file paths containing spaces.
 */
const sshCommandForPlatform = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "ssh.exe" : "ssh";

export const resolveSshCommand = Effect.map(HostProcess.Platform, sshCommandForPlatform);

const encoder = new TextEncoder();

export const SshReconnectCost = Context.Reference<{
  active: boolean;
  spawns: number;
  authentications: number;
  mastersStarted?: number;
  controlCommands?: number;
  steps: Record<string, number>;
} | null>("@goat/ssh/command/SshReconnectCost", {
  defaultValue: () => null,
});

// Request-local observation; SSH diagnostics retain authority over the final target's login.
export const SshHostAnswered = Context.Reference<(() => void) | null>(
  "@goat/ssh/command/SshHostAnswered",
  { defaultValue: () => null },
);

export interface SshMasterConnection {
  readonly configuration: string;
  readonly socket: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
}

export const SshConnectionSharing = Context.Reference<{
  readonly configurations: Map<string, string>;
  readonly masters: Map<string, SshMasterConnection>;
} | null>("@goat/ssh/command/SshConnectionSharing", { defaultValue: () => null });

export function hasUserSshSharing(configuration: string): boolean {
  return configuration.split(/\r?\n/u).some((line) => {
    const [key, value] = line.trim().toLowerCase().split(/\s+/u);
    return (
      (key === "controlmaster" && value !== undefined && value !== "false" && value !== "no") ||
      (key === "controlpath" && value !== undefined && value !== "none")
    );
  });
}

export const healthySshMaster = (target: DesktopSshEnvironmentTarget) =>
  Effect.gen(function* () {
    const sharing = yield* SshConnectionSharing;
    if (hasUserSshSharing(sharing?.configurations.get(target.alias) ?? "")) return undefined;
    const master = sharing?.masters.get(targetConnectionKey(target));
    return master !== undefined &&
      master.configuration === sharing?.configurations.get(target.alias) &&
      (yield* master.process.isRunning.pipe(Effect.orElseSucceed(() => false)))
      ? master
      : undefined;
  });

export const measureSshReconnectStep = <A, E, R>(
  step: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const cost = yield* SshReconnectCost;
    if (cost === null || !cost.active) return yield* effect;
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(
      Effect.ensuring(
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            if (cost.active) cost.steps[step] = (cost.steps[step] ?? 0) + now - startedAt;
          }),
        ),
      ),
    );
  });

export interface SshCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunSshCommandOptions extends SshAuthOptions {
  readonly preHostArgs?: ReadonlyArray<string>;
  readonly remoteCommandArgs?: ReadonlyArray<string>;
  readonly stdin?: string | Uint8Array;
  readonly onStdinProgress?: (sentBytes: number) => void;
  readonly timeoutMs?: number;
  readonly timeoutStage?: "runtime-install" | "runtime-launch" | "pairing";
  /** Keep the end of long failed-command stdout, where the final cause usually is. */
  readonly keepErrorOutputTail?: boolean;
}

export function parseSshResolveOutput(alias: string, stdout: string): DesktopSshEnvironmentTarget {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const [key, ...rest] = trimmed.split(/\s+/u);
    if (!key || rest.length === 0 || values.has(key)) {
      continue;
    }
    values.set(key, rest.join(" ").trim());
  }

  const hostname = values.get("hostname")?.trim() || alias;
  const username = values.get("user")?.trim() || null;
  const rawPort = values.get("port")?.trim() ?? "";
  const parsedPort = Number.parseInt(rawPort, 10);

  return {
    alias,
    hostname,
    username,
    port: Number.isInteger(parsedPort) ? parsedPort : null,
  };
}

export function targetConnectionKey(target: DesktopSshEnvironmentTarget): string {
  return `${target.alias}\u0000${target.hostname}\u0000${target.username ?? ""}\u0000${target.port ?? ""}`;
}

/**
 * Names the remote launch state directory under `~/.goat/ssh-launch`. The server
 * it describes is host-wide (`~/.goat`), so every client uses the same directory
 * regardless of the alias, hostname, or port it dialled. A per-client key let
 * two clients keep conflicting ownership records for one server.
 */
export const REMOTE_RUNTIME_STATE_KEY = "runtime";

function buildSshHostSpec(target: DesktopSshEnvironmentTarget): string {
  const destination = target.alias.trim() || target.hostname.trim();
  if (destination.length === 0) {
    throw new Error("SSH target is missing its alias/hostname.");
  }
  return target.username ? `${target.username}@${destination}` : destination;
}

export const buildSshHostSpecEffect = (
  target: DesktopSshEnvironmentTarget,
): Effect.Effect<string, SshInvalidTargetError> =>
  Effect.try({
    try: () => buildSshHostSpec(target),
    catch: (cause) =>
      new SshInvalidTargetError({
        message: cause instanceof Error ? cause.message : "SSH target is invalid.",
      }),
  });

export function baseSshArgs(
  target: DesktopSshEnvironmentTarget,
  input?: { readonly batchMode?: "yes" | "no" },
): string[] {
  return [
    "-o",
    `BatchMode=${input?.batchMode ?? "no"}`,
    "-o",
    "ConnectTimeout=10",
    ...(target.port !== null ? ["-p", String(target.port)] : []),
  ];
}

/**
 * Liveness probes for every SSH session GOAT opens to a remote host. Without them a half-open
 * link (sleep, roaming, a dropped NAT entry) is only noticed when a command's own timeout
 * expires, up to 15 minutes for an archive install. Three missed 15 s probes end the session.
 * Git transfers use the same budget through GIT_SSH_COMMAND.
 */
export const SSH_KEEPALIVE_ARGS = [
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
] as const;

export function getLastNonEmptyOutputLine(stdout: string): string | null {
  return (
    stdout
      .trim()
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .findLast((entry) => entry.length > 0) ?? null
  );
}

const collectProcessOutput = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

// DEBUG1 is needed for auth milestones and proxy status banners; lower levels
// omit them. Unlike -v, LogLevel does not enable verbose logging in ProxyJump's
// child ssh. LogVerbose's source/function overrides are version-dependent.
export const SSH_DIAGNOSTIC_ARGS = ["-o", "LogLevel=DEBUG1"] as const;

const SSH_CHATTER_RE =
  /^(?:debug[123]:|Authenticated (?:to |using )|Transferred: sent |Bytes per second: sent |OpenSSH_\S+|Pseudo-terminal will not be allocated because stdin is not a terminal\.)/u;

// Preserve remote stderr's bytes, including a final fragment before a read
// failure. Buffer only short prefixes so a long line cannot grow without bound.
export const sshDiagnosticChunks = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  observeLine?: (line: string) => void,
): Stream.Stream<string, E> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const cost = yield* SshReconnectCost;
      let pending = "";
      let mode: "buffer" | "keep" | "drop" = "buffer";
      const diagnostic = (line: string) => {
        if (cost?.active && /^(?:debug1: )?Authenticated to /u.test(line)) cost.authentications++;
        observeLine?.(line.replace(/\r?\n$/u, ""));
        const text = line.replace(
          /^debug1: (?:kex_exchange_identification|ssh_exchange_identification): banner line \d+: (Tailscale is stopped\.|Logged out\.|Machine is not yet approved by tailnet admin\.)(\r?\n)?$/u,
          "Tailscale proxy status: $1$2",
        );
        return SSH_CHATTER_RE.test(text) ? "" : text;
      };
      const flush = () => {
        const text = diagnostic(pending);
        pending = "";
        return text;
      };
      return stream.pipe(
        Stream.decodeText(),
        Stream.flatMap((chunk) => {
          const output: string[] = [];
          let offset = 0;
          while (offset < chunk.length) {
            const end = chunk.indexOf("\n", offset);
            const part = chunk.slice(offset, end < 0 ? undefined : end + 1);
            if (mode === "keep") output.push(part);
            else if (mode === "buffer") {
              pending += part;
              if (end >= 0) output.push(flush());
              else if (pending.length > MAX_SSH_DIAGNOSTIC_PREFIX_LENGTH) {
                const text = flush();
                output.push(text);
                mode = text.length > 0 ? "keep" : "drop";
              }
            }
            if (end < 0) break;
            mode = "buffer";
            offset = end + 1;
          }
          return Stream.fromIterable(output);
        }),
        Stream.catchCause((cause) =>
          Stream.concat(
            Stream.suspend(() => Stream.make(flush())),
            Stream.failCause(cause),
          ),
        ),
        Stream.concat(Stream.suspend(() => Stream.make(flush()))),
        Stream.filter((chunk) => chunk.length > 0),
      );
    }),
  );

function redactSshErrorOutput(output: string, keepTail = false): string {
  const redacted = output.replace(
    /("(?:access_token|bearerToken|credential|pairingToken|token)"\s*:\s*")[^"]+(")/giu,
    "$1[redacted]$2",
  );
  if (redacted.length <= MAX_SSH_ERROR_OUTPUT_LENGTH) return redacted;
  return keepTail
    ? `[truncated]\n${redacted.slice(-MAX_SSH_ERROR_OUTPUT_LENGTH)}`
    : `${redacted.slice(0, MAX_SSH_ERROR_OUTPUT_LENGTH)}\n[truncated]`;
}

function normalizeSshErrorMessage(input: {
  readonly stdout?: string;
  readonly stderr: string;
  readonly fallbackMessage: string;
}): string {
  const cleanedStderr = input.stderr.trim();
  if (cleanedStderr.length > 0) {
    return cleanedStderr;
  }

  const cleanedStdout = input.stdout?.trim() ?? "";
  return cleanedStdout.length > 0 ? cleanedStdout : input.fallbackMessage;
}

/** Names a target the way a user configured it, with the address ssh dials when that differs. */
function describeSshTarget(target: DesktopSshEnvironmentTarget): string {
  const alias = target.alias.trim() || target.hostname.trim();
  const hostname = target.hostname.trim();
  const address = target.port === null ? hostname : `${hostname}:${target.port}`;
  return address === "" || address === alias ? alias : `${alias} (${address})`;
}

const UNREACHABLE_HINT = "Check the network or VPN connection to that host.";

/**
 * ssh exits 255 for its own failures. When the connection itself failed, the message leads
 * with the host and the address ssh dialed, so it reads as a network problem instead of a
 * failure of whatever the remote command was meant to do.
 */
function describeSshConnectionFailure(
  target: DesktopSshEnvironmentTarget,
  stderr: string,
): string | undefined {
  const alias = target.alias.trim() || target.hostname.trim();
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toReversed();
  for (const line of lines) {
    const connect = /^ssh: connect to host (\S+) port (\d+): (.+)$/.exec(line);
    if (connect !== null) {
      return `Cannot reach ${alias} over SSH (${connect[1]}:${connect[2]}: ${connect[3]}). ${UNREACHABLE_HINT}`;
    }
    const resolve = /^ssh: Could not resolve hostname (\S+): (.+)$/.exec(line);
    if (resolve !== null) {
      return `Cannot reach ${alias} over SSH (could not resolve ${resolve[1]}: ${resolve[2]}). ${UNREACHABLE_HINT}`;
    }
    if (
      line.startsWith("Connection timed out during banner exchange") ||
      /^Connection to \S+ port \d+ timed out/.test(line)
    ) {
      return `Cannot reach ${alias} over SSH (${line}). ${UNREACHABLE_HINT}`;
    }
  }
  return undefined;
}

function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

function stdinStream(
  input: string | Uint8Array | undefined,
  onProgress?: (sentBytes: number) => void,
) {
  if (input === undefined) return Stream.empty;
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  return Stream.unfold(0, (offset) =>
    Effect.sync(() => {
      // The stdin sink pulls again only after writing the preceding chunk and draining it.
      if (offset > 0) {
        try {
          onProgress?.(offset);
        } catch {
          // A disposed progress observer must not interrupt an upload.
        }
      }
      if (offset === bytes.byteLength) return undefined;
      const end = Math.min(offset + SSH_STDIN_CHUNK_BYTES, bytes.byteLength);
      return [bytes.subarray(offset, end), end] as const;
    }),
  );
}

const runSshCommandInScope = Effect.fn("ssh/command.runSshCommand.inScope")(function* (
  target: DesktopSshEnvironmentTarget,
  input: RunSshCommandOptions,
  commandScope: Scope.Scope,
  progress: {
    authenticating: boolean;
    authenticated: boolean;
    proxyPending: boolean;
    stderr: string;
  },
): Effect.fn.Return<
  SshCommandResult,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const hostSpec = yield* buildSshHostSpecEffect(target);
  const environment = yield* buildSshChildEnvironment({
    ...(input.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    ...(input.authSecret === undefined ? {} : { authSecret: input.authSecret }),
  }).pipe(
    Effect.provideService(Scope.Scope, commandScope),
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  const master = input.preHostArgs?.some((arg) => arg === "-G" || arg === "-O")
    ? undefined
    : yield* healthySshMaster(target);
  const args = [
    ...SSH_DIAGNOSTIC_ARGS,
    ...baseSshArgs(target, {
      batchMode: input.batchMode ?? (input.interactiveAuth ? "no" : "yes"),
    }),
    ...(input.preHostArgs?.includes("-O") ? [] : SSH_KEEPALIVE_ARGS),
    ...(master === undefined ? [] : ["-S", master.socket, "-o", "ControlMaster=no"]),
    ...(input.preHostArgs ?? []),
    "--",
    hostSpec,
    ...(input.remoteCommandArgs ?? []),
  ];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sshCommand = yield* resolveSshCommand;
  yield* Effect.logDebug("ssh.command.start", {
    ...sshTargetLogFields(target),
    command: [sshCommand, ...args],
    hasStdin: input.stdin !== undefined,
    timeoutMs: input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(sshCommand, args, {
        // Scope interruption must reap ssh even if it or an auth helper ignores SIGTERM.
        forceKillAfter: SSH_COMMAND_SHUTDOWN_TIMEOUT_MS,
        env: environment,
        extendEnv: true,
        stdin: {
          stream: stdinStream(input.stdin, input.onStdinProgress),
          endOnDone: true,
        },
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, commandScope),
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: [sshCommand, ...args],
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH command for ${hostSpec}.`,
            cause,
          }),
      ),
    );

  const onHostAnswered = yield* SshHostAnswered;
  let reportedAnswer = false;
  const cost = yield* SshReconnectCost;
  if (cost?.active) {
    cost.spawns++;
    if (input.preHostArgs?.includes("-O")) cost.controlCommands = (cost.controlCommands ?? 0) + 1;
  }
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectProcessOutput(child.stdout),
      sshDiagnosticChunks(child.stderr, (line) => {
        // A VERBOSE jump can report success without DEBUG1 forwarding details.
        // Ignore its auth milestones until the final target starts its own login.
        if (
          /^debug1: (?:Setting implicit ProxyCommand from ProxyJump:|Executing proxy command:|channel_connect_stdio_fwd:)/u.test(
            line,
          )
        ) {
          progress.proxyPending = true;
          progress.authenticating = false;
          progress.authenticated = false;
        }
        if (line.startsWith("debug1: Authenticating to ")) {
          progress.proxyPending = false;
          progress.authenticating = false;
          progress.authenticated = false;
        }
        if (!progress.proxyPending) {
          progress.authenticating ||=
            /^debug1: (?:SSH2_MSG_SERVICE_ACCEPT received|Authentications that can continue:|Next authentication method:)/u.test(
              line,
            );
          progress.authenticated ||=
            /^(?:Authenticated to |debug1: Authentication succeeded|debug1: mux_client_request_session: master session id:)/u.test(
              line,
            );
        }
        const finalHostAnswered =
          line.startsWith(`Authenticated to ${target.hostname} `) ||
          line.startsWith(`Authenticated to ${target.alias} `) ||
          line.startsWith("debug1: mux_client_request_session: master session id:");
        if (progress.authenticated && finalHostAnswered && !reportedAnswer) {
          reportedAnswer = true;
          try {
            onHostAnswered?.();
          } catch {
            // A renderer that went away must not cancel the shared preparation.
          }
        }
      }).pipe(
        Stream.runForEach((line) =>
          Effect.sync(() => {
            progress.stderr += line;
          }),
        ),
        Effect.map(() => progress.stderr),
      ),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh", ...args],
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error ? cause.message : `Failed to run SSH command for ${hostSpec}.`,
          cause,
        }),
    ),
  );

  if (exitCode !== 0) {
    const diagnosticStdout = redactSshErrorOutput(stdout, input.keepErrorOutputTail);
    yield* Effect.logWarning("ssh.command.failed", {
      ...sshTargetLogFields(target),
      command: ["ssh", ...args],
      exitCode,
      stdout: diagnosticStdout,
      stderr,
    });
    return yield* new SshCommandError({
      command: ["ssh", ...args],
      exitCode,
      stdout: diagnosticStdout,
      stderr,
      message:
        (exitCode === 255 ? describeSshConnectionFailure(target, stderr) : undefined) ??
        normalizeSshErrorMessage({
          stdout: diagnosticStdout,
          stderr,
          fallbackMessage: `SSH command failed for ${hostSpec} (exit ${exitCode}).`,
        }),
    });
  }

  yield* Effect.logDebug("ssh.command.succeeded", {
    ...sshTargetLogFields(target),
    command: ["ssh", ...args],
  });
  return { stdout, stderr };
});

export const runSshCommand = Effect.fn("ssh/command.runSshCommand")(function* (
  target: DesktopSshEnvironmentTarget,
  input: RunSshCommandOptions = {},
): Effect.fn.Return<
  SshCommandResult,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const progress = { authenticating: false, authenticated: false, proxyPending: false, stderr: "" };
  return yield* Effect.scopedWith((commandScope) =>
    runSshCommandInScope(target, input, commandScope, progress),
  ).pipe(
    Effect.timeoutOption(Duration.millis(input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS)),
    Effect.flatMap((result) =>
      Option.match(result, {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.gen(function* () {
            yield* Effect.logWarning("ssh.command.timedOut", {
              ...sshTargetLogFields(target),
              timeoutMs: input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS,
              remoteCommandArgs: input.remoteCommandArgs ?? [],
              preHostArgs: input.preHostArgs ?? [],
              hasStdin: input.stdin !== undefined,
            });
            const host = describeSshTarget(target);
            const elapsed = `${input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS}ms`;
            const operation =
              input.timeoutStage === "runtime-install"
                ? "GOAT runtime install/download"
                : input.timeoutStage === "runtime-launch"
                  ? "GOAT runtime launch"
                  : input.timeoutStage === "pairing"
                    ? "GOAT pairing"
                    : "Remote SSH command";
            const message = progress.authenticated
              ? `${operation} on ${host} timed out after ${elapsed}.`
              : progress.authenticating
                ? `SSH authentication timed out for ${host} after ${elapsed}. Unlock your SSH key or ssh-agent, then reconnect.`
                : `SSH connection to ${host} timed out after ${elapsed} before authentication began. Check the network or SSH ProxyCommand.`;
            return yield* new SshCommandError({
              command: ["ssh"],
              exitCode: null,
              stderr: progress.stderr,
              message: progress.stderr.trim() ? `${message}\n${progress.stderr.trim()}` : message,
            });
          }),
      }),
    ),
    (effect) =>
      measureSshReconnectStep(
        input.timeoutStage ??
          (input.preHostArgs?.includes("-G") === true
            ? "ssh/command.resolveSshTarget"
            : "ssh/command.runSshCommand"),
        effect,
      ),
  );
});

export const resolveSshTarget = Effect.fn("ssh/command.resolveSshTarget")(function* (
  alias: string,
  overrides?: Pick<DesktopSshEnvironmentTarget, "username" | "port">,
): Effect.fn.Return<
  DesktopSshEnvironmentTarget,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const trimmedAlias = alias.trim();
  if (trimmedAlias.length === 0) {
    return yield* new SshInvalidTargetError({ message: "SSH host alias is required." });
  }

  yield* Effect.logDebug("ssh.target.resolve.start", { alias: trimmedAlias });
  return yield* runSshCommand(
    {
      alias: trimmedAlias,
      hostname: trimmedAlias,
      username: overrides?.username ?? null,
      port: overrides?.port ?? null,
    },
    { preHostArgs: ["-G"] },
  ).pipe(
    Effect.tap((result) =>
      Effect.gen(function* () {
        const sharing = yield* SshConnectionSharing;
        sharing?.configurations.set(trimmedAlias, result.stdout);
      }),
    ),
    Effect.map((result) => parseSshResolveOutput(trimmedAlias, result.stdout)),
    Effect.tap((target) =>
      Effect.logDebug("ssh.target.resolve.succeeded", sshTargetLogFields(target)),
    ),
    Effect.catch((cause) =>
      Effect.logDebug("ssh.target.resolve.fallback", { alias: trimmedAlias, cause }).pipe(
        Effect.as({
          alias: trimmedAlias,
          hostname: trimmedAlias,
          username: null,
          port: null,
        }),
      ),
    ),
  );
});
