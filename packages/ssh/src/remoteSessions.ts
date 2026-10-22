import type { AuthEnvironmentScope, DesktopSshEnvironmentTarget } from "@goat/contracts";
import { AuthEnvironmentScopes } from "@goat/contracts";
import { fromLenientJson } from "@goat/shared/schemaJson";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import {
  applyScriptPlaceholders,
  decodeRemoteJsonOutput,
  isNodeScriptRunner,
  REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
  requestedRuntime,
  shellSingleQuote,
  sshTargetLogFields,
  type PreparedRemoteRuntime,
  type RemoteGoatRunnerOptions,
} from "./remoteRuntime.ts";
import { REMOTE_RUNTIME_STATE_KEY, runSshCommand } from "./command.ts";
import {
  SshCommandError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
} from "./errors.ts";
import type { makeRuntimeProvisioning } from "./runtimeProvisioning.ts";

export interface RemoteMcpClientSessionOptions {
  readonly requireReady?: boolean;
  readonly label: string;
  /** A duration the remote CLI accepts, such as `12h`. */
  readonly ttl: string;
  /** Most a thread started through this session may run with; null keeps the remote default. */
  readonly runtimeModeCeiling: string | null;
  /** Also grant `orchestration:approve`. A remote CLI that predates it fails the issue. */
  readonly approvals?: boolean;
  /** Also grant `providers:manage`, only for a caller that holds it live on this machine. */
  readonly providersManage?: boolean;
  /** Also grant `settings:write`, for this machine's own fleet settings sync. */
  readonly settingsWrite?: boolean;
  /** Explicit task memory grants; an older CLI must refuse rather than omit them. */
  readonly memoryScopes?: ReadonlyArray<"memory:read" | "memory:write">;
}

export interface RemoteMcpClientSession {
  readonly token: string;
  readonly expiresAt: string | null;
  /** False when the remote CLI predates `--runtime-mode-ceiling` and kept its default. */
  readonly runtimeModeCeilingApplied: boolean;
}

export interface RemoteClientSessionOptions {
  readonly subject: string;
  readonly label: string;
  readonly ttl: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

export interface RemoteClientSession {
  readonly token: string;
  readonly expiresAt: string | null;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

const RemoteMcpSessionResult = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const RemoteClientSessionResult = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.optional(Schema.NullOr(Schema.String)),
  scopes: AuthEnvironmentScopes,
});

const decodeRemoteMcpSessionResult = Schema.decodeEffect(fromLenientJson(RemoteMcpSessionResult));

const decodeRemoteClientSessionResult = Schema.decodeEffect(
  fromLenientJson(RemoteClientSessionResult),
);

// Issues an `mcp-client` bearer session, the only kind the remote's `/mcp`
// admits from outside a thread. `--runtime-mode-ceiling` is newer than some
// remotes, so an older CLI is retried without it and reports the default.
// Memory grants are explicit consent, so they are never dropped: a CLI that cannot issue
// them refuses with a GOAT_SESSION_ERROR line, and every CLI that can also applies a ceiling.
const REMOTE_MCP_SESSION_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
DEFAULT_SERVER_HOME="$HOME/.goat"
@@GOAT_RUNNER_SETUP@@
set -- auth session issue --base-dir "$DEFAULT_SERVER_HOME" --subject mcp-client --scope orchestration:read --scope orchestration:operate @@GOAT_EXTRA_SCOPES@@--ttl @@GOAT_TTL@@ --label @@GOAT_LABEL@@ --json
CEILING=@@GOAT_CEILING@@
MEMORY_SCOPES=@@GOAT_MEMORY_SCOPES@@
recheck_selected_before_use
if [ "$MEMORY_SCOPES" = required ]; then
  if lacks_memory_scopes "$RUNNER_FILE"; then
    runtime="$("$RUNNER_FILE" --version 2>/dev/null || true)"; runtime="\${runtime#goat v}"
    printf 'GOAT_SESSION_ERROR=memory_scopes_unsupported runtime=%s\\n' "\${runtime:-unknown}"
    printf 'GOAT %s on this host cannot grant memory access to tasks.\\n' "\${runtime:-unknown}" >&2
    exit 1
  fi
  CEILING_RESULT=default
  if [ -n "$CEILING" ]; then set -- "$@" --runtime-mode-ceiling "$CEILING"; CEILING_RESULT=applied; fi
  OUTPUT="$("$RUNNER_FILE" "$@")"
  printf 'GOAT_CEILING=%s\\n%s\\n' "$CEILING_RESULT" "$OUTPUT"
elif [ -n "$CEILING" ] && OUTPUT="$("$RUNNER_FILE" "$@" --runtime-mode-ceiling "$CEILING" 2>/dev/null)"; then
  printf 'GOAT_CEILING=applied\\n%s\\n' "$OUTPUT"
else
  recheck_selected_before_use
  OUTPUT="$("$RUNNER_FILE" "$@")"
  printf 'GOAT_CEILING=default\\n%s\\n' "$OUTPUT"
fi
`;

const REMOTE_CLIENT_SESSION_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
DEFAULT_SERVER_HOME="$HOME/.goat"
@@GOAT_RUNNER_SETUP@@
recheck_selected_before_use
"$RUNNER_FILE" auth session issue --base-dir "$DEFAULT_SERVER_HOME" --subject @@GOAT_SUBJECT@@ @@GOAT_SCOPES@@ --ttl @@GOAT_TTL@@ --label @@GOAT_LABEL@@ --json
`;

export const decodeRemoteClientSessionOutput = Effect.fn(
  "ssh/tunnel.decodeRemoteClientSessionOutput",
)(function* (stdout: string, requestedScopes: ReadonlyArray<AuthEnvironmentScope>) {
  const session = yield* decodeRemoteJsonOutput(stdout, decodeRemoteClientSessionResult).pipe(
    Effect.mapError(
      (cause) =>
        new SshPairingError({
          message: "The remote GOAT CLI did not return a client session with explicit scopes.",
          stdout,
          cause,
        }),
    ),
  );
  if (session.token.trim().length === 0) {
    return yield* new SshPairingError({
      message: "The remote GOAT CLI returned an empty client session token.",
      stdout,
    });
  }
  const requested = new Set(requestedScopes);
  const granted = new Set(session.scopes);
  if (
    requested.size === 0 ||
    granted.size !== requested.size ||
    !session.scopes.every((scope) => requested.has(scope))
  ) {
    return yield* new SshPairingError({
      message: "The remote GOAT CLI returned client session scopes that differ from the request.",
      stdout,
    });
  }
  return {
    token: session.token,
    expiresAt: session.expiresAt ?? null,
    scopes: session.scopes,
  } satisfies RemoteClientSession;
});

/** The session script's refusal when the remote CLI cannot issue requested memory scopes. */
const MEMORY_SCOPES_UNSUPPORTED = /^GOAT_SESSION_ERROR=memory_scopes_unsupported runtime=(\S+)$/m;

/** Turns that refusal into the error a user reads, with what will or should happen next. */
export const memoryScopesUnsupportedError = (stdout: string, alias: string, remedy: string) => {
  const runtime = MEMORY_SCOPES_UNSUPPORTED.exec(stdout)?.[1];
  return runtime === undefined
    ? undefined
    : new SshPairingError({
        reason: "memory-scopes-unsupported",
        message: `GOAT ${runtime} on ${alias} cannot grant memory access to tasks. ${remedy}`,
        stdout,
      });
};

/** Reads the remote session script's output: a ceiling marker line, then the CLI's JSON. */
export const decodeRemoteMcpSessionOutput = Effect.fn("ssh/tunnel.decodeRemoteMcpSessionOutput")(
  function* (stdout: string) {
    const marker = /^(?:GOAT|T3)_CEILING=(applied|default)$/mu.exec(stdout);
    const session = yield* decodeRemoteJsonOutput(
      marker === null ? stdout : stdout.slice(marker.index + marker[0].length),
      decodeRemoteMcpSessionResult,
    );
    return {
      token: session.token,
      expiresAt: session.expiresAt ?? null,
      runtimeModeCeilingApplied: marker?.[1] === "applied",
    } satisfies RemoteMcpClientSession;
  },
);

interface RemoteSessionHooks {
  readonly buildRemoteRunnerSetupScript: (
    input: RemoteGoatRunnerOptions | undefined,
    selection: PreparedRemoteRuntime,
  ) => string;
  readonly prepareRemoteRuntime: ReturnType<typeof makeRuntimeProvisioning>["prepareRemoteRuntime"];
}

/**
 * Session issuance runs the runner setup and runtime preparation that tunnel.ts owns, so tunnel.ts
 * passes them in and this module never imports tunnel.ts.
 */
export function makeRemoteSessions({
  buildRemoteRunnerSetupScript,
  prepareRemoteRuntime,
}: RemoteSessionHooks) {
  function buildRemoteMcpSessionScript(
    stateKey: string,
    options: RemoteMcpClientSessionOptions,
    input?: RemoteGoatRunnerOptions,
    selection = requestedRuntime(input),
  ): string {
    return applyScriptPlaceholders(REMOTE_MCP_SESSION_SCRIPT, {
      GOAT_STATE_KEY: stateKey,
      GOAT_TTL: shellSingleQuote(options.ttl),
      GOAT_LABEL: shellSingleQuote(options.label),
      GOAT_CEILING: shellSingleQuote(options.runtimeModeCeiling ?? ""),
      GOAT_MEMORY_SCOPES: (options.memoryScopes?.length ?? 0) > 0 ? "required" : "none",
      GOAT_EXTRA_SCOPES:
        (options.approvals === true ? "--scope orchestration:approve " : "") +
        (options.providersManage === true ? "--scope providers:manage " : "") +
        (options.settingsWrite === true ? "--scope settings:write " : "") +
        (options.memoryScopes ?? []).map((scope) => `--scope ${shellSingleQuote(scope)} `).join(""),
      GOAT_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, {
        ...selection,
        mayUpgradeOwnedServer: false,
      }),
    });
  }

  function buildRemoteClientSessionScript(
    stateKey: string,
    options: RemoteClientSessionOptions,
    input?: RemoteGoatRunnerOptions,
    selection = requestedRuntime(input),
  ): string {
    if (options.scopes.length === 0) {
      throw new Error("A remote client session requires explicit scopes.");
    }
    if (options.subject === "mcp-client") {
      throw new Error("The mcp-client subject cannot access client HTTP or WebSocket endpoints.");
    }
    return applyScriptPlaceholders(REMOTE_CLIENT_SESSION_SCRIPT, {
      GOAT_STATE_KEY: stateKey,
      GOAT_SUBJECT: shellSingleQuote(options.subject),
      GOAT_SCOPES: options.scopes.map((scope) => `--scope ${shellSingleQuote(scope)}`).join(" "),
      GOAT_TTL: shellSingleQuote(options.ttl),
      GOAT_LABEL: shellSingleQuote(options.label),
      GOAT_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, {
        ...selection,
        mayUpgradeOwnedServer: false,
      }),
    });
  }

  const issueRemoteMcpClientSession = Effect.fn("ssh/tunnel.issueRemoteMcpClientSession")(
    function* (
      target: DesktopSshEnvironmentTarget,
      sessionOptions: RemoteMcpClientSessionOptions,
      input?: SshAuth.SshAuthOptions,
      runner?: RemoteGoatRunnerOptions,
      prepared?: PreparedRemoteRuntime,
    ): Effect.fn.Return<
      RemoteMcpClientSession,
      SshCommandError | SshInvalidTargetError | SshPairingError | SshLaunchError,
      ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
    > {
      const stateKey = REMOTE_RUNTIME_STATE_KEY;
      const selected =
        prepared ??
        (yield* prepareRemoteRuntime(
          target,
          input ?? {},
          { ...runner, keepExistingRunner: true },
          stateKey,
        ));
      const result = yield* runSshCommand(target, {
        remoteCommandArgs: ["sh", "-s"],
        timeoutStage: "pairing",
        stdin: buildRemoteMcpSessionScript(stateKey, sessionOptions, selected.runner, {
          ...selected,
          mayUpgradeOwnedServer: false,
        }),
        // Like pairing, this may be the first command on a cold remote.
        ...(isNodeScriptRunner(selected.runner)
          ? {}
          : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
        ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
        ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
        ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
      }).pipe(
        Effect.catchTags({
          SshCommandError: (error) =>
            Effect.fail(
              memoryScopesUnsupportedError(
                error.stdout ?? "",
                target.alias,
                `Stop it on the remote host when its work is done, then reconnect so ${
                  selected.requestedVersion
                    ? `GOAT ${selected.requestedVersion}`
                    : "this app's GOAT"
                } replaces it.`,
              ) ?? error,
            ),
        }),
      );
      const session = yield* decodeRemoteMcpSessionOutput(result.stdout).pipe(
        Effect.mapError(
          (cause) =>
            new SshPairingError({
              message: "The remote GOAT CLI did not return an MCP session.",
              stdout: result.stdout,
              cause,
            }),
        ),
      );
      if (session.token.trim().length === 0) {
        return yield* new SshPairingError({
          message: "The remote GOAT CLI returned an empty MCP session token.",
          stdout: result.stdout,
        });
      }
      yield* Effect.logInfo("ssh.remoteServer.mcpSession.issued", {
        selectedVersion: selected.version,
        requestedVersion: selected.requestedVersion,
        source: selected.source,
        ...sshTargetLogFields(target),
        stateKey,
        runtimeModeCeilingApplied: session.runtimeModeCeilingApplied,
      });
      return session;
    },
  );

  const issueRemoteClientSession = Effect.fn("ssh/tunnel.issueRemoteClientSession")(function* (
    target: DesktopSshEnvironmentTarget,
    sessionOptions: RemoteClientSessionOptions,
    input?: SshAuth.SshAuthOptions,
    runner?: RemoteGoatRunnerOptions,
    prepared?: PreparedRemoteRuntime,
  ): Effect.fn.Return<
    RemoteClientSession,
    SshCommandError | SshInvalidTargetError | SshPairingError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  > {
    const stateKey = REMOTE_RUNTIME_STATE_KEY;
    const selected =
      prepared ??
      (yield* prepareRemoteRuntime(
        target,
        input ?? {},
        { ...runner, keepExistingRunner: true },
        stateKey,
      ));
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-s"],
      timeoutStage: "pairing",
      stdin: buildRemoteClientSessionScript(stateKey, sessionOptions, selected.runner, {
        ...selected,
        mayUpgradeOwnedServer: false,
      }),
      ...(isNodeScriptRunner(selected.runner)
        ? {}
        : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
      ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
      ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    });
    const session = yield* decodeRemoteClientSessionOutput(result.stdout, sessionOptions.scopes);
    yield* Effect.logInfo("ssh.remoteServer.clientSession.issued", {
      selectedVersion: selected.version,
      requestedVersion: selected.requestedVersion,
      source: selected.source,
      ...sshTargetLogFields(target),
      stateKey,
    });
    return session;
  });

  return {
    buildRemoteMcpSessionScript,
    buildRemoteClientSessionScript,
    issueRemoteMcpClientSession,
    issueRemoteClientSession,
  };
}
