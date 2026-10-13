import {
  LEGACY_SSH_ARCHIVE_VERSION_KEY,
  LEGACY_SSH_NODE_SCRIPT_PATH_KEY,
} from "@goat/contracts/legacyT3Names";
import type {
  DesktopSshEnvironmentReadyOrPending,
  DesktopSshRuntimePendingResult,
  SshRuntimePendingReplacement,
  DesktopSshEnvironmentTarget,
} from "@goat/contracts";
import {
  SshRuntimePendingReplacementSchema,
  ORCHESTRATION_PROTOCOL_VERSION,
  RUNTIME_DRAIN_DEFAULT_GRACE_SECONDS,
  RUNTIME_DRAIN_MAX_GRACE_SECONDS,
} from "@goat/contracts";
import {
  compareRuntimeProtocols,
  ownRuntimeProtocolRanges,
  SSH_RUNTIME_PROTOCOL_VERSION,
} from "@goat/shared/sshRuntimeProtocol";
import {
  describeReadinessCause,
  waitForHttpReady as waitForHttpReadyShared,
} from "@goat/shared/httpReadiness";
import {
  CLI_RELEASE_REPOSITORY,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliReleaseDownloadBaseUrl,
} from "@goat/shared/cliRelease";
import * as KeyedLock from "@goat/shared/KeyedLock";
import * as NetService from "@goat/shared/Net";
import { extractJsonObject, fromLenientJson } from "@goat/shared/schemaJson";
import { compareSemverVersions, satisfiesSemverRange } from "@goat/shared/semver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { readLocalRuntimeArchive } from "./runtimeArchive.ts";
import { downloadRuntimeArchiveWithGh } from "./runtimeArchiveGh.ts";
import { downloadRuntimeArchiveWithHttps } from "./runtimeArchiveHttp.ts";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  collectProcessOutput,
  getLastNonEmptyOutputLine,
  REMOTE_RUNTIME_STATE_KEY,
  resolveSshCommand,
  resolveSshTarget,
  runSshCommand,
  targetConnectionKey,
} from "./command.ts";
import {
  SshCommandError,
  SshHttpBridgeError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "./errors.ts";

const DEFAULT_REMOTE_PORT = 3773;
const REMOTE_PORT_SCAN_WINDOW = 200;
const SSH_READY_TIMEOUT_MS = 20_000;
const SSH_READY_PROBE_TIMEOUT_MS = 1_000;
// How long an open forward has to answer before it counts as dead. A forward
// whose TCP connection died during sleep accepts locally and never answers.
const EXISTING_TUNNEL_CHECK_TIMEOUT_MS = 2_000;
const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;
const REMOTE_READY_TIMEOUT_MS = 60_000;
const REMOTE_LAUNCH_TIMEOUT_MS = 90_000;
// A cold archive launch also downloads and unpacks a ~70 MB release archive
// and may wait on another installer's lock. The budgets nest: the checksum
// file is tiny and the archive download is bounded; a waiter outlasts both
// downloads plus extraction so it can reuse the result; and the SSH command
// outlasts an install (own or waited-for) plus readiness, with slack for
// verification and extraction, which have no timeout of their own.
const REMOTE_ARCHIVE_CHECKSUMS_SECONDS = 30;
const REMOTE_ARCHIVE_DOWNLOAD_SECONDS = 240;
const REMOTE_ARCHIVE_LOCK_WAIT_SECONDS = 360;
const REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS = 900_000;
const REMOTE_REUSE_READY_TIMEOUT_MS = 2_000;

export interface RemoteGoatRunnerOptions {
  /**
   * Dev mode: run `node <path>` on the remote instead of a release archive.
   * The only mode that needs Node on the remote.
   */
  readonly nodeScriptPath?: string | null;
  readonly nodeEngineRange?: string | null;
  /**
   * Exact version whose self-contained release archive the remote installs
   * and runs. Required unless `nodeScriptPath` is set; the remote then needs
   * neither Node nor npm.
   */
  readonly archiveVersion?: string | null;
  readonly releaseBaseUrl?: string | null;
  /** Writable user cache; only this directory may receive gh downloads. */
  readonly archiveDirectory?: string | null;
  /** Read-only packaged archives. Never create, repair, or download into this directory. */
  readonly bundledArchiveDirectory?: string | null;
  /** Local gh executable used for authenticated acquisition; defaults to PATH lookup. */
  readonly ghCommand?: string | undefined;
  /**
   * Reuse the remote's existing `run-t3.sh` instead of replacing it. Pairing and
   * MCP-session helpers set it so remote CLI commands run with the binary that
   * matches the running server. A launch with it never installs, refreshes, or
   * replaces the host's runtime.
   */
  readonly keepExistingRunner?: boolean | null;
  /**
   * The first connection per manager may refresh an older owned runtime once,
   * when idle. Packaged desktop and the server's SSH dispatch set it.
   */
  readonly refreshOwnedRuntimeOnFirstConnection?: boolean;
  /**
   * The user confirmed replacing the live runtime even if its work outlasts the drain window.
   * Without it an expired window cancels the replacement and the server keeps running.
   */
  readonly confirmReplacement?: boolean;
  /** Drain window for a replacement, in seconds (default 60, at most 300). */
  readonly replacementGraceSeconds?: number;
}

export interface PreparedRemoteRuntime {
  readonly runner: RemoteGoatRunnerOptions;
  readonly version: string | null;
  readonly requestedVersion: string | null;
  readonly source: "requested" | "retained" | "live";
  readonly requireInstalled: boolean;
  readonly mayUpgradeOwnedServer: boolean;
  /** SHA-256 of the retained run-t3.sh observed by preparation; null for other sources. */
  readonly retainedRunnerSha256: string | null;
  readonly refreshIfIdle?: boolean;
  readonly expectedLiveVersion?: string;
  readonly expectedLiveRunnerSha256?: string;
}
const requestedRuntime = (runner: RemoteGoatRunnerOptions | undefined): PreparedRemoteRuntime => ({
  runner: { ...runner },
  version: isNodeScriptRunner(runner) ? null : runner?.archiveVersion?.trim() || null,
  requestedVersion: isNodeScriptRunner(runner) ? null : runner?.archiveVersion?.trim() || null,
  source: "requested",
  requireInstalled: false,
  retainedRunnerSha256: null,
  mayUpgradeOwnedServer: runner?.keepExistingRunner !== true,
});
const RuntimeSignals = Schema.Struct({
  serverVersion: Schema.String,
  sshRuntimeProtocolVersion: Schema.optionalKey(Schema.Int),
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  invalid: Schema.optionalKey(Schema.Boolean),
});
const CLIENT_PROTOCOL_RANGES = ownRuntimeProtocolRanges(ORCHESTRATION_PROTOCOL_VERSION);
/**
 * Protocol ranges decide compatibility. Only a server too old to advertise both integers
 * (`unknown`) falls back to the exact release, since an identical build speaks identical protocols.
 */
const matchesSignals = (signals: typeof RuntimeSignals.Type, requested: string) => {
  if (signals.invalid) return false;
  const verdict = compareRuntimeProtocols(CLIENT_PROTOCOL_RANGES, signals);
  return (
    verdict === "compatible" ||
    (verdict === "unknown" &&
      signals.serverVersion === requested &&
      (signals.sshRuntimeProtocolVersion === undefined ||
        signals.sshRuntimeProtocolVersion === SSH_RUNTIME_PROTOCOL_VERSION) &&
      (signals.orchestrationProtocolVersion === undefined ||
        signals.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION))
  );
};

const REMOTE_PROTOCOL_TOKEN_SCRIPT = `valid_version() {
  printf '%s\\n' "$1" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'
}
valid_uint() {
  printf '%s\\n' "$1" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)$' || return 1
  [ "\${#1}" -le 16 ] && awk -v n="$1" 'BEGIN { exit !(n <= 9007199254740991) }'
}
valid_positive() { valid_uint "$1" && [ "$1" != 0 ]; }
valid_port() { valid_uint "$1" && [ "$1" -le 65535 ]; }
valid_protocol_field() { [ "$1" = unknown ] || valid_positive "$1"; }
valid_own_tokens() {
  [ "$#" = 5 ] && valid_version "$1" && valid_protocol_field "$2" &&
    valid_protocol_field "$3" && valid_uint "$4" && valid_port "$5" || return 1
  # Own advertisement is normally not running: 0 0 is a valid pair.
  { [ "$4" = 0 ] && [ "$5" = 0 ]; } ||
    { valid_positive "$4" && valid_positive "$5"; }
}
valid_live_tokens() {
  [ "$#" = 6 ] && valid_uint "$5" && valid_port "$6" || return 1
  case "$1" in
    live) valid_version "$2" && valid_protocol_field "$3" &&
      valid_protocol_field "$4" && valid_positive "$6" ;;
    none) [ "$2 $3 $4 $5 $6" = 'unknown unknown unknown 0 0' ] ;;
    unknown) [ "$2 $3 $4" = 'unknown unknown unknown' ] ;;
    *) return 1 ;;
  esac
}
runner_sha256() {
  if command -v shasum >/dev/null 2>&1; then digest="$(shasum -a 256 "$1")" || return 1
  elif command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum "$1")" || return 1
  else printf 'Install shasum or sha256sum to verify the retained GOAT runner.\\n' >&2; return 1; fi
  digest="\${digest%% *}"
  printf '%s\\n' "$digest" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s' "$digest"
}
`;

export interface SshEnvironmentManagerOptions {
  readonly resolveCliRunner?: Effect.Effect<RemoteGoatRunnerOptions>;
  /**
   * Close only the local forward when a tunnel ends. A second client of a
   * host (the server's own SSH dispatch) shares the remote server with the
   * client that started it, so it must never stop that server.
   */
  readonly leaveRemoteServerRunning?: boolean;
}

interface SshTunnelEntry {
  readonly selectedRuntime: PreparedRemoteRuntime;
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
}

type SshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | SshAuth.SshPasswordPrompt;

type SshEnvironmentEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

function isNodeScriptRunner(runner: RemoteGoatRunnerOptions | undefined): boolean {
  return Boolean(runner?.nodeScriptPath?.trim());
}

function sshRunnerLogFields(runner: RemoteGoatRunnerOptions | undefined) {
  if (runner?.nodeScriptPath?.trim()) {
    return { runner: "node-script", nodeScriptPath: runner.nodeScriptPath.trim() };
  }
  if (runner?.archiveVersion?.trim()) {
    return { runner: "archive", archiveVersion: runner.archiveVersion.trim() };
  }
  return { runner: "archive" };
}

interface SshAuthOperationInput<T> {
  readonly keyOnly?: boolean;
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly operation: (
    authOptions: SshAuth.SshAuthOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

interface SshAuthAttemptInput<T> extends SshAuthOperationInput<T> {
  readonly promptCount: number;
  readonly authSecret: string | null;
}

export interface SshEnvironmentManagerShape {
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean; readonly keyOnly?: boolean },
  ) => Effect.Effect<
    DesktopSshEnvironmentReadyOrPending,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  /**
   * Checks every open local forward and closes the ones that no longer
   * answer, so the next ensure opens a fresh forward instead of handing out
   * a dead one. Remote servers keep running. Used after the machine wakes,
   * when ssh itself can take up to its keepalive window (45 s) to notice.
   */
  readonly revalidateTunnels: () => Effect.Effect<void, never, SshEnvironmentEffectContext>;
  /**
   * Issues a short-lived `mcp-client` session on the remote environment so
   * this process can call the remote's `/mcp` like an outside agent.
   */
  readonly issueMcpClientSession: (
    target: DesktopSshEnvironmentTarget,
    options: RemoteMcpClientSessionOptions,
  ) => Effect.Effect<
    RemoteMcpClientSession,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  /** Runs a POSIX `sh` script on the remote host with this manager's SSH auth. */
  readonly runRemoteScript: (
    target: DesktopSshEnvironmentTarget,
    input: { readonly script: string; readonly timeoutMs?: number },
  ) => Effect.Effect<
    { readonly stdout: string; readonly stderr: string },
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
}

export interface RemoteMcpClientSessionOptions {
  readonly label: string;
  /** A duration the remote CLI accepts, such as `12h`. */
  readonly ttl: string;
  /** Most a thread started through this session may run with; null keeps the remote default. */
  readonly runtimeModeCeiling: string | null;
  /** Also grant `orchestration:approve`. A remote CLI that predates it fails the issue. */
  readonly approvals?: boolean;
}

export interface RemoteMcpClientSession {
  readonly token: string;
  readonly expiresAt: string | null;
  /** False when the remote CLI predates `--runtime-mode-ceiling` and kept its default. */
  readonly runtimeModeCeilingApplied: boolean;
}

const RemoteLaunchResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    remotePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    serverKind: Schema.optionalKey(Schema.Literals(["external", "managed"])),
    selectedVersion: Schema.String,
    refresh: Schema.optionalKey(Schema.Literal("replaced")),
    pending: Schema.optionalKey(SshRuntimePendingReplacementSchema),
  }),
  Schema.Struct({ status: Schema.Literal("pending"), pending: SshRuntimePendingReplacementSchema }),
]);

const RemotePairingResult = Schema.Struct({
  credential: Schema.String,
});

const RemoteMcpSessionResult = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeRemoteLaunchResult = Schema.decodeEffect(fromLenientJson(RemoteLaunchResult));
const decodeRemotePairingResult = Schema.decodeEffect(fromLenientJson(RemotePairingResult));
const decodeRemoteMcpSessionResult = Schema.decodeEffect(fromLenientJson(RemoteMcpSessionResult));

const decodeRemoteJsonOutput = <A, E>(
  stdout: string,
  decode: (input: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  decode(stdout).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const jsonObject = extractJsonObject(stdout);
        if (jsonObject === stdout.trim()) {
          return yield* Effect.fail(error);
        }
        const exit = yield* Effect.exit(decode(jsonObject));
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        return yield* Effect.fail(error);
      }),
    ),
  );

const decodeRemoteLaunchOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemoteLaunchResult);

const decodeRemotePairingOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemotePairingResult);

const remoteNodeEngineCheckMain = function remoteNodeEngineCheckMain() {
  const range = process.argv[2] || "";
  const rawVersion =
    process.versions && process.versions.node ? process.versions.node : process.version;

  if (!satisfiesSemverRange(rawVersion, range)) {
    process.stderr.write(
      "Remote node " + rawVersion + " does not satisfy required range " + range + ".\n",
    );
    process.exit(1);
  }
};

function buildRemoteNodeEngineCheckScript(): string {
  return `${satisfiesSemverRange.toString()}
(${remoteNodeEngineCheckMain.toString()})();`;
}

function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/u, "");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function applyScriptPlaceholders(
  template: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let result = template;
  for (const [token, value] of Object.entries(replacements)) {
    // A replacer function keeps `$$` and other `$` patterns in the value literal.
    result = result.replaceAll(`@@${token}@@`, () => value);
  }
  return result;
}

// Re-exported from the shared HTTP readiness module so existing importers
// (notably tunnel.test.ts) keep resolving it from here.
export { describeReadinessCause };

export const REMOTE_PICK_PORT_SCRIPT = `const fs = require("node:fs");
const net = require("node:net");
const filePath = process.argv[2] ?? "";
const defaultPort = Number.parseInt(process.argv[3] ?? "", 10);
const scanWindow = Number.parseInt(process.argv[4] ?? "", 10);
const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
const preferred = Number.parseInt(raw, 10);
const start = Number.isInteger(preferred) ? preferred : defaultPort;
const end = start + scanWindow;

function tryPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(error ? false : port));
    });
  });
}

(async () => {
  for (let port = start; port < end; port += 1) {
    const available = await tryPort(port);
    if (available) {
      process.stdout.write(String(port));
      return;
    }
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

const REMOTE_WAIT_READY_SCRIPT = `const http = require("node:http");
const port = Number.parseInt(process.argv[2] ?? "", 10);
const timeoutMs = Number.parseInt(process.argv[3] ?? "", 10);
const probeTimeoutMs = Number.parseInt(process.argv[4] ?? "", 10);
if (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {
  process.exit(1);
}
const deadline = Date.now() + timeoutMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probe() {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        timeout: probeTimeoutMs,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode >= 200 && response.statusCode < 300);
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

(async () => {
  while (Date.now() < deadline) {
    if (await probe()) {
      process.exit(0);
    }
    await sleep(100);
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

// Retained runners are data: inspect either declaration spelling without sourcing shell code.
const REMOTE_RUNNER_HINT_SCRIPT = String.raw`read_runner_hint() {
  if grep -q "^$2=" "$1"; then hint_key="$2"; else hint_key="$3"; fi
  sed -n "s/^$hint_key='\(.*\)'$/\1/p" "$1"
}
`;

const REMOTE_NODE_ENV_SCRIPT = `prepend_path_if_dir() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}

remote_node_satisfies_engine() {
  GOAT_NODE_ENGINE_RANGE=@@GOAT_NODE_ENGINE_RANGE@@
  if [ -z "$GOAT_NODE_ENGINE_RANGE" ]; then
    return 0
  fi
  node - "$GOAT_NODE_ENGINE_RANGE" <<'NODE'
@@GOAT_NODE_ENGINE_CHECK_SCRIPT@@
NODE
}

ensure_remote_node_path() {
  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then
    return 0
  fi

  prepend_path_if_dir "$HOME/.local/bin"
  prepend_path_if_dir "$HOME/bin"
  prepend_path_if_dir "/opt/homebrew/bin"
  prepend_path_if_dir "/home/linuxbrew/.linuxbrew/bin"
  prepend_path_if_dir "/usr/local/bin"
  prepend_path_if_dir "/usr/bin"
  prepend_path_if_dir "/bin"

  if [ -z "\${VOLTA_HOME:-}" ]; then
    VOLTA_HOME="$HOME/.volta"
  fi
  export VOLTA_HOME
  prepend_path_if_dir "$VOLTA_HOME/bin"

  prepend_path_if_dir "$HOME/.asdf/shims"
  prepend_path_if_dir "$HOME/.asdf/bin"
  if [ ! -x "$HOME/.asdf/shims/node" ] && [ -s "$HOME/.asdf/asdf.sh" ]; then
    # shellcheck disable=SC1090
    . "$HOME/.asdf/asdf.sh"
  fi

  prepend_path_if_dir "$HOME/.local/share/mise/shims"
  prepend_path_if_dir "$HOME/.mise/shims"
  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
    eval "$(mise activate sh)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${FNM_DIR:-}" ]; then
    FNM_DIR="$HOME/.local/share/fnm"
  fi
  export FNM_DIR
  prepend_path_if_dir "$FNM_DIR"
  prepend_path_if_dir "$HOME/.fnm"
  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)" >/dev/null 2>&1 || true
    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true
  fi

  prepend_path_if_dir "$HOME/.nodenv/bin"
  prepend_path_if_dir "$HOME/.nodenv/shims"
  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then
    eval "$(nodenv init -)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${NVM_DIR:-}" ]; then
    NVM_DIR="$HOME/.nvm"
  fi
  export NVM_DIR

  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true
    fi
  fi

  if ! command -v node >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
    for GOAT_NODE_BIN in "$NVM_DIR"/versions/node/*/bin; do
      if [ -x "$GOAT_NODE_BIN/node" ]; then
        PATH="$GOAT_NODE_BIN:$PATH"
        export PATH
      fi
    done
  fi

  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine
}
`;

const REMOTE_RUNNER_SCRIPT = `#!/bin/sh
set -eu
@@GOAT_NODE_ENV_SCRIPT@@
GOAT_NODE_SCRIPT_PATH=@@GOAT_NODE_SCRIPT_PATH@@
# Older clients inspect these literal declarations without evaluating the runner.
${LEGACY_SSH_NODE_SCRIPT_PATH_KEY}=@@GOAT_NODE_SCRIPT_PATH@@
if [ -n "$GOAT_NODE_SCRIPT_PATH" ]; then
  # Dev mode: a source checkout on the remote. This is the only path that
  # needs Node, so Node discovery runs here and nowhere else.
  ensure_remote_node_path || true
  if ! command -v node >/dev/null 2>&1; then
    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
    exit 1
  fi
  exec node "$GOAT_NODE_SCRIPT_PATH" "$@"
fi
GOAT_ARCHIVE_VERSION=@@GOAT_ARCHIVE_VERSION@@
${LEGACY_SSH_ARCHIVE_VERSION_KEY}=@@GOAT_ARCHIVE_VERSION@@
if [ -z "$GOAT_ARCHIVE_VERSION" ]; then
  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2
  exit 1
fi
# Self-contained release archive: no Node, npm, or compiler on the remote.
# Unpacked into the pinned-runtime layout so \`goat service install\` reuses it.
GOAT_RELEASE_BASE_URL=@@GOAT_RELEASE_BASE_URL@@
GOAT_RUNTIME_DIR="$HOME/.goat/runtime/goat/versions/$GOAT_ARCHIVE_VERSION"
goat_runtime_ready() {
  [ -x "$GOAT_RUNTIME_DIR/goat" ] && [ "$(cat "$GOAT_RUNTIME_DIR/.install-complete" 2>/dev/null)" = "$GOAT_ARCHIVE_VERSION" ]
}
if ! goat_runtime_ready; then
  mkdir -p "$HOME/.goat/runtime/goat/versions"
  GOAT_LOCK="$HOME/.goat/runtime/goat/versions/.$GOAT_ARCHIVE_VERSION.install.lock"
  # Publish a nonempty directory with an immutable pid and unique token by
  # same-filesystem rename. mv can nest it in an existing lock: only a token
  # at the lock root proves acquisition; losers clean their candidate and
  # retry. There is no mkdir-to-pid window at the shared lock path.
  # Reclaimers cd into the generation BEFORE reading its pid, and delete
  # only relative contents of that directory. The final rmdir cannot remove
  # a newer generation because every published lock is already nonempty.
  # A reclaim counts only once the lock is gone; a lock that cannot be
  # entered or emptied waits like a live one, so the timeout still applies.
  # Legacy pid-less locks retain their short grace period.
  GOAT_LOCK_CANDIDATE=""
  GOAT_LOCK_TOKEN=""
  GOAT_STAGING=""
  goat_remove_lock_contents() {
    find . ! -name . -prune -exec rm -rf {} \\; 2>/dev/null || true
    rmdir "$GOAT_LOCK" 2>/dev/null || [ ! -e "$GOAT_LOCK" ]
  }
  goat_lock_cleanup() {
    (
      cd "$GOAT_LOCK" 2>/dev/null || exit 0
      [ -n "$GOAT_LOCK_TOKEN" ] && [ -f "./$GOAT_LOCK_TOKEN" ] || exit 0
      goat_remove_lock_contents || true
    ) || true
    if [ -n "$GOAT_LOCK_CANDIDATE" ]; then
      rm -rf "$GOAT_LOCK_CANDIDATE" "$GOAT_LOCK/\${GOAT_LOCK_CANDIDATE##*/}"
    fi
    if [ -n "$GOAT_STAGING" ]; then rm -rf "$GOAT_STAGING"; fi
  }
  trap 'goat_lock_cleanup' 0
  trap 'exit 1' 1 2 3 15
  goat_reclaim_lock() (
    if ! cd "$GOAT_LOCK" 2>/dev/null; then
      if [ -e "$GOAT_LOCK" ]; then exit 3; fi
      exit 0
    fi
    GOAT_LOCK_OWNER="$(cat pid 2>/dev/null || true)"
    if [ -n "$GOAT_LOCK_OWNER" ]; then
      if kill -0 "$GOAT_LOCK_OWNER" 2>/dev/null; then exit 2; fi
    elif [ "$GOAT_LOCK_UNOWNED" -lt 4 ]; then
      exit 1
    fi
    goat_remove_lock_contents || exit 3
  )
  GOAT_LOCK_WAITED=0
  GOAT_LOCK_UNOWNED=0
  while :; do
    GOAT_LOCK_CANDIDATE="$(mktemp -d "$GOAT_LOCK.candidate-$$-XXXXXX")"
    GOAT_LOCK_TOKEN="\${GOAT_LOCK_CANDIDATE##*/}"
    if { printf '%s\\n' "$$" > "$GOAT_LOCK_CANDIDATE/pid" &&
         : > "$GOAT_LOCK_CANDIDATE/$GOAT_LOCK_TOKEN"; } 2>/dev/null; then
      mv "$GOAT_LOCK_CANDIDATE" "$GOAT_LOCK" 2>/dev/null || true
      if [ -f "$GOAT_LOCK/$GOAT_LOCK_TOKEN" ]; then break; fi
    fi
    rm -rf "$GOAT_LOCK_CANDIDATE" "$GOAT_LOCK/$GOAT_LOCK_TOKEN"
    GOAT_LOCK_CANDIDATE=""
    if [ ! -e "$GOAT_LOCK" ]; then
      # Publication failed with no competing lock; wait so a persistent
      # failure reaches the timeout.
      :
    elif goat_reclaim_lock; then continue
    else
      GOAT_LOCK_STATUS=$?
      case "$GOAT_LOCK_STATUS" in
        1) GOAT_LOCK_UNOWNED=$((GOAT_LOCK_UNOWNED + 1)) ;;
        2) GOAT_LOCK_UNOWNED=0 ;;
      esac
    fi
    if [ "$GOAT_LOCK_WAITED" -ge @@GOAT_ARCHIVE_LOCK_WAIT_SECONDS@@ ]; then
      printf 'Another GOAT %s installation has held %s for too long.\\n' "$GOAT_ARCHIVE_VERSION" "$GOAT_LOCK" >&2
      exit 1
    fi
    sleep 1
    GOAT_LOCK_WAITED=$((GOAT_LOCK_WAITED + 1))
  done
fi
if ! goat_runtime_ready; then
  case "$(uname -s)" in
    Darwin) GOAT_PLATFORM="darwin" ;;
    Linux) GOAT_PLATFORM="linux" ;;
    *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) GOAT_ARCH="arm64" ;;
    x86_64 | amd64) GOAT_ARCH="x64" ;;
    *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -m)" >&2; exit 1 ;;
  esac
  GOAT_ARCHIVE="goat-$GOAT_ARCHIVE_VERSION-$GOAT_PLATFORM-$GOAT_ARCH.tar.gz"
  GOAT_STAGING="$(mktemp -d "$HOME/.goat/runtime/goat/versions/.staging-XXXXXX")"
  goat_fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time "$3" "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 "$1" -O "$2"
    else printf 'Remote host needs curl or wget to download %s.\\n' "$GOAT_ARCHIVE" >&2; exit 1
    fi
  }
  goat_fetch "$GOAT_RELEASE_BASE_URL/v$GOAT_ARCHIVE_VERSION/SHA256SUMS" "$GOAT_STAGING/SHA256SUMS" @@GOAT_ARCHIVE_CHECKSUMS_SECONDS@@
  goat_fetch "$GOAT_RELEASE_BASE_URL/v$GOAT_ARCHIVE_VERSION/$GOAT_ARCHIVE" "$GOAT_STAGING/$GOAT_ARCHIVE" @@GOAT_ARCHIVE_DOWNLOAD_SECONDS@@
  GOAT_EXPECTED="$(grep " \\*\\{0,1\\}$GOAT_ARCHIVE$" "$GOAT_STAGING/SHA256SUMS" | cut -d' ' -f1)"
  if command -v sha256sum >/dev/null 2>&1; then
    GOAT_ACTUAL="$(sha256sum "$GOAT_STAGING/$GOAT_ARCHIVE" | cut -d' ' -f1)"
  else
    GOAT_ACTUAL="$(shasum -a 256 "$GOAT_STAGING/$GOAT_ARCHIVE" | cut -d' ' -f1)"
  fi
  if [ -z "$GOAT_EXPECTED" ] || [ "$GOAT_ACTUAL" != "$GOAT_EXPECTED" ]; then
    printf 'Checksum mismatch for %s.\\n' "$GOAT_ARCHIVE" >&2; exit 1
  fi
  tar -xzf "$GOAT_STAGING/$GOAT_ARCHIVE" -C "$GOAT_STAGING" --strip-components=1
  rm -f "$GOAT_STAGING/$GOAT_ARCHIVE" "$GOAT_STAGING/SHA256SUMS"
  # Verify the executable and exact version before replacing a runtime,
  # including a same-version directory whose completion marker is broken.
  if ! GOAT_STAGED_VERSION_OUTPUT="$("$GOAT_STAGING/goat" --version)"; then
    printf 'The goat %s executable does not run on this host.\\n' "$GOAT_ARCHIVE_VERSION" >&2; exit 1
  fi
  if [ "$GOAT_STAGED_VERSION_OUTPUT" != "goat v$GOAT_ARCHIVE_VERSION" ]; then
    printf 'Cannot install goat %s: expected goat v%s, but the archive executable reported "%s". The existing runtime directory and completion marker have been left unchanged. Supply the correct requested archive in the local SSH runtime archive directory or release mirror, then retry.\\n' "$GOAT_ARCHIVE_VERSION" "$GOAT_ARCHIVE_VERSION" "$GOAT_STAGED_VERSION_OUTPUT" >&2
    exit 1
  fi
  printf '%s\\n' "$GOAT_ARCHIVE_VERSION" > "$GOAT_STAGING/.install-complete"
  rm -rf "$GOAT_RUNTIME_DIR"
  mv "$GOAT_STAGING" "$GOAT_RUNTIME_DIR"
fi
if [ -n "\${GOAT_LOCK:-}" ]; then
  goat_lock_cleanup
  trap - 0 1 2 3 15
fi
exec "$GOAT_RUNTIME_DIR/goat" "$@"
`;

// One host-wide mutex protects publication and server lifecycle across SSH aliases.
const REMOTE_REPLACEMENT_LOCK_SCRIPT = String.raw`LOCK="$DEFAULT_SERVER_HOME/ssh-launch/replacement.lock"
RECOVERY="$DEFAULT_SERVER_HOME/ssh-launch/replacement.recovery"
process_start() { LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null; }
LOCK_HELD=0; OWNER=; LOCK_DETAIL=
release_replacement_lock() {
  if [ -n "$OWNER" ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ]; then rm -f "$LOCK"; fi
  LOCK_HELD=0
}
release_recovery_lock() {
  if [ -n "$OWNER" ] && [ "$(readlink "$RECOVERY" 2>/dev/null || true)" = "$OWNER" ]; then rm -f "$RECOVERY"; fi
}
owner_proven_dead() {
  recorded="$1"
  old_ifs="$IFS"; IFS='|'; set -f; set -- $recorded; IFS="$old_ifs"
  [ "$#" = 5 ] && [ "$1" = "$LOCK_HOST" ] && [ "$2" = "$LOCK_UID" ] &&
    valid_positive "$3" && [ -n "$4" ] && [ -n "$5" ] || return 1
  owner_pid="$3"; owner_start="$4"
  # Failure to inspect the process table is not proof of death (nor is age).
  process_table="$(ps -e -o pid= 2>/dev/null)" || return 1
  presence="$(printf '%s\n' "$process_table" | awk -v p="$owner_pid" '$1==p { found=1 } END { print found ? "present" : "absent" }')" || return 1
  case "$presence" in absent) return 0 ;; present) ;; *) return 1 ;; esac
  current_start="$(process_start "$owner_pid")" || return 1
  [ -n "$current_start" ] && [ "$current_start" != "$owner_start" ]
}
acquire_replacement_lock() {
  LOCK_HOST="$(uname -n 2>/dev/null)" || return 1
  LOCK_UID="$(id -u 2>/dev/null)" || return 1
  LOCK_START="$(process_start "$$")" || return 1
  [ -n "$LOCK_HOST" ] && [ -n "$LOCK_UID" ] && [ -n "$LOCK_START" ] || return 1
  nonce_dir="$(mktemp -d "$STATE_DIR/lock-owner-XXXXXX")" || return 1
  NONCE="$(basename "$nonce_dir")"
  rmdir "$nonce_dir" || return 1
  OWNER="$LOCK_HOST|$LOCK_UID|$$|$LOCK_START|$NONCE"
  mkdir -p "$DEFAULT_SERVER_HOME/ssh-launch"
  if [ ! -d "$LOCK" ] && ln -s "$OWNER" "$LOCK" 2>/dev/null &&
     [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ]; then LOCK_HELD=1; return 0; fi
  dead_owner="$(readlink "$LOCK" 2>/dev/null)" || return 1
  owner_proven_dead "$dead_owner" || return 1
  if [ -d "$RECOVERY" ] || ! ln -s "$OWNER" "$RECOVERY" 2>/dev/null ||
     [ "$(readlink "$RECOVERY" 2>/dev/null || true)" != "$OWNER" ]; then
    printf 'Recovery is locked; remove %s after checking that no GOAT client is replacing this runtime.\n' "$RECOVERY" >&2
    LOCK_DETAIL=recovery-stale
    return 1
  fi
  # Only serialized recoverers can remove a dead owner's unchanged link.
  if [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$dead_owner" ] && owner_proven_dead "$dead_owner"; then rm -f "$LOCK"; fi
  release_recovery_lock
  if [ ! -d "$LOCK" ] && ln -s "$OWNER" "$LOCK" 2>/dev/null &&
     [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ]; then LOCK_HELD=1; return 0; fi
  return 1
}
`;

// Publishing a runner is the switch boundary. Execute the candidate first;
// auth commands keep an existing runner so they match its running server.
const REMOTE_PROTOCOL_GUARD_SCRIPT = `compatible_fields() {
  # version ssh orchestration; full matching integers OR exact legacy.
  [ "$2" = "@@GOAT_SSH_PROTOCOL@@" ] && [ "$3" = "@@GOAT_ORCHESTRATION_PROTOCOL@@" ] && return 0
  [ -n "$REQUESTED_VERSION" ] && [ "$1" = "$REQUESTED_VERSION" ] &&
    { [ "$2" = unknown ] || [ "$2" = "@@GOAT_SSH_PROTOCOL@@" ]; } &&
    { [ "$3" = unknown ] || [ "$3" = "@@GOAT_ORCHESTRATION_PROTOCOL@@" ]; }
}
check_candidate_protocol() {
  if [ -n "$SELECTED_VERSION" ] &&
     [ "$("$CHECK_RUNNER" --version 2>/dev/null || true)" != "goat v$SELECTED_VERSION" ]; then
    printf 'Selected executable changed before protocol use.\\n' >&2; exit 1
  fi
  if own="$("$CHECK_RUNNER" __ssh-helper protocol --shell 2>/dev/null)"; then
    set -f; set -- $own
    if ! valid_own_tokens "$@"; then printf 'Malformed candidate protocol output.\\n' >&2; exit 1; fi
    if [ -n "$SELECTED_VERSION" ] && [ "$1" != "$SELECTED_VERSION" ]; then
      printf 'Selected version and binary protocol identity disagree.\\n' >&2; exit 1
    fi
    if ! compatible_fields "$1" "$2" "$3"; then
      printf 'Candidate signals %s incompatible with SSH=%s orchestration=%s.\\n' "$own" "@@GOAT_SSH_PROTOCOL@@" "@@GOAT_ORCHESTRATION_PROTOCOL@@" >&2; exit 1
    fi
  elif [ -z "$SELECTED_VERSION" ] || [ "$SELECTED_VERSION" != "$REQUESTED_VERSION" ] ||
       [ "$("$CHECK_RUNNER" --version 2>/dev/null || true)" != "goat v$REQUESTED_VERSION" ]; then
    printf 'No protocol signals; only an independently proven exact release is allowed.\\n' >&2; exit 1
  fi
}
check_live_protocol() {
  LIVE_STATUS=none; LIVE_PID=0; LIVE_PORT=0; LIVE_VERSION=unknown
  LIVE_COMPATIBLE=0; LIVE_OWNED=0; NEEDS_OWNED_UPGRADE=0; REPLACEMENT_REASON=incompatible; comparison=
  LIVE_DRAIN=0; LIVE_INSTANCE_ID=
  if live="$("$CHECK_RUNNER" __ssh-helper protocol --runtime-file "$DEFAULT_RUNTIME_FILE" --port-file "$PORT_FILE" --pid-file "$PID_FILE" --shell 2>/dev/null)"; then
    set -f; set -- $live
    if ! valid_live_tokens "$@"; then printf 'Malformed live protocol output.\n' >&2; exit 1; fi
    LIVE_STATUS="$1"; LIVE_VERSION="$2"; LIVE_PID="$5"; LIVE_PORT="$6"
    if [ "$LIVE_STATUS" = live ] && valid_positive "$LIVE_PID" &&
       [ "$(cat "$MANAGED_FILE" 2>/dev/null || true)" = managed ] &&
       [ "$(cat "$PID_FILE" 2>/dev/null || true)" = "$LIVE_PID" ] &&
       [ "$(cat "$PORT_FILE" 2>/dev/null || true)" = "$LIVE_PORT" ]; then LIVE_OWNED=1; fi
    if [ "$LIVE_STATUS" = live ]; then read_live_compat "$2" "$3" "$4"; fi
  else
    if [ -e "$DEFAULT_RUNTIME_FILE" ] || [ -e "$PORT_FILE" ] || [ -e "$PID_FILE" ]; then LIVE_STATUS=unknown; fi
  fi
  if [ "$ALLOW_LEGACY_ADOPTION" = 1 ] &&
     { [ "$LIVE_STATUS" = unknown ] || { [ "$LIVE_STATUS" = live ] && [ "$LIVE_OWNED" = 1 ] && [ ! -e "$STATE_DIR/identity" ] && [ ! -L "$STATE_DIR/identity" ]; }; }; then
    legacy_verified=1
    if [ "$LEGACY_COMMITTED" = 1 ]; then
      verify_owned_identity "$LEGACY_PID" "$LEGACY_PORT" || ownership_unverified
    elif ! verify_legacy_identity; then legacy_verified=0; LIVE_STATUS=unknown; fi
    if [ "$legacy_verified" = 1 ] && [ "$LEGACY_PENDING" = 1 ]; then
      LIVE_STATUS=live; LIVE_PID="$LEGACY_PID"; LIVE_PORT="$LEGACY_PORT"; LIVE_VERSION="$LEGACY_VERSION"
      LIVE_OWNED=1; REPLACEMENT_REASON=legacy; NEEDS_OWNED_UPGRADE=1
    fi
  fi
  if [ "$ALLOW_OWNED_UPGRADE" = 1 ] && [ "$LIVE_OWNED" = 1 ] && [ "$LEGACY_PENDING" != 1 ] &&
     [ ! -e "$STATE_DIR/identity" ] && [ ! -L "$STATE_DIR/identity" ]; then LIVE_STATUS=unknown; fi
  if [ "$LIVE_STATUS" = unknown ]; then
    recorded_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    recorded_port="$(cat "$PORT_FILE" 2>/dev/null || true)"
    valid_positive "$recorded_pid" || recorded_pid=unknown
    valid_positive "$recorded_port" || recorded_port=unknown
    stop_pid="$recorded_pid"
    [ "$stop_pid" != unknown ] || stop_pid='<pid>'
    printf 'Cannot verify live GOAT PID=%s port=%s: descriptor unavailable or persisted identity disagrees; it may predate GOAT SSH runtime protocol metadata. It was left running, and the runner and ownership files were preserved. If this is your earlier GOAT server, stop it on the remote host (kill %s) and reconnect.\\n' "$recorded_pid" "$recorded_port" "$stop_pid" >&2; exit 1
  fi
  if [ "$LIVE_OWNED" = 1 ] && [ "$ALLOW_OWNED_UPGRADE" = 1 ] && [ "$LEGACY_PENDING" != 1 ]; then
    verify_owned_identity "$LIVE_PID" "$LIVE_PORT" || ownership_unverified
  fi
  if [ "$LIVE_STATUS" = live ] && [ -n "$REQUESTED_VERSION" ]; then
    if [ "$LIVE_COMPATIBLE" = 1 ] && [ "$LIVE_VERSION" = "$SELECTED_VERSION" ] && [ "$NEEDS_OWNED_UPGRADE" = 0 ]; then
      # A retained compatible selection only reuses its proven live version;
      # older compatible helpers need not implement the new replacement comparator.
      comparison=selected
    else
      comparison="$("$RUNNER_CANDIDATE_FILE.pin" __ssh-helper compare-version "$LIVE_VERSION" "$REQUESTED_VERSION" 2>/dev/null || true)"
    fi
    case "$comparison" in
      selected) ;;
      newer)
        if [ "$LIVE_COMPATIBLE" != 1 ]; then
          printf 'Remote runtime is newer than this app; update the app.\n' >&2; exit 1
        fi
        NEEDS_OWNED_UPGRADE=0 ;;
      older)
        if [ "$REFRESH_IF_IDLE" = 1 ] && [ "$LIVE_COMPATIBLE" = 1 ] && [ "$LIVE_OWNED" = 1 ] && [ "$REPLACEMENT_REASON" != legacy ]; then
          REPLACEMENT_REASON=older; NEEDS_OWNED_UPGRADE=1
        fi ;;
      equal) ;;
      *)
        # Exact-version old helpers may lack comparison; no ordering decision is needed.
        if [ "$LIVE_VERSION" != "$REQUESTED_VERSION" ]; then
          printf 'Cannot verify remote version ordering; process was preserved.\n' >&2; exit 1
        fi ;;
    esac
  fi
  if [ "$LIVE_STATUS" = live ] && [ "$LIVE_COMPATIBLE" != 1 ]; then
    if [ "$ALLOW_OWNED_UPGRADE" = 1 ] && [ "$LIVE_OWNED" = 1 ]; then NEEDS_OWNED_UPGRADE=1
    else printf 'Live GOAT PID=%s port=%s is incompatible; it was left running. Upgrade with the owning client or reconnect.\n' "$LIVE_PID" "$LIVE_PORT" >&2; exit 1; fi
  fi
  if [ "$NEEDS_OWNED_UPGRADE" = 1 ] && [ "$ALLOW_OWNED_UPGRADE" != 1 ]; then
    printf 'Secondary preparation cannot replace a live runtime.\n' >&2; exit 1
  fi
  if [ "$NEEDS_OWNED_UPGRADE" = 1 ] && [ "$LIVE_DRAIN" != 1 ]; then
    # A server that cannot drain for its replacement is attach-only: never replaced or signalled.
    printf 'Live GOAT PID=%s port=%s cannot drain for a replacement and this app cannot attach to it; it was left running. Stop it on the remote host when its work is done, then reconnect.\n' "$LIVE_PID" "$LIVE_PORT" >&2; exit 1
  fi
}
read_live_compat() {
  # The pinned helper applies the one protocol-range comparator. A helper that
  # predates it, or a server without integers, falls back to exact fields.
  compat_version="$1"; compat_ssh="$2"; compat_orchestration="$3"
  if compat_tokens="$("$RUNNER_CANDIDATE_FILE.pin" __ssh-helper compat --port "$LIVE_PORT" 2>/dev/null)"; then
    set -f; set -- $compat_tokens
    if [ "$#" = 3 ]; then
      case "$1" in
        compatible) LIVE_COMPATIBLE=1 ;;
        unknown) if compatible_fields "$compat_version" "$compat_ssh" "$compat_orchestration"; then LIVE_COMPATIBLE=1; fi ;;
      esac
      case "$3" in
        -|''|*[!A-Za-z0-9-]*) ;;
        *) if [ "$2" = 1 ]; then LIVE_DRAIN=1; LIVE_INSTANCE_ID="$3"; fi ;;
      esac
      return 0
    fi
  fi
  if compatible_fields "$compat_version" "$compat_ssh" "$compat_orchestration"; then LIVE_COMPATIBLE=1; fi
}
recheck_selected_before_use() {
  check_retained_runner
  # Never let a vanished ready selection become a network install.
  if [ "$REQUIRE_INSTALLED" = 1 ] && [ -n "$SELECTED_VERSION" ]; then
    selected_dir="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION"
    if [ ! -x "$selected_dir/goat" ] || [ "$(cat "$selected_dir/.install-complete" 2>/dev/null)" != "$SELECTED_VERSION" ]; then
      printf 'Selected GOAT runtime disappeared before use.\\n' >&2; exit 1
    fi
  fi
  if [ "$RUNNER_PUBLISHED" = 1 ]; then
    if ! cmp -s "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_FILE"; then
      printf 'Published selected runner changed before use.\\n' >&2; exit 1
    fi
    CHECK_RUNNER="$RUNNER_FILE"
  else
    if ! cmp -s "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_NEXT"; then
      printf 'Candidate runner changed before use.\\n' >&2; exit 1
    fi
    CHECK_RUNNER="$RUNNER_NEXT"
  fi
  check_candidate_protocol
  check_live_protocol
  CHECK_RUNNER="$RUNNER_CANDIDATE_FILE.pin"
}
`;

const REMOTE_RUNNER_SETUP_SCRIPT = `RUNNER_FILE="$STATE_DIR/run-t3.sh"
RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"
RUNNER_CANDIDATE_FILE="$RUNNER_NEXT"
CHECK_RUNNER="$RUNNER_NEXT"
DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
REQUESTED_RUNNER=@@GOAT_REQUESTED_RUNNER@@
EXPECTED_ARCHIVE_VERSION=@@GOAT_EXPECTED_ARCHIVE_VERSION@@
SELECTED_VERSION=@@GOAT_SELECTED_VERSION@@
REQUESTED_VERSION=@@GOAT_REQUESTED_VERSION@@
REQUIRE_INSTALLED=@@GOAT_REQUIRE_INSTALLED@@
PRESERVE_SELECTED_RUNNER=@@GOAT_PRESERVE_SELECTED_RUNNER@@
ALLOW_OWNED_UPGRADE=@@GOAT_ALLOW_OWNED_UPGRADE@@
ALLOW_LEGACY_ADOPTION=@@GOAT_ALLOW_LEGACY_ADOPTION@@
REFRESH_IF_IDLE=@@GOAT_REFRESH_IF_IDLE@@
REFRESH_LIVE_VERSION=@@GOAT_REFRESH_LIVE_VERSION@@
EXPECTED_LIVE_RUNNER_SHA256=@@GOAT_LIVE_RUNNER_SHA256@@
OWNING_LAUNCH=@@GOAT_OWNING_LAUNCH@@
DRAIN_FORCE=@@GOAT_DRAIN_FORCE@@
DRAIN_GRACE_SECONDS=@@GOAT_DRAIN_GRACE_SECONDS@@
RUNNER_PUBLISHED=0; REFRESH_DECISION=; LEGACY_PENDING=0; LEGACY_COMMITTED=0
LEGACY_TERMINATED=0; LEGACY_IDENTITY_LINK=; LEGACY_PUBLICATION_STARTED=0
RETAINED_SNAPSHOT_FILE=; LEGACY_PID=; LEGACY_PORT=; LEGACY_IDENTITY=; LEGACY_VERSION=; LEGACY_UID=; LEGACY_START=
EXPECTED_RETAINED_SHA256=@@GOAT_RETAINED_RUNNER_SHA256@@
@@GOAT_PROTOCOL_TOKENS@@
${REMOTE_RUNNER_HINT_SCRIPT}
check_retained_runner() {
  if [ "$RUNNER_PUBLISHED" = 0 ] && [ -n "$EXPECTED_LIVE_RUNNER_SHA256" ] &&
     [ "$(runner_sha256 "$RUNNER_FILE")" != "$EXPECTED_LIVE_RUNNER_SHA256" ]; then
    printf 'Running runner changed before publication; process was preserved.\\n' >&2; exit 1
  fi
  if [ "$PRESERVE_SELECTED_RUNNER" = 1 ]; then
    if [ -z "$EXPECTED_RETAINED_SHA256" ] || [ ! -f "$RUNNER_FILE" ] ||
       [ "$(runner_sha256 "$RUNNER_FILE")" != "$EXPECTED_RETAINED_SHA256" ]; then
      printf 'Selected retained GOAT runner bytes changed since probe; reconnect to prepare again.\\n' >&2; exit 1
    fi
  fi
}
mkdir -p "$STATE_DIR"
@@GOAT_REPLACEMENT_LOCK@@
cleanup_runner_next() {
  if [ "$LEGACY_COMMITTED" = 1 ] && [ "$LEGACY_TERMINATED" = 0 ]; then
    rollback_legacy_switch
  fi
  release_recovery_lock
  release_replacement_lock
  rm -f "$RUNNER_CANDIDATE_FILE" "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_CANDIDATE_FILE.restore"
  [ -z "$LEGACY_IDENTITY_LINK" ] || rm -f "$LEGACY_IDENTITY_LINK"
  [ -z "$RETAINED_SNAPSHOT_FILE" ] || rm -f "$RETAINED_SNAPSHOT_FILE"
}
trap 'runner_exit=$?; cleanup_runner_next; exit "$runner_exit"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
@@GOAT_CAPTURE_RUNNING_RUNNER@@
if [ "$REQUIRE_INSTALLED" = 1 ] && [ -n "$SELECTED_VERSION" ]; then
  selected_dir="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION"
  if [ ! -x "$selected_dir/goat" ] || [ "$(cat "$selected_dir/.install-complete" 2>/dev/null)" != "$SELECTED_VERSION" ]; then
    printf 'Selected GOAT %s disappeared; reconnect to prepare again.\\n' "$SELECTED_VERSION" >&2; exit 1
  fi
fi
check_retained_runner
if [ "$PRESERVE_SELECTED_RUNNER" = 1 ]; then
  # Use copied retained bytes and verify the parsed selected version again.
  if [ ! -f "$RUNNER_FILE" ] ||
     [ "$(read_runner_hint "$RUNNER_FILE" GOAT_ARCHIVE_VERSION ${LEGACY_SSH_ARCHIVE_VERSION_KEY})" != "$SELECTED_VERSION" ] ||
     [ -n "$(read_runner_hint "$RUNNER_FILE" GOAT_NODE_SCRIPT_PATH ${LEGACY_SSH_NODE_SCRIPT_PATH_KEY})" ]; then
    printf 'Selected retained runner changed; reconnect to prepare again.\\n' >&2; exit 1
  fi
  cp "$RUNNER_FILE" "$RUNNER_NEXT"
else
  cat >"$RUNNER_NEXT" <<'SH'
@@GOAT_RUNNER_SCRIPT@@
SH
fi
chmod 700 "$RUNNER_NEXT"
# Verify copied bytes before executing or pinning, closing a same-version replacement race.
check_retained_runner
if [ "$PRESERVE_SELECTED_RUNNER" = 1 ] &&
   [ "$(runner_sha256 "$RUNNER_NEXT")" != "$EXPECTED_RETAINED_SHA256" ]; then
  printf 'Retained GOAT runner changed while copying; reconnect.\\n' >&2; exit 1
fi
cp "$RUNNER_NEXT" "$RUNNER_CANDIDATE_FILE.pin"
if ! RUNNER_VERSION_OUTPUT="$("$RUNNER_NEXT" --version)"; then
  printf 'Cannot validate %s; existing runner and server were preserved.\\n' "$REQUESTED_RUNNER" >&2; exit 1
fi
if [ -n "$EXPECTED_ARCHIVE_VERSION" ] && [ "$RUNNER_VERSION_OUTPUT" != "goat v$EXPECTED_ARCHIVE_VERSION" ]; then
  printf 'Expected goat v%s, observed %s; existing runner and server were preserved.\\n' "$EXPECTED_ARCHIVE_VERSION" "$RUNNER_VERSION_OUTPUT" >&2; exit 1
fi
TARGET_VERSION="\${RUNNER_VERSION_OUTPUT#goat v}"
if [ -n "$SELECTED_VERSION" ]; then
  # Cold mirrors installed this exact archive during validation; pin future use too.
  selected_dir="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION"
  if [ ! -x "$selected_dir/goat" ] || [ "$(cat "$selected_dir/.install-complete" 2>/dev/null)" != "$SELECTED_VERSION" ]; then
    printf 'Validated selected archive is not complete.\\n' >&2; exit 1
  fi
  REQUIRE_INSTALLED=1
fi
RUNNER_CHANGED=0
@@GOAT_PROTOCOL_GUARD@@
check_candidate_protocol
check_live_protocol
if ! cmp -s "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_NEXT"; then
  printf 'Candidate runner changed during validation; reconnect.\n' >&2; exit 1
fi
publish_selected_runner() {
  [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] || {
    printf 'Replacement lock ownership changed; runner was preserved.\\n' >&2; exit 1;
  }
  check_retained_runner
@@GOAT_RUNNER_INSTALL@@
  RUNNER_PUBLISHED=1
}
emit_pending() {
  reason="$1"
  pending_fields="$(printf '"reason":"%s","replacement":"%s","requestedVersion":"%s","liveVersion":"%s"' "$reason" "$REPLACEMENT_REASON" "$REQUESTED_VERSION" "$LIVE_VERSION")"
  if [ "$LOCK_DETAIL" = recovery-stale ]; then pending_fields="$pending_fields,"'"detail":"recovery-stale"'; fi
  # Reuse is independently proven using the retained runner, never the incompatible candidate.
  if [ "$LIVE_COMPATIBLE" = 1 ] && [ -f "$RETAINED_SNAPSHOT_FILE" ] &&
     [ "$(runner_sha256 "$RUNNER_FILE")" = "$EXPECTED_LIVE_RUNNER_SHA256" ] &&
     [ "$("$RETAINED_SNAPSHOT_FILE" --version 2>/dev/null || true)" = "goat v$LIVE_VERSION" ]; then
    retained_own="$("$RETAINED_SNAPSHOT_FILE" __ssh-helper protocol --shell 2>/dev/null || true)"
    set -f; set -- $retained_own
    if valid_own_tokens "$@" && compatible_fields "$1" "$2" "$3" && [ "$1" = "$LIVE_VERSION" ] &&
       "$RETAINED_SNAPSHOT_FILE" __ssh-helper wait-ready "$LIVE_PORT" "@@GOAT_REUSE_READY_TIMEOUT_MS@@" "@@GOAT_READY_PROBE_TIMEOUT_MS@@" >/dev/null 2>&1; then
      CHECK_RUNNER="$RUNNER_CANDIDATE_FILE.pin"
      pending_pid="$LIVE_PID"; pending_port="$LIVE_PORT"; pending_version="$LIVE_VERSION"
      check_retained_runner
      check_live_protocol
      if [ "$LIVE_COMPATIBLE" = 1 ] && [ "$LIVE_PID" = "$pending_pid" ] && [ "$LIVE_PORT" = "$pending_port" ] && [ "$LIVE_VERSION" = "$pending_version" ]; then
        printf '{"status":"ready","remotePort":%s,"serverKind":"managed","selectedVersion":"%s","pending":{%s}}\n' "$LIVE_PORT" "$LIVE_VERSION" "$pending_fields"
        exit 0
      fi
    fi
  fi
  printf '{"status":"pending","pending":{%s}}\n' "$pending_fields"
  exit 0
}
if [ "$OWNING_LAUNCH" = 1 ]; then
  acquire_replacement_lock || emit_pending contended
  # Classification and ordering must be fresh under the host-wide mutex.
  CHECK_RUNNER="$RUNNER_CANDIDATE_FILE.pin"
  check_live_protocol
  if [ "$LIVE_COMPATIBLE" = 1 ] && [ "$comparison" = newer ] && [ "$LIVE_VERSION" != "$SELECTED_VERSION" ]; then
    # Another client may have completed a newer installation since preparation.
    # Pin its independently verified retained runner rather than publish our older candidate.
    selected_dir="$HOME/.goat/runtime/goat/versions/$LIVE_VERSION"
    [ -x "$selected_dir/goat" ] && [ "$(cat "$selected_dir/.install-complete" 2>/dev/null)" = "$LIVE_VERSION" ] || ownership_unverified
    fresh_sha="$(runner_sha256 "$RUNNER_FILE")" || ownership_unverified
    cp "$RUNNER_FILE" "$RUNNER_NEXT"
    [ "$(runner_sha256 "$RUNNER_NEXT")" = "$fresh_sha" ] && [ "$(runner_sha256 "$RUNNER_FILE")" = "$fresh_sha" ] || ownership_unverified
    [ "$("$RUNNER_NEXT" --version 2>/dev/null || true)" = "goat v$LIVE_VERSION" ] || ownership_unverified
    cp "$RUNNER_NEXT" "$RUNNER_CANDIDATE_FILE.pin"
    SELECTED_VERSION="$LIVE_VERSION"; REQUIRE_INSTALLED=1
    EXPECTED_LIVE_RUNNER_SHA256="$fresh_sha"
    [ "$PRESERVE_SELECTED_RUNNER" = 0 ] || EXPECTED_RETAINED_SHA256="$fresh_sha"
  fi
  check_candidate_protocol
  check_retained_runner
  check_live_protocol
@@GOAT_VERIFY_OWNED_BEFORE_PUBLICATION@@
  if [ "$NEEDS_OWNED_UPGRADE" = 1 ] && [ "$REPLACEMENT_REASON" != incompatible ]; then
    # An optional refresh waits for idle; launch probes again last, then the server drains.
    activity="$(read_refresh_activity)"
    [ "$activity" = idle ] || emit_pending "$activity"
  fi
else
  # Pairing/MCP reuse is read-only; only initial shared setup may publish.
  if [ -f "$RUNNER_FILE" ] && [ "$LIVE_STATUS" != none ]; then
    if ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
      secondary_sha="$(runner_sha256 "$RUNNER_FILE")" || exit 1
      cp "$RUNNER_FILE" "$RUNNER_NEXT"
      [ "$(runner_sha256 "$RUNNER_NEXT")" = "$secondary_sha" ] && [ "$(runner_sha256 "$RUNNER_FILE")" = "$secondary_sha" ] || exit 1
      cp "$RUNNER_NEXT" "$RUNNER_CANDIDATE_FILE.pin"
      CHECK_RUNNER="$RUNNER_CANDIDATE_FILE.pin"
      check_candidate_protocol
      check_live_protocol
    fi
    RUNNER_PUBLISHED=1
  else
    acquire_replacement_lock || { printf 'Another client is replacing the remote runtime.\n' >&2; exit 1; }
    check_live_protocol
    publish_selected_runner
  fi
fi

`;

// Legacy adoption reads only a pinned retained runner; never evaluate shell source.
const REMOTE_LEGACY_IDENTITY_SCRIPT = String.raw`capture_running_runner() {
  RETAINED_SNAPSHOT_FILE="$STATE_DIR/run-t3.retained.$$"
  if [ -f "$RUNNER_FILE" ]; then
    running_sha="$(runner_sha256 "$RUNNER_FILE")" || return 1
    if [ -n "$EXPECTED_LIVE_RUNNER_SHA256" ] && [ "$running_sha" != "$EXPECTED_LIVE_RUNNER_SHA256" ]; then return 1; fi
    cp "$RUNNER_FILE" "$RETAINED_SNAPSHOT_FILE"
    [ "$(runner_sha256 "$RETAINED_SNAPSHOT_FILE")" = "$running_sha" ] &&
      [ "$(runner_sha256 "$RUNNER_FILE")" = "$running_sha" ] || return 1
    EXPECTED_LIVE_RUNNER_SHA256="$running_sha"
  fi
}
decode_named_retained_assignment() {
  awk -v key="$1" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" {
      count++
      if (index($0, key "=") != 1) bad=1
      value=substr($0,length(key)+2)
    }
    END {
      if (bad || count != 1 || length(value)<2 || substr(value,1,1)!="\047" || substr(value,length(value),1)!="\047") exit 1
      text=substr(value,2,length(value)-2); decoded=""
      for (i=1;i<=length(text);i++) {
        c=substr(text,i,1)
        if (c=="\047") {
          if (substr(text,i,4)!="\047\\\047\047") exit 1
          decoded=decoded "\047"; i+=3
        } else decoded=decoded c
      }
      print decoded
    }' "$RETAINED_SNAPSHOT_FILE"
}
decode_retained_assignment() {
  if awk -v key="$1" '$0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" {found=1} END {exit !found}' "$RETAINED_SNAPSHOT_FILE"; then
    decode_named_retained_assignment "$1"
  else
    decode_named_retained_assignment "$2"
  fi
}
legacy_files_regular() {
  for legacy_file in "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$RUNNER_FILE"; do
    [ -f "$legacy_file" ] && [ ! -L "$legacy_file" ] || return 1
  done
}
read_legacy_value() {
  awk 'NR==1 { value=$0 } END { if (NR!=1) exit 1; print value }' "$1"
}
verify_legacy_process() {
  legacy_files_regular || return 1
  legacy_uid="$(ps -o uid= -p "$1" 2>/dev/null)" || return 1
  legacy_uid="$(printf '%s\n' "$legacy_uid" | awk 'NF==1 { print $1 }')"
  [ "$legacy_uid" = "$(id -u)" ] || return 1
  legacy_start="$(ps -o lstart= -p "$1" 2>/dev/null)" || return 1
  [ -n "$legacy_start" ] || return 1
  case "$legacy_start" in *[[:cntrl:]]*) return 1 ;; esac
  legacy_command="$(ps -o command= -p "$1" 2>/dev/null)" || return 1
  [ "$legacy_command" = "$2" ] || return 1
  if [ "$LEGACY_PENDING" = 1 ]; then
    [ "$legacy_uid" = "$LEGACY_UID" ] && [ "$legacy_start" = "$LEGACY_START" ] || return 1
  fi
  if [ "$RUNNER_PUBLISHED" = 1 ]; then
    cmp -s "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_FILE" || return 1
  else
    [ "$(runner_sha256 "$RUNNER_FILE")" = "$EXPECTED_LIVE_RUNNER_SHA256" ] || return 1
  fi
  legacy_files_regular
}
verify_legacy_identity() {
  [ "$ALLOW_LEGACY_ADOPTION" = 1 ] && [ ! -e "$STATE_DIR/identity" ] && [ ! -L "$STATE_DIR/identity" ] || return 1
  legacy_files_regular || return 1
  [ -f "$RETAINED_SNAPSHOT_FILE" ] && [ -n "$EXPECTED_LIVE_RUNNER_SHA256" ] || return 1
  [ "$(runner_sha256 "$RUNNER_FILE")" = "$EXPECTED_LIVE_RUNNER_SHA256" ] &&
    [ "$(runner_sha256 "$RETAINED_SNAPSHOT_FILE")" = "$EXPECTED_LIVE_RUNNER_SHA256" ] || return 1
  legacy_pid="$(read_legacy_value "$PID_FILE")" || return 1
  legacy_port="$(read_legacy_value "$PORT_FILE")" || return 1
  [ "$(read_legacy_value "$MANAGED_FILE")" = managed ] &&
    valid_positive "$legacy_pid" && valid_positive "$legacy_port" && valid_port "$legacy_port" &&
    kill -0 "$legacy_pid" 2>/dev/null || return 1
  legacy_version="$(decode_retained_assignment GOAT_ARCHIVE_VERSION ${LEGACY_SSH_ARCHIVE_VERSION_KEY})" || return 1
  legacy_entry="$(decode_retained_assignment GOAT_NODE_SCRIPT_PATH ${LEGACY_SSH_NODE_SCRIPT_PATH_KEY})" || return 1
  [ -z "$legacy_entry" ] || return 1
  case "$legacy_version" in ''|*[!0-9A-Za-z.-]*) return 1 ;; esac
  valid_version "$legacy_version" || return 1
  legacy_tail="$HOME/.goat/runtime/goat/versions/$legacy_version/goat serve --host 127.0.0.1 --port $legacy_port --base-dir $DEFAULT_SERVER_HOME"
  verify_legacy_process "$legacy_pid" "$legacy_tail" || return 1
  if [ "$LEGACY_PENDING" = 1 ]; then
    [ "$LEGACY_PID" = "$legacy_pid" ] && [ "$LEGACY_PORT" = "$legacy_port" ] &&
      [ "$LEGACY_IDENTITY" = "$legacy_tail" ] || return 1
  fi
  [ "$(cat "$PID_FILE" 2>/dev/null || true)" = "$legacy_pid" ] &&
    [ "$(cat "$PORT_FILE" 2>/dev/null || true)" = "$legacy_port" ] &&
    [ "$(cat "$MANAGED_FILE" 2>/dev/null || true)" = managed ] &&
    [ ! -e "$STATE_DIR/identity" ] && [ ! -L "$STATE_DIR/identity" ] &&
    [ "$(runner_sha256 "$RUNNER_FILE")" = "$EXPECTED_LIVE_RUNNER_SHA256" ] || return 1
  LEGACY_PID="$legacy_pid"; LEGACY_PORT="$legacy_port"; LEGACY_IDENTITY="$legacy_tail"
  LEGACY_VERSION="$legacy_version"; LEGACY_UID="$legacy_uid"; LEGACY_START="$legacy_start"; LEGACY_PENDING=1
}
commit_legacy_identity() {
  verify_legacy_identity || return 1
  legacy_next="$STATE_DIR/identity.next.$$"
  printf '%s\n' "$LEGACY_IDENTITY" >"$legacy_next"
  verify_legacy_identity || { rm -f "$legacy_next"; return 1; }
  # Atomic create, refusing a competing identity instead of overwriting it.
  if ! ln "$legacy_next" "$STATE_DIR/identity" 2>/dev/null; then rm -f "$legacy_next"; return 1; fi
  if ! verify_owned_identity "$LEGACY_PID" "$LEGACY_PORT"; then
    if [ "$legacy_next" -ef "$STATE_DIR/identity" ]; then rm -f "$STATE_DIR/identity"; fi
    rm -f "$legacy_next"; return 1
  fi
  # Keep a hard link so rollback removes only the identity created by this attempt.
  LEGACY_IDENTITY_LINK="$legacy_next"
  LEGACY_COMMITTED=1
}
rollback_legacy_switch() {
  # A failed switch must remain retryable while the legacy process is still alive.
  # Never overwrite runner bytes or an identity replaced by another actor.
  if [ "$LEGACY_PUBLICATION_STARTED" = 1 ] && [ -f "$RETAINED_SNAPSHOT_FILE" ] &&
     [ ! -L "$RUNNER_FILE" ] && cmp -s "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_FILE"; then
    if cp -p "$RETAINED_SNAPSHOT_FILE" "$RUNNER_CANDIDATE_FILE.restore" &&
       mv -f "$RUNNER_CANDIDATE_FILE.restore" "$RUNNER_FILE"; then :
    else printf 'Could not restore the retained GOAT runner after a failed switch.\n' >&2; fi
  fi
  if [ -n "$LEGACY_IDENTITY_LINK" ] && [ "$LEGACY_IDENTITY_LINK" -ef "$STATE_DIR/identity" ] &&
     [ "$(cat "$STATE_DIR/identity" 2>/dev/null)" = "$LEGACY_IDENTITY" ]; then
    rm -f "$STATE_DIR/identity"
  fi
}
read_refresh_activity() {
  activity_runner="$RUNNER_CANDIDATE_FILE.pin"
  if activity="$("$activity_runner" __ssh-helper activity --port "$LIVE_PORT" --pid "$LIVE_PID" --shell 2>/dev/null)"; then
    case "$activity" in idle|busy) printf '%s' "$activity"; return ;; esac
  fi
  printf unknown
}

`;

// PID existence and protocol metadata are not authority to signal a process.
// Both termination paths must corroborate the complete invocation we launch.
const REMOTE_OWNED_IDENTITY_SCRIPT = `verify_owned_identity() {
  owned_pid="$1"; owned_port="$2"
  valid_positive "$owned_pid" && valid_positive "$owned_port" && valid_port "$owned_port" || return 1
  [ "$(cat "$MANAGED_FILE" 2>/dev/null || true)" = managed ] || return 1
  [ -f "$STATE_DIR/identity" ] && [ ! -L "$STATE_DIR/identity" ] || return 1
  owned_uid="$(ps -o uid= -p "$owned_pid" 2>/dev/null)" || return 1
  [ "$(printf '%s\\n' "$owned_uid" | awk 'NF==1 { print $1 }')" = "$(id -u)" ] || return 1
  owned_identity="$(cat "$STATE_DIR/identity" 2>/dev/null)" || return 1
  [ -n "$owned_identity" ] || return 1
  case "$owned_identity" in
    *" --port $owned_port --base-dir $DEFAULT_SERVER_HOME") ;;
    *) return 1 ;;
  esac
  owned_command="$(ps -o command= -p "$owned_pid" 2>/dev/null)" || return 1
  case "$owned_identity" in
    "$HOME/.goat/runtime/goat/versions/"*)
      # An archive's identity includes its executable, so no prefix is allowed.
      [ "$owned_command" = "$owned_identity" ] || return 1 ;;
    *)
      # Node shims can exec a different binary; the persisted entry and arguments own it.
      case "$owned_command" in *" $owned_identity") ;; *) return 1 ;; esac ;;
  esac
  # Ownership and the running server's identity must still match after inspection.
  [ "$(cat "$PID_FILE" 2>/dev/null || true)" = "$owned_pid" ] &&
    [ "$(cat "$PORT_FILE" 2>/dev/null || true)" = "$owned_port" ] &&
    [ "$(cat "$MANAGED_FILE" 2>/dev/null || true)" = managed ] &&
    [ "$(cat "$STATE_DIR/identity" 2>/dev/null || true)" = "$owned_identity" ]
}
`;

const VERIFY_OWNED_BEFORE_PUBLICATION = `if [ "$LEGACY_PENDING" = 1 ]; then
  verify_legacy_identity || ownership_unverified
elif [ "$LIVE_OWNED" = 1 ] && ! verify_owned_identity "$LIVE_PID" "$LIVE_PORT"; then
  printf 'GOAT ownership could not be verified for PID %s: persisted launch identity is missing or mismatched; process, runner and ownership files were preserved.\\n' "$LIVE_PID" >&2
  exit 1
fi`;

const REMOTE_LAUNCH_SCRIPT = `set -eu
@@GOAT_NODE_ENV_SCRIPT@@
STATE_KEY="$1"
STATE_DIR="$HOME/.goat/ssh-launch/$STATE_KEY"
DEFAULT_SERVER_HOME="$HOME/.goat"
DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
LOG_FILE="$STATE_DIR/server.log"
ownership_unverified() {
  printf 'GOAT ownership could not be verified; process and ownership files were preserved.\\n' >&2; exit 1
}
@@GOAT_OWNED_IDENTITY@@
@@GOAT_LEGACY_IDENTITY@@
@@GOAT_RUNNER_SETUP@@
IDENTITY_NEXT="$STATE_DIR/identity.next.$$"
trap 'runner_exit=$?; cleanup_runner_next; rm -f "$IDENTITY_NEXT"; exit "$runner_exit"' EXIT
GOAT_ARCHIVE_MODE=@@GOAT_ARCHIVE_MODE@@
GOAT_NODE_SCRIPT_PATH=@@GOAT_NODE_SCRIPT_PATH@@
if [ "$GOAT_ARCHIVE_MODE" = 0 ]; then
  # Protocol token parsing disabled globbing; version-manager discovery needs it.
  case "$-" in *f*) NODE_RESTORE_NOGLOB=1 ;; *) NODE_RESTORE_NOGLOB=0 ;; esac
  set +f
  ensure_remote_node_path || true
  [ "$NODE_RESTORE_NOGLOB" = 0 ] || set -f
fi
recheck_selected_before_use
pick_port() {
  if [ "$GOAT_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE" "@@GOAT_DEFAULT_REMOTE_PORT@@" "@@GOAT_REMOTE_PORT_SCAN_WINDOW@@"
    return
  fi
  node - "$PORT_FILE" "@@GOAT_DEFAULT_REMOTE_PORT@@" "@@GOAT_REMOTE_PORT_SCAN_WINDOW@@" <<'NODE'
@@GOAT_PICK_PORT_SCRIPT@@
NODE
}
wait_ready() {
  if [ "$GOAT_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT" "$1" "@@GOAT_READY_PROBE_TIMEOUT_MS@@"
    return
  fi
  node - "$REMOTE_PORT" "$1" "@@GOAT_READY_PROBE_TIMEOUT_MS@@" <<'NODE'
@@GOAT_WAIT_READY_SCRIPT@@
NODE
}
wait_for_pid_exit() {
  PID_TO_WAIT="$1"
  WAIT_COUNT=0
  while kill -0 "$PID_TO_WAIT" 2>/dev/null && [ "$WAIT_COUNT" -lt 20 ]; do
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
}
reuse_live_server() {
    REMOTE_PORT="$LIVE_PORT"
    if ! wait_ready "@@GOAT_REUSE_READY_TIMEOUT_MS@@"; then
      printf 'Selected live server did not answer; it was left running.\\n' >&2; exit 1
    fi
    recheck_selected_before_use
    if [ "$LIVE_COMPATIBLE" != 1 ]; then
      printf 'Live server compatibility changed during readiness; reconnect.\\n' >&2; exit 1
    fi
    if [ "$LIVE_OWNED" = 1 ]; then
      REMOTE_PID="$LIVE_PID"
      REMOTE_MANAGED=managed
    else
      REMOTE_MANAGED=external
      rm -f "$PID_FILE" "$STATE_DIR/identity"
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
    fi
}
recheck_selected_before_use
REMOTE_PID=""
REMOTE_PORT=""
REMOTE_MANAGED=""
if [ "$NEEDS_OWNED_UPGRADE" = 1 ]; then
  UPGRADE_PID="$LIVE_PID"; UPGRADE_PORT="$LIVE_PORT"; UPGRADE_VERSION="$LIVE_VERSION"
  UPGRADE_INSTANCE="$LIVE_INSTANCE_ID"
  # Validate bytes and authority before the final PID-validated idle probe.
  check_candidate_protocol
  check_retained_runner
  if [ "$LEGACY_PENDING" = 1 ] && [ "$LEGACY_COMMITTED" = 0 ]; then
    verify_legacy_identity || ownership_unverified
  else verify_owned_identity "$LIVE_PID" "$LIVE_PORT" || ownership_unverified; fi
  UPGRADE_START="$(process_start "$UPGRADE_PID")" || ownership_unverified
  [ -n "$UPGRADE_START" ] || ownership_unverified
  if [ "$REPLACEMENT_REASON" != incompatible ]; then
    # An optional refresh drains only an idle server, so its retries never hold up new turns.
    activity="$(read_refresh_activity)"
    [ "$activity" = idle ] || emit_pending "$activity"
  fi
  if [ "$LEGACY_PENDING" = 1 ] && [ "$LEGACY_COMMITTED" = 0 ]; then
    commit_legacy_identity || ownership_unverified
  fi
  verify_owned_identity "$UPGRADE_PID" "$UPGRADE_PORT" || ownership_unverified
  if [ "$LEGACY_PENDING" = 1 ]; then
    verify_legacy_process "$UPGRADE_PID" "$LEGACY_IDENTITY" || ownership_unverified
  fi
  [ "$(process_start "$UPGRADE_PID")" = "$UPGRADE_START" ] || ownership_unverified
  [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] || ownership_unverified
  PREVIOUS_IDENTITY="$(cat "$STATE_DIR/identity")" || ownership_unverified
  PREVIOUS_RUNNER="$STATE_DIR/run-t3.previous"
  if [ -f "$RETAINED_SNAPSHOT_FILE" ]; then cp -p "$RETAINED_SNAPSHOT_FILE" "$PREVIOUS_RUNNER"
  else cp -p "$RUNNER_FILE" "$PREVIOUS_RUNNER"; fi
  # The server, not this script, stops itself: it refuses new turns, lets running work
  # finish within the grace window, and exits. Unconfirmed, an expired window cancels.
  drain_force=
  [ "$DRAIN_FORCE" != 1 ] || drain_force=--force
  drain_result="$("$RUNNER_CANDIDATE_FILE.pin" __ssh-helper drain --port "$UPGRADE_PORT" --instance-id "$UPGRADE_INSTANCE" --target-version "$TARGET_VERSION" --grace-seconds "$DRAIN_GRACE_SECONDS" $drain_force --token-file "$DEFAULT_SERVER_HOME/userdata/runtime-control.token" 2>/dev/null || true)"
  case "$drain_result" in
    drained) ;;
    cancelled) rm -f "$PREVIOUS_RUNNER"; emit_pending busy ;;
    *) rm -f "$PREVIOUS_RUNNER"; emit_pending unknown ;;
  esac
  LEGACY_TERMINATED=1
  rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity"
  publish_selected_runner
  if [ "$GOAT_ARCHIVE_MODE" = 1 ]; then
    SPAWN_IDENTITY="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION/goat"
  else
    SPAWN_IDENTITY="$GOAT_NODE_SCRIPT_PATH"
  fi
  SUPERVISE_RESULT="$STATE_DIR/replacement.result.$$"
  rm -f "$SUPERVISE_RESULT"
  # Detached, so a dropped SSH session cannot leave the host without a server.
  trap '' HUP
  nohup "$RUNNER_FILE" __ssh-helper supervise --old-pid "$UPGRADE_PID" --old-instance-id "$UPGRADE_INSTANCE" --port "$UPGRADE_PORT" --base-dir "$DEFAULT_SERVER_HOME" --state-dir "$STATE_DIR" --runner "$RUNNER_FILE" --previous-runner "$PREVIOUS_RUNNER" --target-version "$TARGET_VERSION" --previous-version "$UPGRADE_VERSION" --identity "$SPAWN_IDENTITY serve --host 127.0.0.1 --port $UPGRADE_PORT --base-dir $DEFAULT_SERVER_HOME" --previous-identity "$PREVIOUS_IDENTITY" --ready-timeout-ms "@@GOAT_READY_TIMEOUT_MS@@" --log "$LOG_FILE" --result "$SUPERVISE_RESULT" >/dev/null 2>>"$LOG_FILE" </dev/null &
  wait "$!" || true
  supervise_status=failed; supervise_pid=0; supervise_version=
  if [ -f "$SUPERVISE_RESULT" ]; then read -r supervise_status supervise_pid supervise_version <"$SUPERVISE_RESULT" || true; fi
  rm -f "$SUPERVISE_RESULT"
  case "$supervise_status" in
    replaced)
      REMOTE_PID="$supervise_pid"; REMOTE_PORT="$UPGRADE_PORT"; REMOTE_MANAGED=managed
      REFRESH_DECISION=replaced ;;
    rolled-back)
      if [ "$LIVE_COMPATIBLE" != 1 ]; then
        printf 'GOAT %s did not start on the remote host; GOAT %s was restored and is running, but this app cannot attach to it. See %s.\n' "$TARGET_VERSION" "$supervise_version" "$LOG_FILE" >&2; exit 1
      fi
      printf 'GOAT %s did not start on the remote host; GOAT %s was restored.\n' "$TARGET_VERSION" "$supervise_version" >&2
      REMOTE_PID="$supervise_pid"; REMOTE_PORT="$UPGRADE_PORT"; REMOTE_MANAGED=managed
      SELECTED_VERSION="$supervise_version" ;;
    *)
      printf 'Remote runtime replacement failed; see %s.\n' "$LOG_FILE" >&2; exit 1 ;;
  esac
elif [ "$LIVE_STATUS" = live ]; then
  if [ "$LIVE_COMPATIBLE" != 1 ]; then
    printf 'Live GOAT compatibility changed; reconnect.\n' >&2; exit 1
  fi
  # A compatible live selection may be newer; preparation must pin that version.
  if [ -n "$SELECTED_VERSION" ] && [ "$LIVE_VERSION" != "$SELECTED_VERSION" ]; then
    printf 'Live GOAT version changed before reuse; reconnect without replacing it.\n' >&2; exit 1
  fi
  publish_selected_runner
  reuse_live_server
else
  publish_selected_runner
fi
if [ -z "$REMOTE_PORT" ]; then
  REMOTE_PORT="$(pick_port)" || true
  if [ -z "$REMOTE_PORT" ]; then
    if [ "$GOAT_ARCHIVE_MODE" = "1" ]; then
      printf 'Failed to find an available port on the remote host.\\n' >&2
    else
      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2
    fi
    exit 1
  fi
  recheck_selected_before_use
  if [ "$LIVE_STATUS" != none ]; then
    printf 'A server appeared before launch; reconnect without replacing it.\\n' >&2; exit 1
  fi
  if [ "$GOAT_ARCHIVE_MODE" = 1 ]; then
    GOAT_RUNTIME_DIR="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION"
    SPAWN_IDENTITY="$GOAT_RUNTIME_DIR/goat"
  else
    SPAWN_IDENTITY="$GOAT_NODE_SCRIPT_PATH"
  fi
  nohup env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$DEFAULT_SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
  REMOTE_PID="$!"
  printf '%s\\n' "$SPAWN_IDENTITY serve --host 127.0.0.1 --port $REMOTE_PORT --base-dir $DEFAULT_SERVER_HOME" >"$IDENTITY_NEXT"
  mv "$IDENTITY_NEXT" "$STATE_DIR/identity"
  printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
  printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
  printf 'managed\\n' >"$MANAGED_FILE"
  if ! wait_ready "@@GOAT_READY_TIMEOUT_MS@@"; then
    printf 'Remote GOAT server did not become ready on 127.0.0.1:%s.\\n' "$REMOTE_PORT" >&2
    if [ -s "$LOG_FILE" ]; then
      tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
    else
      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' "$LOG_FILE" >&2
    fi
    kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID"
    rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity"
    exit 1
  fi
fi
refresh_fields=
[ "$REFRESH_DECISION" != replaced ] || refresh_fields=',"refresh":"replaced"'
printf '{"status":"ready","remotePort":%s,"serverKind":"%s","selectedVersion":"%s"%s}\n' "$REMOTE_PORT" "\${REMOTE_MANAGED:-managed}" "$SELECTED_VERSION" "$refresh_fields"

`;

const REMOTE_PAIRING_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
DEFAULT_SERVER_HOME="$HOME/.goat"
@@GOAT_RUNNER_SETUP@@
PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"
recheck_selected_before_use
"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json
`;

const REPLACE_RUNNER_INSTALL = `if [ -f "$RUNNER_FILE" ] && cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  rm -f "$RUNNER_NEXT"
else
  mv "$RUNNER_NEXT" "$RUNNER_FILE"
  RUNNER_CHANGED=1
fi`;
const KEEP_EXISTING_RUNNER_INSTALL = `if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  printf 'Selected retained runner changed before publication; reconnect.\\n' >&2; exit 1
fi
rm -f "$RUNNER_NEXT"`;

// Issues an `mcp-client` bearer session, the only kind the remote's `/mcp`
// admits from outside a thread. `--runtime-mode-ceiling` is newer than some
// remotes, so an older CLI is retried without it and reports the default.
const REMOTE_MCP_SESSION_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
DEFAULT_SERVER_HOME="$HOME/.goat"
@@GOAT_RUNNER_SETUP@@
set -- auth session issue --base-dir "$DEFAULT_SERVER_HOME" --subject mcp-client --scope orchestration:read --scope orchestration:operate @@GOAT_EXTRA_SCOPES@@--ttl @@GOAT_TTL@@ --label @@GOAT_LABEL@@ --json
CEILING=@@GOAT_CEILING@@
recheck_selected_before_use
if [ -n "$CEILING" ] && OUTPUT="$("$RUNNER_FILE" "$@" --runtime-mode-ceiling "$CEILING" 2>/dev/null)"; then
  printf 'GOAT_CEILING=applied\\n%s\\n' "$OUTPUT"
else
  recheck_selected_before_use
  OUTPUT="$("$RUNNER_FILE" "$@")"
  printf 'GOAT_CEILING=default\\n%s\\n' "$OUTPUT"
fi
`;

const REMOTE_STOP_SCRIPT = `set -eu
DEFAULT_SERVER_HOME="$HOME/.goat"
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
PID_FILE="$STATE_DIR/pid"
PORT_FILE="$STATE_DIR/port"
MANAGED_FILE="$STATE_DIR/managed"
mkdir -p "$STATE_DIR"
@@GOAT_PROTOCOL_TOKENS@@
@@GOAT_REPLACEMENT_LOCK@@
trap 'release_recovery_lock; release_replacement_lock' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
acquire_replacement_lock || { printf 'Another client is replacing the remote runtime.\\n' >&2; exit 1; }
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
ownership_unverified() {
  printf 'GOAT ownership could not be verified for PID %s; process and ownership files were preserved.\\n' "$REMOTE_PID" >&2
  exit 1
}
@@GOAT_OWNED_IDENTITY@@
if [ "$REMOTE_MANAGED" = managed ] && [ -n "$REMOTE_PID" ]; then
  valid_positive "$REMOTE_PID" || ownership_unverified
  if kill -0 "$REMOTE_PID" 2>/dev/null; then
    verify_owned_identity "$REMOTE_PID" "$REMOTE_PORT" || ownership_unverified
    # Other clients share this server, and its threads outlive any one tunnel:
    # stopping is only safe when the server itself reports no active work.
    STOP_ACTIVITY=unknown
    if [ -x "$STATE_DIR/run-t3.sh" ]; then
      STOP_ACTIVITY="$("$STATE_DIR/run-t3.sh" __ssh-helper activity --port "$REMOTE_PORT" --pid "$REMOTE_PID" --shell 2>/dev/null || true)"
    fi
    if [ "$STOP_ACTIVITY" != idle ]; then
      case "$STOP_ACTIVITY" in busy) ;; *) STOP_ACTIVITY=unknown ;; esac
      printf '{"stopped":false,"activity":"%s"}\\n' "$STOP_ACTIVITY"
      exit 0
    fi
    verify_owned_identity "$REMOTE_PID" "$REMOTE_PORT" || ownership_unverified
    kill "$REMOTE_PID" 2>/dev/null || true
    WAIT_COUNT=0
    while kill -0 "$REMOTE_PID" 2>/dev/null && [ "$WAIT_COUNT" -lt 20 ]; do
      WAIT_COUNT=$((WAIT_COUNT + 1))
      sleep 0.1
    done
    if kill -0 "$REMOTE_PID" 2>/dev/null; then
      printf 'Remote GOAT server with PID %s did not stop within 2 seconds. Its ownership files were kept.\\n' "$REMOTE_PID" >&2
      exit 1
    fi
  fi
elif [ "$REMOTE_MANAGED" != external ] && [ -n "$REMOTE_PID" ]; then
  valid_positive "$REMOTE_PID" || ownership_unverified
  if kill -0 "$REMOTE_PID" 2>/dev/null; then ownership_unverified; fi
fi
rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity"
printf '{"stopped":true}\\n'
`;

const REMOTE_LOG_TAIL_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
LOG_FILE="$STATE_DIR/server.log"
if [ -f "$LOG_FILE" ]; then
  tail -n 80 "$LOG_FILE" 2>/dev/null || true
fi
`;

export class SshInvalidArchiveVersionError extends Schema.TaggedError<SshInvalidArchiveVersionError>()(
  "SshInvalidArchiveVersionError",
  { archiveVersion: Schema.String },
) {
  override get message(): string {
    return `'${this.archiveVersion}' is not an exact GOAT version and cannot name a runtime directory.`;
  }
}

// The version becomes a directory name the runner removes and recreates, so
// it must be one exact SemVer segment: no separators, no `..`, no shell
// metacharacters beyond what SemVer allows.
const EXACT_ARCHIVE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export class SshMissingRunnerError extends Schema.TaggedError<SshMissingRunnerError>()(
  "SshMissingRunnerError",
  {},
) {
  override get message(): string {
    return "A remote goat runner needs an archive version or a node script path.";
  }
}

export function buildRemoteGoatRunnerScript(input?: RemoteGoatRunnerOptions): string {
  const nodeScriptPath = input?.nodeScriptPath?.trim() || "";
  const archiveVersion = input?.archiveVersion?.trim() || "";
  if (nodeScriptPath === "" && archiveVersion === "") {
    throw new SshMissingRunnerError();
  }
  if (archiveVersion !== "" && !EXACT_ARCHIVE_VERSION.test(archiveVersion)) {
    throw new SshInvalidArchiveVersionError({ archiveVersion });
  }
  // Strip the `/v<version>` the helper appends: the script builds URLs itself.
  const releaseBaseUrl = cliReleaseDownloadBaseUrl("", input?.releaseBaseUrl ?? undefined).replace(
    /\/v$/u,
    "",
  );
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_RUNNER_SCRIPT, {
      GOAT_NODE_SCRIPT_PATH: shellSingleQuote(nodeScriptPath),
      GOAT_ARCHIVE_VERSION: shellSingleQuote(archiveVersion),
      GOAT_RELEASE_BASE_URL: shellSingleQuote(releaseBaseUrl),
      GOAT_ARCHIVE_LOCK_WAIT_SECONDS: String(REMOTE_ARCHIVE_LOCK_WAIT_SECONDS),
      GOAT_ARCHIVE_DOWNLOAD_SECONDS: String(REMOTE_ARCHIVE_DOWNLOAD_SECONDS),
      GOAT_ARCHIVE_CHECKSUMS_SECONDS: String(REMOTE_ARCHIVE_CHECKSUMS_SECONDS),
      GOAT_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    }),
  );
}

export function buildRemoteNodeEnvScript(input?: RemoteGoatRunnerOptions): string {
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_NODE_ENV_SCRIPT, {
      GOAT_NODE_ENGINE_RANGE: shellSingleQuote(input?.nodeEngineRange?.trim() || ""),
      GOAT_NODE_ENGINE_CHECK_SCRIPT: stripTrailingNewlines(buildRemoteNodeEngineCheckScript()),
    }),
  );
}

function buildRemoteRunnerSetupScript(
  input: RemoteGoatRunnerOptions | undefined,
  selection: PreparedRemoteRuntime,
  verifyOwnedBeforePublication = false,
): string {
  const preserve = selection.source === "retained";
  return applyScriptPlaceholders(REMOTE_RUNNER_SETUP_SCRIPT, {
    GOAT_OWNING_LAUNCH: verifyOwnedBeforePublication ? "1" : "0",
    GOAT_DRAIN_FORCE: input?.confirmReplacement === true ? "1" : "0",
    GOAT_DRAIN_GRACE_SECONDS: String(
      Math.min(
        Math.max(
          0,
          Math.trunc(input?.replacementGraceSeconds ?? RUNTIME_DRAIN_DEFAULT_GRACE_SECONDS),
        ),
        RUNTIME_DRAIN_MAX_GRACE_SECONDS,
      ),
    ),
    GOAT_REPLACEMENT_LOCK: REMOTE_REPLACEMENT_LOCK_SCRIPT,
    GOAT_REUSE_READY_TIMEOUT_MS: String(REMOTE_REUSE_READY_TIMEOUT_MS),
    GOAT_READY_PROBE_TIMEOUT_MS: String(SSH_READY_PROBE_TIMEOUT_MS),
    GOAT_REQUESTED_RUNNER: shellSingleQuote(
      isNodeScriptRunner(input)
        ? `Node script ${input?.nodeScriptPath?.trim()}`
        : `GOAT ${selection.requestedVersion}`,
    ),
    GOAT_EXPECTED_ARCHIVE_VERSION: shellSingleQuote(selection.version ?? ""),
    GOAT_SELECTED_VERSION: shellSingleQuote(selection.version ?? ""),
    GOAT_REQUESTED_VERSION: shellSingleQuote(selection.requestedVersion ?? ""),
    GOAT_REQUIRE_INSTALLED: selection.requireInstalled ? "1" : "0",
    GOAT_PRESERVE_SELECTED_RUNNER: preserve ? "1" : "0",
    GOAT_ALLOW_OWNED_UPGRADE:
      verifyOwnedBeforePublication && selection.mayUpgradeOwnedServer ? "1" : "0",
    GOAT_ALLOW_LEGACY_ADOPTION:
      verifyOwnedBeforePublication && selection.mayUpgradeOwnedServer && !isNodeScriptRunner(input)
        ? "1"
        : "0",
    GOAT_REFRESH_IF_IDLE:
      verifyOwnedBeforePublication && selection.mayUpgradeOwnedServer && selection.refreshIfIdle
        ? "1"
        : "0",
    GOAT_REFRESH_LIVE_VERSION: shellSingleQuote(selection.expectedLiveVersion ?? ""),
    GOAT_LIVE_RUNNER_SHA256: shellSingleQuote(selection.expectedLiveRunnerSha256 ?? ""),
    GOAT_CAPTURE_RUNNING_RUNNER: verifyOwnedBeforePublication
      ? 'if [ "$ALLOW_LEGACY_ADOPTION" = 1 ] || [ "$REFRESH_IF_IDLE" = 1 ]; then capture_running_runner || ownership_unverified; fi'
      : "",
    GOAT_RETAINED_RUNNER_SHA256: shellSingleQuote(selection.retainedRunnerSha256 ?? ""),
    GOAT_PROTOCOL_TOKENS: REMOTE_PROTOCOL_TOKEN_SCRIPT,
    GOAT_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteGoatRunnerScript(input)),
    GOAT_PROTOCOL_GUARD: applyScriptPlaceholders(REMOTE_PROTOCOL_GUARD_SCRIPT, {
      GOAT_SSH_PROTOCOL: String(SSH_RUNTIME_PROTOCOL_VERSION),
      GOAT_ORCHESTRATION_PROTOCOL: String(ORCHESTRATION_PROTOCOL_VERSION),
    }),
    GOAT_VERIFY_OWNED_BEFORE_PUBLICATION: verifyOwnedBeforePublication
      ? VERIFY_OWNED_BEFORE_PUBLICATION + "\n"
      : "",
    GOAT_RUNNER_INSTALL: preserve ? KEEP_EXISTING_RUNNER_INSTALL : REPLACE_RUNNER_INSTALL,
  });
}

export function buildRemoteLaunchScript(
  input?: RemoteGoatRunnerOptions,
  selection = requestedRuntime(input),
): string {
  return applyScriptPlaceholders(REMOTE_LAUNCH_SCRIPT, {
    GOAT_ARCHIVE_MODE: isNodeScriptRunner(input) ? "0" : "1",
    GOAT_NODE_SCRIPT_PATH: shellSingleQuote(input?.nodeScriptPath?.trim() || ""),
    GOAT_OWNED_IDENTITY: REMOTE_OWNED_IDENTITY_SCRIPT,
    GOAT_LEGACY_IDENTITY: REMOTE_LEGACY_IDENTITY_SCRIPT,
    GOAT_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    GOAT_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, selection, true),
    GOAT_PICK_PORT_SCRIPT: stripTrailingNewlines(REMOTE_PICK_PORT_SCRIPT),
    GOAT_WAIT_READY_SCRIPT: stripTrailingNewlines(REMOTE_WAIT_READY_SCRIPT),
    GOAT_DEFAULT_REMOTE_PORT: String(DEFAULT_REMOTE_PORT),
    GOAT_REMOTE_PORT_SCAN_WINDOW: String(REMOTE_PORT_SCAN_WINDOW),
    GOAT_READY_TIMEOUT_MS: String(REMOTE_READY_TIMEOUT_MS),
    GOAT_REUSE_READY_TIMEOUT_MS: String(REMOTE_REUSE_READY_TIMEOUT_MS),
    GOAT_READY_PROBE_TIMEOUT_MS: String(SSH_READY_PROBE_TIMEOUT_MS),
  });
}

export function buildRemoteMcpSessionScript(
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
    GOAT_EXTRA_SCOPES: options.approvals === true ? "--scope orchestration:approve " : "",
    GOAT_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, {
      ...selection,
      mayUpgradeOwnedServer: false,
    }),
  });
}

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

export function buildRemotePairingScript(
  stateKey: string,
  input?: RemoteGoatRunnerOptions,
  selection = requestedRuntime(input),
): string {
  return applyScriptPlaceholders(REMOTE_PAIRING_SCRIPT, {
    GOAT_STATE_KEY: stateKey,
    GOAT_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, {
      ...selection,
      mayUpgradeOwnedServer: false,
    }),
  });
}

export function buildRemoteGoatUploadInstallerScript(
  input: RemoteGoatRunnerOptions,
  sha256: string,
): string {
  if (
    isNodeScriptRunner(input) ||
    !input.archiveVersion?.trim() ||
    !/^[0-9a-f]{64}$/iu.test(sha256)
  ) {
    throw new SshLaunchError({
      message: "Upload requires an archive version and SHA256 digest.",
      stdout: "",
    });
  }
  const script = buildRemoteGoatRunnerScript(input);
  const startAnchor = '  goat_fetch "$GOAT_RELEASE_BASE_URL/v$GOAT_ARCHIVE_VERSION/SHA256SUMS"';
  const endAnchor = "  if command -v sha256sum >/dev/null 2>&1; then";
  const start = script.indexOf(startAnchor);
  const end = script.indexOf(endAnchor);
  if (
    start < 0 ||
    end <= start ||
    script.indexOf(startAnchor, start + 1) !== -1 ||
    script.indexOf(endAnchor, end + 1) !== -1
  ) {
    throw new SshLaunchError({ message: "acquisition block no longer matches", stdout: "" });
  }
  // Patch a transient copy so preparation never changes the managed runner.
  return (
    script.slice(0, start) +
    '  cp "$GOAT_SSH_UPLOADED_ARCHIVE" "$GOAT_STAGING/$GOAT_ARCHIVE"\n' +
    `  GOAT_EXPECTED='${sha256.toLowerCase()}'\n` +
    script.slice(end)
  );
}

export function buildRemoteUploadScript(input: RemoteGoatRunnerOptions, sha256: string): string {
  const installer = buildRemoteGoatUploadInstallerScript(input, sha256);
  return `set -eu
umask 077
mkdir -p "$HOME/.goat/runtime/goat/versions"
upload_dir="$(mktemp -d "$HOME/.goat/runtime/goat/versions/.upload-XXXXXX")"
trap 'rm -rf "$upload_dir"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$upload_dir/archive.tar.gz"
export GOAT_SSH_UPLOADED_ARCHIVE="$upload_dir/archive.tar.gz"
sh -c ${shellSingleQuote(installer)} -- --version
`;
}

export function buildRemoteRuntimeProbeScript(
  version: string,
  stateKey?: string,
  _keepExistingRunner = false,
): string {
  return `set -eu
V=${shellSingleQuote(version)}
state_key=${shellSingleQuote(stateKey ?? "")}
state="$HOME/.goat/ssh-launch/$state_key"
runtime_file="$HOME/.goat/userdata/server-runtime.json"
${REMOTE_PROTOCOL_TOKEN_SCRIPT}
ready_version() {
  valid_version "$1" && [ -x "$HOME/.goat/runtime/goat/versions/$1/goat" ] &&
    [ "$(cat "$HOME/.goat/runtime/goat/versions/$1/.install-complete" 2>/dev/null)" = "$1" ]
}
signals_json() {
  # Positional parameters are scoped to this function, not the enclosing script.
  version="$1"; ssh="$2"; orch="$3"
  valid_version "$version" || return 1
  fields=
  for pair in "sshRuntimeProtocolVersion:$ssh" "orchestrationProtocolVersion:$orch"; do
    key="\${pair%%:*}"; value="\${pair#*:}"
    if [ "$value" = unknown ]; then continue; fi
    case "$value" in ''|*[!0-9]*) return 1 ;; esac
    valid_positive "$value" || return 1
    fields="$fields,\\"$key\\":$value"
  done
  printf '{"serverVersion":"%s"%s}' "$version" "$fields"
}
binary_json() {
  v="$1"; exe="$HOME/.goat/runtime/goat/versions/$v/goat"
  if ! ready_version "$v" || [ "$("$exe" --version 2>/dev/null || true)" != "goat v$v" ]; then return 1; fi
  if own="$("$exe" __ssh-helper protocol --shell 2>/dev/null)"; then
    set -f; set -- $own
    if ! valid_own_tokens "$@" || [ "$1" != "$v" ]; then printf '{"serverVersion":"%s","invalid":true}' "$v"; return; fi
    if signals="$(signals_json "$1" "$2" "$3")"; then printf '%s' "$signals";
    else printf '{"serverVersion":"%s","invalid":true}' "$v"; fi
  else
    # Exact legacy fallback has independent --version evidence above.
    printf '{"serverVersion":"%s"}' "$v"
  fi
}
${REMOTE_RUNNER_HINT_SCRIPT}
retained_version=
retained_sha256=
if [ -n "$state_key" ] && [ -f "$state/run-t3.sh" ]; then
  retained_sha256="$(runner_sha256 "$state/run-t3.sh")" || exit 1
  node_path="$(read_runner_hint "$state/run-t3.sh" GOAT_NODE_SCRIPT_PATH ${LEGACY_SSH_NODE_SCRIPT_PATH_KEY})"
  if [ -z "$node_path" ]; then
    retained_version="$(read_runner_hint "$state/run-t3.sh" GOAT_ARCHIVE_VERSION ${LEGACY_SSH_ARCHIVE_VERSION_KEY})"
  fi
fi
retained_fields=
if [ -n "$retained_sha256" ]; then
  retained_fields="$(printf ',"retainedRunnerSha256":"%s"' "$retained_sha256")"
fi
if ready_version "$retained_version"; then
  retained_signals="$(binary_json "$retained_version" || true)"
  if [ -n "$retained_signals" ]; then
    [ "$(runner_sha256 "$state/run-t3.sh")" = "$retained_sha256" ] || {
      printf 'Retained GOAT runner changed during probe; reconnect.\\n' >&2; exit 1;
    }
    retained_fields="$(printf ',"retained":"ready","retainedVersion":"%s","retainedSignals":%s,"retainedRunnerSha256":"%s"' "$retained_version" "$retained_signals" "$retained_sha256")"
  fi
fi
# Persisted version is a path hint only. The live descriptor proves identity.
live_hint="$(sed -n 's/.*"serverVersion"[[:space:]]*:[[:space:]]*"\\([^" ]*\\)".*/\\1/p' "$runtime_file" 2>/dev/null || true)"
live_fields=
live_owned=false
identity_absent=false
if [ -n "$state_key" ] && [ ! -e "$state/identity" ] && [ ! -L "$state/identity" ]; then identity_absent=true; fi
for candidate in "$live_hint" "$retained_version" "$V"; do
  if ! ready_version "$candidate"; then continue; fi
  exe="$HOME/.goat/runtime/goat/versions/$candidate/goat"
  if live="$("$exe" __ssh-helper protocol --runtime-file "$runtime_file" --port-file "$state/port" --pid-file "$state/pid" --shell 2>/dev/null)"; then
    set -f; set -- $live
    if ! valid_live_tokens "$@"; then
      printf 'Malformed live GOAT protocol tokens; fix the remote helper and reconnect.\\n' >&2; exit 1
    fi
    live_fields="$(printf ',"liveStatus":"%s"' "$1")"
    if [ "$1" = live ] && valid_positive "$5" &&
       [ "$(cat "$state/managed" 2>/dev/null || true)" = managed ] &&
       [ "$(cat "$state/pid" 2>/dev/null || true)" = "$5" ] &&
       [ "$(cat "$state/port" 2>/dev/null || true)" = "$6" ]; then live_owned=true; fi
    if [ "$1" = live ] && valid_version "$2"; then
      live_version="$2"
      live_signals="$(signals_json "$2" "$3" "$4" || true)"
      live_binary="$(binary_json "$live_version" || true)"
      if [ -n "$live_signals" ]; then
        live_fields="$live_fields$(printf ',"liveVersion":"%s","liveSignals":%s' "$live_version" "$live_signals")"
        if [ -n "$live_binary" ]; then
          live_fields="$live_fields$(printf ',"liveBinarySignals":%s' "$live_binary")"
        fi
      fi
      # Only a server that drains for its own replacement may be replaced; others are attach-only.
      if valid_port "$6" && live_compat="$("$exe" __ssh-helper compat --port "$6" 2>/dev/null)"; then
        set -f; set -- $live_compat
        if [ "$#" = 3 ] && [ "$2" = 1 ]; then live_fields="$live_fields,\\"liveDrain\\":true"; fi
      fi
    fi
    break
  fi
done
case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) exit 1 ;; esac
ready=false
if ready_version "$V"; then ready=true; fi
printf '{"platform":"%s","arch":"%s","ready":%s,"liveOwned":%s,"identityAbsent":%s%s%s}\\n' "$platform" "$arch" "$ready" "$live_owned" "$identity_absent" "$retained_fields" "$live_fields"
`;
}

const decodeRemoteRuntimeProbe = Schema.decodeEffect(
  fromLenientJson(
    Schema.Struct({
      platform: Schema.Literals(["darwin", "linux"]),
      arch: Schema.Literals(["arm64", "x64"]),
      ready: Schema.Boolean,
      retained: Schema.optionalKey(Schema.Literals(["ready", "missing"])),
      retainedVersion: Schema.optionalKey(Schema.String),
      retainedSignals: Schema.optionalKey(RuntimeSignals),
      retainedRunnerSha256: Schema.optionalKey(
        Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      ),
      liveStatus: Schema.optionalKey(Schema.Literals(["none", "live", "unknown"])),
      liveOwned: Schema.optionalKey(Schema.Boolean),
      identityAbsent: Schema.optionalKey(Schema.Boolean),
      liveVersion: Schema.optionalKey(Schema.String),
      liveSignals: Schema.optionalKey(RuntimeSignals),
      liveBinarySignals: Schema.optionalKey(RuntimeSignals),
      /** The live server drains for a replacement. Without it the client only attaches. */
      liveDrain: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);

/**
 * SemVer orders prerelease trains of one core version alphabetically, so
 * `0.1.0-nightly.*` sorts above `0.1.0-dev.*` even when the dev build is newer.
 * Such a pair has no meaningful order, so a compatible runtime from the other
 * train is attached as-is instead of being refreshed.
 */
const releasesOrderable = (left: string, right: string) => {
  const parse = (version: string) => /^([^-+]+)(?:-([0-9A-Za-z-]+))?/.exec(version);
  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null || a[1] !== b[1]) return true;
  return a[2] === undefined || b[2] === undefined || a[2] === b[2];
};

/**
 * SSH failures (an unreachable host, a timeout, rejected authentication) keep their own error
 * and message, so they never read as a missing runtime archive. Anything else is wrapped with
 * its message attached.
 */
const runtimePreparationError = (cause: unknown) =>
  cause instanceof SshLaunchError ||
  cause instanceof SshCommandError ||
  cause instanceof SshInvalidTargetError
    ? cause
    : new SshLaunchError({
        message: `Failed to prepare the SSH runtime archive: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        stdout: "",
        cause,
      });

/** A failure to read or fetch the archive itself: supplying another archive is the remedy. */
const archiveSupplyError = (cause: unknown) => {
  const error = runtimePreparationError(cause);
  return error instanceof SshLaunchError && error.reason === undefined
    ? new SshLaunchError({
        reason: "archive-unavailable",
        message: error.message,
        stdout: error.stdout,
        cause: error.cause,
      })
    : error;
};

export const prepareRemoteRuntime = (
  target: DesktopSshEnvironmentTarget,
  authOptions: SshAuth.SshAuthOptions,
  runner?: RemoteGoatRunnerOptions,
  stateKey?: string,
  owningLaunch = false,
) =>
  Effect.gen(function* () {
    let exact = requestedRuntime(runner);
    if (isNodeScriptRunner(runner)) return exact;
    const directory = runner?.archiveDirectory?.trim() ?? "";
    const bundleDirectory = runner?.bundledArchiveDirectory?.trim() ?? "";
    const mirror = runner?.releaseBaseUrl?.trim() ?? "";
    // Observe a compatible installed runtime before any acquisition, including mirrors.
    const version = runner?.archiveVersion?.trim() ?? "";
    yield* Effect.annotateCurrentSpan({
      "ssh.target": target.alias,
      "t3.runtime.version": version,
    });
    yield* Effect.try({
      try: () => buildRemoteGoatRunnerScript(runner),
      catch: runtimePreparationError,
    });
    const result = yield* runSshCommand(target, {
      ...authOptions,
      remoteCommandArgs: ["sh", "-l", "-s"],
      stdin: buildRemoteRuntimeProbeScript(version, stateKey, runner?.keepExistingRunner ?? false),
    }).pipe(Effect.mapError(runtimePreparationError));
    const probe = yield* decodeRemoteJsonOutput(result.stdout, decodeRemoteRuntimeProbe).pipe(
      Effect.mapError(runtimePreparationError),
    );
    const liveCompatible =
      probe.liveVersion !== undefined &&
      probe.liveSignals !== undefined &&
      probe.liveBinarySignals !== undefined &&
      probe.liveSignals.serverVersion === probe.liveVersion &&
      probe.liveBinarySignals.serverVersion === probe.liveVersion &&
      matchesSignals(probe.liveSignals, version) &&
      matchesSignals(probe.liveBinarySignals, version);
    if (
      owningLaunch &&
      probe.liveVersion !== undefined &&
      !liveCompatible &&
      compareSemverVersions(probe.liveVersion, version) > 0
    ) {
      return yield* new SshLaunchError({
        reason: "runtime-newer",
        message: "Remote runtime is newer than this app; update the app.",
        stdout: "",
      });
    }
    const retainedCompatible =
      probe.liveStatus === "none" &&
      probe.retained === "ready" &&
      probe.retainedVersion !== undefined &&
      probe.retainedSignals !== undefined &&
      probe.retainedRunnerSha256 !== undefined &&
      probe.retainedSignals.serverVersion === probe.retainedVersion &&
      matchesSignals(probe.retainedSignals, version);
    // No server runs, so no thread can be interrupted: an owning client installs
    // its own release instead of restarting an older retained one. It keeps the
    // retained runtime only when that one is newer, or when the requested
    // archive cannot be acquired (handled below, with the reason logged).
    const upgradeRetained =
      owningLaunch &&
      exact.mayUpgradeOwnedServer &&
      retainedCompatible &&
      probe.retainedVersion !== undefined &&
      probe.retainedVersion !== version &&
      !(
        releasesOrderable(probe.retainedVersion, version) &&
        compareSemverVersions(probe.retainedVersion, version) > 0
      );
    const adoptLegacy =
      owningLaunch &&
      exact.mayUpgradeOwnedServer &&
      probe.liveDrain === true &&
      probe.identityAbsent === true &&
      !(
        liveCompatible &&
        probe.liveVersion !== undefined &&
        compareSemverVersions(probe.liveVersion, version) > 0
      ) &&
      (probe.liveStatus === "unknown" || (probe.liveStatus === "live" && probe.liveOwned === true));
    const refreshIfIdle =
      owningLaunch &&
      exact.mayUpgradeOwnedServer &&
      runner?.refreshOwnedRuntimeOnFirstConnection === true &&
      probe.liveDrain === true &&
      liveCompatible &&
      probe.liveOwned === true &&
      probe.identityAbsent !== true &&
      probe.liveVersion !== undefined &&
      releasesOrderable(probe.liveVersion, version) &&
      compareSemverVersions(probe.liveVersion, version) < 0;
    if (adoptLegacy || refreshIfIdle) {
      exact = {
        ...exact,
        ...(refreshIfIdle ? { refreshIfIdle: true, expectedLiveVersion: probe.liveVersion } : {}),
        ...(probe.retainedRunnerSha256 === undefined
          ? {}
          : { expectedLiveRunnerSha256: probe.retainedRunnerSha256 }),
      };
    }
    const selectedVersion =
      liveCompatible && !adoptLegacy && !refreshIfIdle
        ? probe.liveVersion
        : retainedCompatible && !upgradeRetained
          ? probe.retainedVersion
          : undefined;
    const selectInstalled = (selectedVersion: string) => {
      const retained =
        selectedVersion === probe.retainedVersion &&
        probe.retainedSignals !== undefined &&
        probe.retainedSignals.serverVersion === selectedVersion &&
        matchesSignals(probe.retainedSignals, version) &&
        probe.retainedRunnerSha256 !== undefined;
      return Effect.annotateCurrentSpan(
        "t3.runtime.source",
        retained ? "retained-runner" : "live-runtime",
      ).pipe(
        Effect.as({
          ...exact,
          version: selectedVersion,
          source: retained ? "retained" : "live",
          requireInstalled: true,
          runner: { ...runner, archiveVersion: selectedVersion },
          retainedRunnerSha256: retained ? (probe.retainedRunnerSha256 ?? null) : null,
        } satisfies PreparedRemoteRuntime),
      );
    };
    // Install the requested release: already present, bundled, cached, or downloaded.
    const acquireRequested = Effect.gen(function* () {
      if (probe.ready) {
        yield* Effect.annotateCurrentSpan("t3.runtime.source", "ready");
        return { ...exact, requireInstalled: true };
      }
      const platformKey = cliArchivePlatformKey(probe.platform, probe.arch);
      if (platformKey === undefined) {
        if (mirror !== "") {
          yield* Effect.annotateCurrentSpan("t3.runtime.source", "download");
          return exact;
        }
        const asset =
          platformKey === undefined
            ? `unsupported-${probe.platform}-${probe.arch}`
            : cliArchiveFileName(version, platformKey);
        return yield* new SshLaunchError({
          reason: "archive-unavailable",
          message: `Cannot acquire the SSH runtime archive (repo=${CLI_RELEASE_REPOSITORY}, tag=v${version}, asset=${asset}, archive directory=${directory || "<not configured>"}). Configure a local archive directory and use a supported SSH platform, or an explicit release mirror.`,
          stdout: "",
        });
      }
      const bundledArchive =
        bundleDirectory === ""
          ? null
          : yield* readLocalRuntimeArchive(bundleDirectory, version, platformKey, true).pipe(
              Effect.mapError(archiveSupplyError),
            );
      const localArchive =
        bundledArchive !== null || directory === ""
          ? null
          : yield* readLocalRuntimeArchive(directory, version, platformKey).pipe(
              Effect.mapError(archiveSupplyError),
            );
      if (bundledArchive === null && localArchive === null && mirror !== "") {
        yield* Effect.annotateCurrentSpan("t3.runtime.source", "download");
        return exact;
      }
      if (bundledArchive === null && localArchive === null) {
        const path = yield* Path.Path;
        if (
          directory === "" ||
          (bundleDirectory !== "" && path.resolve(directory) === path.resolve(bundleDirectory))
        ) {
          return yield* new SshLaunchError({
            reason: "archive-unavailable",
            message: `Cannot acquire ${cliArchiveFileName(version, platformKey)} for ${target.alias}: no writable user archive cache distinct from the bundle (${directory || "<not configured>"}). Configure archiveDirectory for ${CLI_RELEASE_REPOSITORY} release v${version} or rebuild the packaged archives.`,
            stdout: "",
          });
        }
      }
      const archive =
        bundledArchive ??
        localArchive ??
        (yield* downloadRuntimeArchiveWithHttps(directory, version, platformKey).pipe(
          Effect.catchTags({
            RuntimeArchiveNotPublished: () =>
              downloadRuntimeArchiveWithGh(directory, version, platformKey, runner?.ghCommand).pipe(
                Effect.mapError(
                  (cause) =>
                    new SshLaunchError({
                      reason: "archive-unavailable",
                      message: `Public HTTPS release is not published and local gh acquisition failed: ${cause.message}`,
                      stdout: "",
                      cause,
                    }),
                ),
              ),
            RuntimeArchiveNetworkError: () =>
              downloadRuntimeArchiveWithGh(directory, version, platformKey, runner?.ghCommand).pipe(
                Effect.mapError(
                  (cause) =>
                    new SshLaunchError({
                      reason: "archive-unavailable",
                      message: `Public HTTPS release download failed and local gh acquisition failed: ${cause.message}`,
                      stdout: "",
                      cause,
                    }),
                ),
              ),
          }),
          Effect.mapError(archiveSupplyError),
        ));
      yield* Effect.annotateCurrentSpan(
        "t3.runtime.acquisition",
        bundledArchive !== null ? "bundle" : localArchive !== null ? "cache" : "https-or-gh",
      );
      yield* Effect.annotateCurrentSpan({
        "t3.runtime.source": "upload",
        "t3.runtime.upload.bytes": archive.bytes.byteLength,
        "t3.runtime.upload.sha256": archive.sha256,
        "t3.runtime.upload.installComplete": false,
      });
      const script = yield* Effect.try({
        try: () => buildRemoteUploadScript({ ...runner, archiveVersion: version }, archive.sha256),
        catch: runtimePreparationError,
      });
      yield* runSshCommand(target, {
        ...authOptions,
        remoteCommandArgs: ["sh", "-c", shellSingleQuote(script)],
        stdin: archive.bytes,
        timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
      }).pipe(
        // A remote reader that exits early (full disk, failed checksum) fails only
        // this upload, with the remote's own reason. A connection failure or timeout
        // stays an SshCommandError that names the host.
        Effect.catchTags({
          SshCommandError: (error) =>
            error.exitCode === null || error.exitCode === 255
              ? Effect.fail(error)
              : Effect.fail(
                  new SshLaunchError({
                    message: `Uploading the runtime archive failed (exit ${error.exitCode}): ${error.message}`,
                    stdout: error.stdout ?? "",
                    cause: error,
                  }),
                ),
        }),
      );
      yield* Effect.annotateCurrentSpan("t3.runtime.upload.installComplete", true);
      return { ...exact, requireInstalled: true };
    });
    if (selectedVersion !== undefined) return yield* selectInstalled(selectedVersion);
    if (upgradeRetained && probe.retainedVersion !== undefined) {
      const retainedVersion = probe.retainedVersion;
      yield* Effect.logInfo("ssh.runtime.upgrade.start", {
        ...sshTargetLogFields(target),
        installedVersion: retainedVersion,
        requestedVersion: version,
      });
      return yield* acquireRequested.pipe(
        Effect.catchTags({
          SshLaunchError: (error) =>
            Effect.logWarning("ssh.runtime.upgrade.skipped", {
              ...sshTargetLogFields(target),
              installedVersion: retainedVersion,
              requestedVersion: version,
              reason: `GOAT ${version} could not be installed, so the installed ${retainedVersion} starts instead: ${error.message}`,
            }).pipe(Effect.andThen(selectInstalled(retainedVersion))),
        }),
      );
    }
    return yield* acquireRequested;
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SshLaunchError
        ? new SshLaunchError({
            message: `Cannot prepare GOAT ${runner?.archiveVersion?.trim() || "(node-script runner)"} on ${target.alias}: ${error.message} The existing runner and server have been left unchanged.${
              error.reason === "archive-unavailable"
                ? " Supply the requested runtime archive in the local SSH runtime archive directory or a release mirror, then retry."
                : ""
            }`,
            stdout: error.stdout,
            ...(error.reason === undefined ? {} : { reason: error.reason }),
            cause: error,
          })
        : error,
    ),
    Effect.withSpan("ssh.prepareRemoteRuntime"),
  );

export function buildRemoteStopScript(stateKey: string): string {
  return applyScriptPlaceholders(REMOTE_STOP_SCRIPT, {
    GOAT_STATE_KEY: stateKey,
    GOAT_PROTOCOL_TOKENS: REMOTE_PROTOCOL_TOKEN_SCRIPT,
    GOAT_REPLACEMENT_LOCK: REMOTE_REPLACEMENT_LOCK_SCRIPT,
    GOAT_OWNED_IDENTITY: REMOTE_OWNED_IDENTITY_SCRIPT,
  });
}

function buildRemoteLogTailScript(stateKey: string): string {
  return applyScriptPlaceholders(REMOTE_LOG_TAIL_SCRIPT, {
    GOAT_STATE_KEY: stateKey,
  });
}

export const launchOrReuseRemoteServer = Effect.fn("ssh/tunnel.launchOrReuseRemoteServer")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input?: SshAuth.SshAuthOptions,
    runner?: RemoteGoatRunnerOptions,
  ): Effect.fn.Return<
    | {
        readonly status: "ready";
        readonly remotePort: number;
        readonly remoteServerKind: "external" | "managed" | null;
        readonly selectedRuntime: PreparedRemoteRuntime;
        readonly refresh?: "replaced";
        readonly pending?: SshRuntimePendingReplacement;
      }
    | { readonly status: "pending"; readonly pending: SshRuntimePendingReplacement },
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  > {
    const stateKey = REMOTE_RUNTIME_STATE_KEY;
    yield* Effect.logInfo("ssh.remoteServer.launch.start", {
      ...sshTargetLogFields(target),
      ...sshRunnerLogFields(runner),
      stateKey,
    });
    const selected = yield* prepareRemoteRuntime(target, input ?? {}, runner, stateKey, true);
    yield* Effect.annotateCurrentSpan("t3.runtime.selectedVersion", selected.version);
    yield* Effect.annotateCurrentSpan("t3.runtime.requestedVersion", selected.requestedVersion);
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-l", "-s", "--", stateKey],
      stdin: buildRemoteLaunchScript(selected.runner, selected),
      timeoutMs: isNodeScriptRunner(selected.runner)
        ? REMOTE_LAUNCH_TIMEOUT_MS
        : REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
      ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
      ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    });
    if (!getLastNonEmptyOutputLine(result.stdout)) {
      return yield* new SshLaunchError({
        message: "SSH launch did not return a remote port.",
        stdout: result.stdout,
      });
    }
    const parsed = yield* decodeRemoteLaunchOutput(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new SshLaunchError({
            message: "SSH launch returned unparseable output.",
            stdout: result.stdout,
            cause,
          }),
      ),
    );
    if (parsed.status === "pending") return parsed;
    if (!Number.isInteger(parsed.remotePort)) {
      return yield* new SshLaunchError({
        message: `SSH launch returned an invalid remote port: ${String(parsed.remotePort)}.`,
        stdout: result.stdout,
      });
    }
    yield* Effect.logInfo("ssh.remoteServer.launch.ready", {
      ...sshTargetLogFields(target),
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
      selectedVersion: parsed.selectedVersion ?? selected.version,
      requestedVersion: selected.requestedVersion,
      refresh: parsed.refresh ?? null,
      stateKey,
    });
    const reusedVersion = parsed.selectedVersion;
    const cachedSelection: PreparedRemoteRuntime =
      reusedVersion === selected.version || isNodeScriptRunner(selected.runner)
        ? selected
        : {
            ...selected,
            version: reusedVersion,
            source: parsed.pending === undefined ? "live" : "retained",
            runner: {
              ...selected.runner,
              archiveVersion: reusedVersion,
              refreshOwnedRuntimeOnFirstConnection: false,
            },
            retainedRunnerSha256: selected.expectedLiveRunnerSha256 ?? null,
            refreshIfIdle: false,
          };
    const durableSelection = { ...cachedSelection };
    delete durableSelection.refreshIfIdle;
    delete durableSelection.expectedLiveVersion;
    delete durableSelection.expectedLiveRunnerSha256;
    return {
      status: "ready",
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
      selectedRuntime: {
        ...durableSelection,
        requireInstalled: !isNodeScriptRunner(selected.runner),
      },
      ...(parsed.refresh === undefined ? {} : { refresh: parsed.refresh }),
      ...(parsed.pending === undefined ? {} : { pending: parsed.pending }),
    };
  },
);

export const issueRemotePairingToken = Effect.fn("ssh/tunnel.issueRemotePairingToken")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuth.SshAuthOptions,
  runner?: RemoteGoatRunnerOptions,
  prepared?: PreparedRemoteRuntime,
): Effect.fn.Return<
  {
    readonly credential: string;
  },
  SshCommandError | SshInvalidTargetError | SshPairingError | SshLaunchError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const stateKey = REMOTE_RUNTIME_STATE_KEY;
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.start", {
    ...sshTargetLogFields(target),
    stateKey,
  });
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
    stdin: buildRemotePairingScript(stateKey, selected.runner, {
      ...selected,
      mayUpgradeOwnedServer: false,
    }),
    // Pairing may be the first command on a cold remote, so it can install
    // the archive on the way.
    ...(isNodeScriptRunner(selected.runner) ? {} : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  if (!getLastNonEmptyOutputLine(result.stdout)) {
    return yield* new SshPairingError({
      message: "SSH pairing did not return a credential.",
      stdout: result.stdout,
    });
  }
  const parsed = yield* decodeRemotePairingOutput(result.stdout).pipe(
    Effect.mapError(
      (cause) =>
        new SshPairingError({
          message: "SSH pairing returned unparseable output.",
          stdout: result.stdout,
          cause,
        }),
    ),
  );
  if (parsed.credential.trim().length === 0) {
    return yield* new SshPairingError({
      message: "SSH pairing command returned an invalid credential.",
      stdout: result.stdout,
    });
  }
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.created", {
    selectedVersion: selected.version,
    requestedVersion: selected.requestedVersion,
    source: selected.source,
    ...sshTargetLogFields(target),
    stateKey,
  });
  return {
    credential: parsed.credential,
  };
});

export const issueRemoteMcpClientSession = Effect.fn("ssh/tunnel.issueRemoteMcpClientSession")(
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
    });
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

const stopRemoteServer = Effect.fn("ssh/tunnel.stopRemoteServer")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuth.SshAuthOptions,
): Effect.fn.Return<
  void,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const stateKey = REMOTE_RUNTIME_STATE_KEY;
  yield* Effect.logInfo("ssh.remoteServer.stop.start", {
    ...sshTargetLogFields(target),
    stateKey,
  });
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteStopScript(stateKey),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  }).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("ssh.remoteServer.stop.failed", {
        ...sshTargetLogFields(target),
        stateKey,
        message: cause.message,
      }),
    ),
  );
  const preserved = /"stopped":false,"activity":"(busy|unknown)"/.exec(result.stdout)?.[1];
  if (preserved !== undefined) {
    yield* Effect.logInfo("ssh.remoteServer.stop.preserved", {
      ...sshTargetLogFields(target),
      stateKey,
      activity: preserved,
    });
    return;
  }
  yield* Effect.logInfo("ssh.remoteServer.stop.succeeded", {
    ...sshTargetLogFields(target),
    stateKey,
  });
});

const readRemoteServerLogTail = Effect.fn("ssh/tunnel.readRemoteServerLogTail")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuth.SshAuthOptions,
): Effect.fn.Return<
  string,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteLogTailScript(REMOTE_RUNTIME_STATE_KEY),
    timeoutMs: 10_000,
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  return result.stdout.trim();
});

export const waitForHttpReady = (input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly path?: string;
}): Effect.Effect<void, SshReadinessError, HttpClient.HttpClient> =>
  waitForHttpReadyShared({
    baseUrl: input.baseUrl,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    probeTimeoutMs: input.probeTimeoutMs ?? SSH_READY_PROBE_TIMEOUT_MS,
    makeError: ({ requestUrl, probeTimeoutMs, cause }) => {
      if (typeof cause === "object" && cause !== null && "kind" in cause) {
        const kind = (cause as { readonly kind?: unknown }).kind;
        if (kind === "probe-timeout") {
          return new SshReadinessError({
            message: `Backend readiness probe exceeded ${probeTimeoutMs}ms at ${requestUrl}.`,
            cause,
          });
        }
        if (kind === "overall-timeout") {
          const overall = cause as unknown as {
            readonly baseUrl: string;
            readonly timeoutMs: number;
            readonly lastFailure: unknown;
          };
          return new SshReadinessError({
            message: `Timed out waiting ${overall.timeoutMs}ms for backend readiness at ${overall.baseUrl}.`,
            cause: overall.lastFailure,
          });
        }
      }
      return new SshReadinessError({
        message: `Backend readiness probe failed at ${requestUrl}.`,
        cause,
      });
    },
  });

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export const resolveLoopbackSshHttpBaseUrl = Effect.fn("ssh/tunnel.resolveLoopbackSshHttpBaseUrl")(
  function* (rawHttpBaseUrl: unknown): Effect.fn.Return<string, SshHttpBridgeError> {
    return yield* Effect.try({
      try: () => {
        if (typeof rawHttpBaseUrl !== "string" || rawHttpBaseUrl.trim().length === 0) {
          throw new Error("Invalid SSH forwarded http base URL.");
        }
        const baseUrl = new URL(rawHttpBaseUrl);
        if (!isLoopbackHostname(baseUrl.hostname)) {
          throw new Error("SSH desktop bridge only supports loopback forwarded URLs.");
        }
        return baseUrl.toString();
      },
      catch: (cause) =>
        new SshHttpBridgeError({
          message: cause instanceof Error ? cause.message : "Invalid SSH forwarded http base URL.",
          cause,
        }),
    });
  },
);

const reserveLocalTunnelPort = Effect.fn("ssh/tunnel.reserveLocalTunnelPort")(function* () {
  const net = yield* NetService.NetService;
  return yield* net.reserveLoopbackPort();
});

const startSshTunnel = Effect.fn("ssh/tunnel.startSshTunnel")(function* (input: {
  readonly selectedRuntime: PreparedRemoteRuntime;
  readonly key: string;
  readonly resolvedTarget: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly authOptions: SshAuth.SshAuthOptions;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly scope: Scope.Closeable;
}): Effect.fn.Return<
  SshTunnelEntry,
  SshCommandError | SshInvalidTargetError | SshReadinessError,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
> {
  const hostSpec = yield* buildSshHostSpecEffect(input.resolvedTarget);
  const childEnvironment = yield* SshAuth.buildSshChildEnvironment({
    ...(input.authOptions.authSecret === undefined
      ? {}
      : { authSecret: input.authOptions.authSecret }),
    ...(input.authOptions.interactiveAuth === undefined
      ? {}
      : { interactiveAuth: input.authOptions.interactiveAuth }),
  }).pipe(
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
  const args = [
    ...baseSshArgs(input.resolvedTarget, {
      batchMode: input.authOptions.batchMode ?? "no",
    }),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-n",
    "-N",
    "-L",
    `${input.localPort}:127.0.0.1:${input.remotePort}`,
    hostSpec,
  ];
  const sshCommand = yield* resolveSshCommand;
  const tunnelCommand = [sshCommand, ...args];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { scope } = input;
  yield* Effect.logDebug("ssh.tunnel.spawn.start", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    localPort: input.localPort,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    httpBaseUrl: input.httpBaseUrl,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(sshCommand, args, {
        env: childEnvironment,
        extendEnv: true,
        stdin: {
          stream: Stream.empty,
          endOnDone: true,
        },
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: tunnelCommand,
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH tunnel for ${input.resolvedTarget.alias}.`,
            cause,
          }),
      ),
    );
  yield* Effect.logDebug("ssh.tunnel.spawn.succeeded", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    pid: child.pid,
    localPort: input.localPort,
    remotePort: input.remotePort,
    httpBaseUrl: input.httpBaseUrl,
  });
  const tunnelEntry: SshTunnelEntry = {
    selectedRuntime: input.selectedRuntime,
    key: input.key,
    target: input.resolvedTarget,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    localPort: input.localPort,
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.wsBaseUrl,
    process: child,
    scope,
  };
  const exitFailure = Effect.all(
    [collectProcessOutput(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: tunnelCommand,
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error
              ? cause.message
              : `Failed to monitor SSH tunnel for ${input.resolvedTarget.alias}.`,
          cause,
        }),
    ),
    Effect.flatMap(([stderr, exitCode]) => {
      const error = new SshCommandError({
        command: tunnelCommand,
        exitCode,
        stderr,
        message: normalizeSshErrorMessage(
          stderr,
          `SSH tunnel exited unexpectedly for ${input.resolvedTarget.alias} (exit ${exitCode}).`,
        ),
      });
      return Effect.logWarning("ssh.tunnel.process.exited", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
        exitCode,
        stderr,
      }).pipe(Effect.andThen(Effect.fail(error)));
    }),
  );
  yield* Effect.raceFirst(
    waitForHttpReady({
      baseUrl: input.httpBaseUrl,
      timeoutMs: SSH_READY_TIMEOUT_MS,
    }),
    exitFailure,
  ).pipe(
    Effect.tap(() =>
      Effect.logInfo("ssh.tunnel.ready", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
      }),
    ),
    Effect.tapError((cause) =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const processRunningExit = yield* Effect.exit(child.isRunning);
        const localPortAvailableExit = yield* Effect.exit(
          net.canListenOnHost(input.localPort, "127.0.0.1"),
        );
        const remoteLogTailExit = yield* Effect.exit(
          readRemoteServerLogTail(input.resolvedTarget, input.authOptions),
        );
        const processRunning = Exit.isSuccess(processRunningExit) ? processRunningExit.value : null;
        const localPortAvailable = Exit.isSuccess(localPortAvailableExit)
          ? localPortAvailableExit.value
          : null;
        const remoteLogTail = Exit.isSuccess(remoteLogTailExit)
          ? remoteLogTailExit.value || null
          : null;
        yield* Effect.logWarning("ssh.tunnel.ready.failed", {
          ...sshTargetLogFields(input.resolvedTarget),
          command: tunnelCommand,
          pid: child.pid,
          processRunning,
          ...(Exit.isSuccess(processRunningExit)
            ? {}
            : { processRunningError: processRunningExit.cause }),
          localPort: input.localPort,
          localPortListening: localPortAvailable === null ? null : !localPortAvailable,
          remotePort: input.remotePort,
          httpBaseUrl: input.httpBaseUrl,
          ...(Exit.isSuccess(localPortAvailableExit)
            ? {}
            : { localPortProbeError: localPortAvailableExit.cause }),
          ...(remoteLogTail === null ? {} : { remoteLogTail }),
          ...(Exit.isSuccess(remoteLogTailExit)
            ? {}
            : { remoteLogTailError: remoteLogTailExit.cause }),
          cause,
        });
      }),
    ),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : child
            .kill({
              killSignal: "SIGTERM",
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            })
            .pipe(Effect.ignore),
    ),
  );
  return tunnelEntry;
});

const makeSshEnvironmentManager = Effect.fn("ssh/tunnel.SshEnvironmentManager.make")(function* (
  options: SshEnvironmentManagerOptions = {},
): Effect.fn.Return<SshEnvironmentManagerShape, never, Scope.Scope> {
  const managerScope = yield* Scope.Scope;
  const tunnels = new Map<string, SshTunnelEntry>();
  const firstConnectionDecisions = new Set<string>();
  const generations = new Map<string, number>();
  const resolvedTargets = new Map<string, DesktopSshEnvironmentTarget>();
  // A disconnect waits on the target lock, then acts on the completed launch result.
  const cancelledLaunches = new Map<string, boolean>();
  const pendingReplacements = new Map<
    string,
    {
      target: DesktopSshEnvironmentTarget;
      requestedRunner: RemoteGoatRunnerOptions;
      pending: SshRuntimePendingReplacement;
      generation: number;
      nextAttemptAt: number;
    }
  >();
  let retryStarted = false;
  let closed = false;
  const pendingResult = (
    target: DesktopSshEnvironmentTarget,
    pending: SshRuntimePendingReplacement,
  ): DesktopSshRuntimePendingResult => ({
    type: "ssh-runtime-pending",
    target,
    pending,
  });
  const targetLocks = yield* KeyedLock.make<string>();
  const authSecrets = new Map<string, string>();
  // Ensure and disconnect requests for one target are ordered by arrival. Both
  // resolve the alias before taking the target lock, so a reconnect sent after a
  // disconnect can reach the lock first. Tickets let each request see whether a
  // newer one has replaced its intent: a disconnect yields to any newer request,
  // and an ensure yields to a newer disconnect.
  let requestSequence = 0;
  const latestRequest = new Map<string, number>();
  const latestDisconnect = new Map<string, number>();
  interface RequestTicket {
    readonly key: string;
    readonly sequence: number;
  }
  const takeRequestTicket = (target: DesktopSshEnvironmentTarget, kind: "ensure" | "disconnect") =>
    Effect.sync((): RequestTicket => {
      const key = targetConnectionKey(target);
      const sequence = ++requestSequence;
      latestRequest.set(key, sequence);
      if (kind === "disconnect") latestDisconnect.set(key, sequence);
      return { key, sequence };
    });
  const disconnectSuperseded = (ticket: RequestTicket) =>
    latestRequest.get(ticket.key) !== ticket.sequence;
  const ensureSuperseded = (ticket: RequestTicket) =>
    (latestDisconnect.get(ticket.key) ?? 0) > ticket.sequence;

  // Keep one lock per target so reconnect cannot reuse a server while stop is pending.
  const withTargetLock = Effect.fn("ssh/tunnel.withTargetLock")(function* <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E, R> {
    return yield* targetLocks.withLock(key, effect);
  });

  const closeTunnelEntry = Effect.fn("ssh/tunnel.closeTunnelEntry")(function* (
    entry: SshTunnelEntry,
  ) {
    yield* Effect.logDebug("ssh.tunnel.close.start", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
    yield* Effect.logInfo("ssh.tunnel.close.succeeded", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
  });

  yield* Scope.addFinalizer(
    managerScope,
    Effect.sync(() => {
      closed = true;
      resolvedTargets.clear();
      cancelledLaunches.clear();
      // Pending shutdown only closes local forwards; the remote may still be working.
      const entries = [...tunnels.values()];
      for (const key of pendingReplacements.keys()) tunnels.delete(key);
      pendingReplacements.clear();
      return entries;
    }).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, closeTunnelEntry, { concurrency: "unbounded" }),
      ),
      Effect.ignore,
    ),
  );

  const promptForPassword = Effect.fn("ssh/tunnel.promptForPassword")(function* (
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Effect.fn.Return<
    string,
    SshInvalidTargetError | SshPasswordPromptError,
    SshAuth.SshPasswordPrompt
  > {
    const promptService = yield* SshAuth.SshPasswordPrompt;
    const hostSpec = yield* buildSshHostSpecEffect(target);
    if (!promptService.isAvailable) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.unavailable", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication failed for ${hostSpec}.`,
      });
    }

    yield* Effect.logInfo("ssh.auth.passwordPrompt.request", {
      ...sshTargetLogFields(target),
      attempt,
    });
    const password = yield* promptService.request({
      attempt,
      destination: target.alias.trim() || target.hostname.trim(),
      username: target.username,
      prompt: `Enter the SSH password for ${hostSpec}.`,
    });
    if (password === null) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.cancelled", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication cancelled for ${hostSpec}.`,
      });
    }
    yield* Effect.logInfo("ssh.auth.passwordPrompt.received", {
      ...sshTargetLogFields(target),
      attempt,
    });
    return password;
  });

  const handleSshAuthFailure = Effect.fn("ssh/tunnel.runWithSshAuthAttempt.handleFailure")(
    function* <T>(
      input: SshAuthAttemptInput<T> & {
        readonly error: SshEnvironmentEffectError;
      },
    ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
      if (!SshAuth.isSshAuthFailure(input.error)) {
        return yield* input.error;
      }

      if (input.keyOnly === true) {
        return yield* new SshPasswordPromptError({
          message: `Key-based login failed for ${input.target.alias || input.target.hostname}; agents use only SSH keys or ssh-agent.`,
          cause: input.error,
        });
      }

      yield* Effect.logWarning("ssh.auth.failed", {
        ...sshTargetLogFields(input.target),
        key: input.key,
        promptCount: input.promptCount,
        cause: input.error,
      });
      const promptService = yield* SshAuth.SshPasswordPrompt;
      if (!promptService.isAvailable) {
        return yield* input.error;
      }
      if (input.authSecret !== null) {
        authSecrets.delete(input.key);
      }
      if (input.promptCount >= 2) {
        return yield* input.error;
      }

      const nextPromptCount = input.promptCount + 1;
      const nextAuthSecret = yield* promptForPassword(input.target, nextPromptCount);
      authSecrets.set(input.key, nextAuthSecret);
      return yield* runWithSshAuthAttempt({
        ...input,
        promptCount: nextPromptCount,
        authSecret: nextAuthSecret,
      });
    },
  );

  const runWithSshAuthAttempt = Effect.fn("ssh/tunnel.runWithSshAuthAttempt")(function* <T>(
    input: SshAuthAttemptInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const promptService = yield* SshAuth.SshPasswordPrompt;
    const authOptions =
      input.keyOnly === true
        ? { batchMode: "yes" as const, interactiveAuth: false }
        : input.authSecret === null
          ? {
              batchMode: promptService.isAvailable ? ("yes" as const) : ("no" as const),
              interactiveAuth: !promptService.isAvailable,
            }
          : {
              authSecret: input.authSecret,
              batchMode: "no" as const,
              interactiveAuth: true,
            };

    return yield* input
      .operation(authOptions)
      .pipe(Effect.catch((error) => handleSshAuthFailure({ ...input, error })));
  });

  const runWithSshAuth = Effect.fn("ssh/tunnel.runWithSshAuth")(function* <T>(
    input: SshAuthOperationInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    return yield* runWithSshAuthAttempt({
      ...input,
      promptCount: 0,
      authSecret: input.keyOnly === true ? null : (authSecrets.get(input.key) ?? null),
    });
  });

  const backgroundAuth = (key: string): SshAuth.SshAuthOptions => {
    const authSecret = authSecrets.get(key);
    return authSecret === undefined
      ? { batchMode: "yes", interactiveAuth: false }
      : { authSecret, batchMode: "no", interactiveAuth: true };
  };

  const createTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry.create")(function* (input: {
    readonly key: string;
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly keyOnly?: boolean;
    readonly runner?: RemoteGoatRunnerOptions;
    readonly previous?: SshTunnelEntry;
    readonly previousLocalPort?: number;
    readonly background?: boolean;
  }): Effect.fn.Return<
    SshTunnelEntry | DesktopSshRuntimePendingResult,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    yield* Effect.logDebug("ssh.environment.tunnel.create.start", {
      ...sshTargetLogFields(input.resolvedTarget),
      ...sshRunnerLogFields(input.runner),
      key: input.key,
    });
    const generation = generations.get(input.key) ?? 0;
    // Only an observed remote pending result grants background replacement intent.
    const operation = (authOptions: SshAuth.SshAuthOptions) =>
      launchOrReuseRemoteServer(input.resolvedTarget, authOptions, input.runner);
    const remoteLaunch = yield* (
      input.background
        ? operation(backgroundAuth(input.key))
        : runWithSshAuth({
            key: input.key,
            keyOnly: input.keyOnly === true,
            target: input.resolvedTarget,
            operation,
          })
    ).pipe(
      Effect.catchTags({
        SshLaunchError: (error) => {
          if (error.reason === "runtime-newer") pendingReplacements.delete(input.key);
          return Effect.fail(error);
        },
        SshCommandError: (error) => {
          // A newer runtime appearing after preparation is refused by the pinned helper's shell guard.
          if (error.stderr.includes("Remote runtime is newer than this app; update the app."))
            pendingReplacements.delete(input.key);
          return Effect.fail(error);
        },
      }),
    );
    if (closed || (generations.get(input.key) ?? 0) !== generation) {
      const stop = remoteLaunch.status === "ready" && remoteLaunch.pending === undefined;
      if (closed) {
        if (stop && options.leaveRemoteServerRunning !== true)
          yield* stopRemoteServer(input.resolvedTarget, backgroundAuth(input.key)).pipe(
            Effect.ignore,
            Effect.uninterruptible,
          );
      } else cancelledLaunches.set(input.key, stop);
      return yield* new SshLaunchError({ message: "SSH connection was cancelled.", stdout: "" });
    }
    if (remoteLaunch.pending !== undefined && input.runner !== undefined) {
      // The host keeps its current runtime for now; say why instead of pinning it silently.
      yield* Effect.logWarning("ssh.runtime.refresh.deferred", {
        ...sshTargetLogFields(input.resolvedTarget),
        liveVersion: remoteLaunch.pending.liveVersion,
        requestedVersion: remoteLaunch.pending.requestedVersion,
        reason: remoteLaunch.pending.reason,
        replacement: remoteLaunch.pending.replacement,
        retryInMinutes: 10,
      });
      pendingReplacements.set(input.key, {
        target: input.resolvedTarget,
        requestedRunner: input.runner,
        pending: remoteLaunch.pending,
        generation,
        nextAttemptAt: (yield* Clock.currentTimeMillis) + 600_000,
      });
    }
    if (remoteLaunch.status === "pending")
      return pendingResult(input.resolvedTarget, remoteLaunch.pending);
    if (
      input.previous !== undefined &&
      remoteLaunch.refresh !== "replaced" &&
      input.previous.remotePort === remoteLaunch.remotePort &&
      input.previous.selectedRuntime.version === remoteLaunch.selectedRuntime.version
    ) {
      if (remoteLaunch.pending === undefined) pendingReplacements.delete(input.key);
      return input.previous;
    }
    if (input.previous !== undefined) {
      const previous = input.previous;
      // Remove ownership before scope closure so the old finalizer cannot stop the successor.
      yield* Effect.gen(function* () {
        tunnels.delete(input.key);
        yield* closeTunnelEntry(previous);
      }).pipe(Effect.uninterruptible);
    }
    const remotePort = remoteLaunch.remotePort;
    yield* Effect.logDebug("ssh.environment.remotePort.ready", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      remotePort,
      remoteServerKind: remoteLaunch.remoteServerKind,
    });
    const localPort =
      input.previous?.localPort ?? input.previousLocalPort ?? (yield* reserveLocalTunnelPort());
    const httpBaseUrl = `http://127.0.0.1:${localPort}/`;
    const wsBaseUrl = `ws://127.0.0.1:${localPort}/`;
    yield* Effect.logDebug("ssh.environment.localPort.reserved", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    const entryScope = yield* Scope.make("sequential");
    const start = (authOptions: SshAuth.SshAuthOptions) =>
      startSshTunnel({
        key: input.key,
        resolvedTarget: input.resolvedTarget,
        remotePort,
        localPort,
        httpBaseUrl,
        wsBaseUrl,
        authOptions,
        remoteServerKind: remoteLaunch.remoteServerKind,
        selectedRuntime: remoteLaunch.selectedRuntime,
        scope: entryScope,
      });
    const tunnelEntry = yield* (
      input.background
        ? start(backgroundAuth(input.key))
        : runWithSshAuth({
            key: input.key,
            keyOnly: input.keyOnly === true,
            target: input.resolvedTarget,
            operation: start,
          })
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(entryScope, Exit.void).pipe(Effect.ignore),
      ),
    );
    if (closed || (generations.get(input.key) ?? 0) !== generation) {
      yield* Scope.close(entryScope, Exit.void);
      if (!closed) cancelledLaunches.set(input.key, remoteLaunch.pending === undefined);
      else if (remoteLaunch.pending === undefined && options.leaveRemoteServerRunning !== true)
        yield* stopRemoteServer(input.resolvedTarget, backgroundAuth(input.key)).pipe(
          Effect.ignore,
          Effect.uninterruptible,
        );
      return yield* new SshLaunchError({ message: "SSH connection was cancelled.", stdout: "" });
    }
    tunnels.set(input.key, tunnelEntry);
    if (remoteLaunch.pending === undefined) pendingReplacements.delete(input.key);
    const spawnerService = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cryptoService = yield* Crypto.Crypto;
    const fileSystemService = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* Scope.addFinalizer(
      entryScope,
      Effect.gen(function* () {
        const stopRemote = tunnels.get(tunnelEntry.key) === tunnelEntry;
        if (stopRemote) {
          tunnels.delete(tunnelEntry.key);
        }
        yield* tunnelEntry.process
          .kill({
            killSignal: "SIGTERM",
            forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
          })
          .pipe(Effect.ignore);
        if (
          !stopRemote ||
          options.leaveRemoteServerRunning === true ||
          pendingReplacements.has(tunnelEntry.key)
        ) {
          return;
        }
        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.start", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
        const authSecret =
          input.keyOnly === true ? null : (authSecrets.get(tunnelEntry.key) ?? null);
        yield* stopRemoteServer(
          tunnelEntry.target,
          authSecret === null
            ? {
                batchMode: "yes",
                interactiveAuth: false,
              }
            : {
                authSecret,
                batchMode: "no",
                interactiveAuth: true,
              },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawnerService),
          Effect.provideService(Crypto.Crypto, cryptoService),
          Effect.provideService(FileSystem.FileSystem, fileSystemService),
          Effect.provideService(Path.Path, pathService),
        );
        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.succeeded", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
      }).pipe(Effect.ignore),
    );
    yield* Effect.logDebug("ssh.environment.tunnel.create.succeeded", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    return tunnelEntry;
  });

  /**
   * Whether an open local forward still reaches its remote server. One that
   * does not answer within the check window is closed here; the caller opens
   * a new one. A failed local forward is not authority to stop its remote
   * server, so ownership is removed before closing and the scope finalizer
   * stays local.
   */
  const keepAnsweringTunnel = Effect.fn("ssh/tunnel.keepAnsweringTunnel")(function* (
    key: string,
    entry: SshTunnelEntry,
  ) {
    const logFields = {
      ...sshTargetLogFields(entry.target),
      key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    };
    yield* Effect.logDebug("ssh.environment.tunnel.existing.check", logFields);
    const readinessExit = yield* Effect.exit(
      waitForHttpReady({ baseUrl: entry.httpBaseUrl, timeoutMs: EXISTING_TUNNEL_CHECK_TIMEOUT_MS }),
    );
    if (Exit.isSuccess(readinessExit)) {
      yield* Effect.logDebug("ssh.environment.tunnel.reused", logFields);
      return true;
    }
    yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
      ...logFields,
      cause: readinessExit.cause,
    });
    yield* Effect.gen(function* () {
      if (tunnels.get(key) === entry) {
        tunnels.delete(key);
      }
      yield* closeTunnelEntry(entry);
    }).pipe(Effect.uninterruptible);
    return false;
  });

  const ensureTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry")(function* (
    key: string,
    resolvedTarget: DesktopSshEnvironmentTarget,
    runner?: RemoteGoatRunnerOptions,
    background: boolean = false,
    keyOnly: boolean = false,
  ): Effect.fn.Return<
    SshTunnelEntry | DesktopSshRuntimePendingResult,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const entry = tunnels.get(key);
    if (entry !== undefined) {
      const replace =
        pendingReplacements.has(key) || runner?.refreshOwnedRuntimeOnFirstConnection === true;
      if (!replace && (yield* keepAnsweringTunnel(key, entry))) return entry;
      if (replace) {
        const readiness = yield* Effect.exit(
          waitForHttpReady({ baseUrl: entry.httpBaseUrl, timeoutMs: 2_000 }),
        );
        if (Exit.isSuccess(readiness)) {
          return yield* createTunnelEntry({
            key,
            resolvedTarget,
            ...(runner === undefined ? {} : { runner }),
            previous: entry,
            background,
            keyOnly,
          });
        }
        yield* Effect.gen(function* () {
          if (tunnels.get(key) === entry) tunnels.delete(key);
          yield* closeTunnelEntry(entry);
        }).pipe(Effect.uninterruptible);
      }
    }
    return yield* createTunnelEntry({
      key,
      resolvedTarget,
      keyOnly: keyOnly === true,
      ...(runner === undefined ? {} : { runner }),
      ...(entry === undefined ? {} : { previousLocalPort: entry.localPort }),
      background,
    });
  });

  const startRetry = Effect.gen(function* () {
    if (retryStarted) return;
    retryStarted = true;
    const context = yield* Effect.context<SshEnvironmentEffectContext>();
    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("1 minute");
        if (closed) return;
        const now = yield* Clock.currentTimeMillis;
        for (const [key, intent] of pendingReplacements) {
          if (intent.nextAttemptAt > now) continue;
          yield* withTargetLock(
            key,
            Effect.gen(function* () {
              if (
                closed ||
                pendingReplacements.get(key) !== intent ||
                (generations.get(key) ?? 0) !== intent.generation
              )
                return;
              intent.nextAttemptAt = (yield* Clock.currentTimeMillis) + 600_000;
              const result = yield* ensureTunnelEntry(
                key,
                intent.target,
                { ...intent.requestedRunner, refreshOwnedRuntimeOnFirstConnection: true },
                true,
              );
              if (!("type" in result) && !pendingReplacements.has(key)) {
                firstConnectionDecisions.add(
                  `${key}:${intent.requestedRunner.archiveVersion ?? intent.requestedRunner.nodeScriptPath ?? ""}`,
                );
              }
            }),
          ).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("ssh.runtime.retry.failed", { alias: intent.target.alias, cause }),
            ),
            Effect.ignore,
          );
        }
      }
    }).pipe(Effect.provide(context), Effect.forkIn(managerScope));
  });

  const ensureEnvironment = Effect.fn("ssh/tunnel.ensureEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
    requestOptions?: { readonly issuePairingToken?: boolean; readonly keyOnly?: boolean },
  ): Effect.fn.Return<
    DesktopSshEnvironmentReadyOrPending,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const ticket = yield* takeRequestTicket(target, "ensure");
    yield* startRetry;
    yield* Effect.logInfo("ssh.environment.ensure.start", {
      ...sshTargetLogFields(target),
      issuePairingToken: requestOptions?.issuePairingToken === true,
    });
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    resolvedTargets.set(targetConnectionKey(target), resolvedTarget);
    yield* Effect.logDebug("ssh.environment.target.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      key,
    });
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    yield* Effect.logDebug("ssh.environment.runner.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      ...sshRunnerLogFields(runner),
      key,
    });
    return yield* withTargetLock(
      key,
      Effect.gen(function* () {
        if (ensureSuperseded(ticket)) {
          yield* Effect.logInfo("ssh.environment.ensure.superseded", {
            ...sshTargetLogFields(resolvedTarget),
            key,
          });
          return yield* new SshLaunchError({
            message: "SSH connection was cancelled.",
            stdout: "",
          });
        }
        const decisionKey = `${key}:${runner?.archiveVersion ?? runner?.nodeScriptPath ?? ""}`;
        const connectionRunner =
          runner === undefined
            ? undefined
            : {
                ...runner,
                refreshOwnedRuntimeOnFirstConnection:
                  runner.keepExistingRunner !== true &&
                  (!firstConnectionDecisions.has(decisionKey) || pendingReplacements.has(key)) &&
                  runner.refreshOwnedRuntimeOnFirstConnection === true,
              };
        const entry = yield* ensureTunnelEntry(
          key,
          resolvedTarget,
          connectionRunner,
          false,
          requestOptions?.keyOnly === true,
        );
        if ("type" in entry) return entry;

        const pairingResult = requestOptions?.issuePairingToken
          ? yield* runWithSshAuth({
              key,
              keyOnly: requestOptions?.keyOnly === true,
              target: entry.target,
              operation: (authOptions) =>
                issueRemotePairingToken(entry.target, authOptions, runner, entry.selectedRuntime),
            })
          : null;
        const pairingToken = pairingResult?.credential ?? null;

        yield* Effect.logInfo("ssh.environment.ensure.succeeded", {
          ...sshTargetLogFields(entry.target),
          key,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
          remoteServerKind: entry.remoteServerKind,
          issuedPairingToken: pairingToken !== null,
        });
        if (
          connectionRunner?.refreshOwnedRuntimeOnFirstConnection === true &&
          !pendingReplacements.has(key)
        ) {
          firstConnectionDecisions.add(decisionKey);
        }
        return {
          target: entry.target,
          httpBaseUrl: entry.httpBaseUrl,
          wsBaseUrl: entry.wsBaseUrl,
          pairingToken,
          remotePort: entry.remotePort,
          ...(entry.remoteServerKind ? { remoteServerKind: entry.remoteServerKind } : {}),
        };
      }),
    );
  });

  const revalidateTunnels = Effect.fn("ssh/tunnel.revalidateTunnels")(function* () {
    yield* Effect.forEach(
      [...tunnels.keys()],
      // The lock waits out an ensure in flight, which may already be replacing the entry.
      (key) =>
        withTargetLock(
          key,
          Effect.suspend(() => {
            const entry = tunnels.get(key);
            return entry === undefined ? Effect.void : keepAnsweringTunnel(key, entry);
          }),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

  const disconnectEnvironment = Effect.fn("ssh/tunnel.disconnectEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<void, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const ticket = yield* takeRequestTicket(target, "disconnect");
    yield* Effect.logInfo("ssh.environment.disconnect.start", sshTargetLogFields(target));
    // Stored resolution also covers a launch in flight and aliases removed from ssh config.
    const requestKey = targetConnectionKey(target);
    const stored =
      resolvedTargets.get(requestKey) ??
      [...resolvedTargets.values()].find((value) => targetConnectionKey(value) === requestKey);
    const baseResolved = stored ?? (yield* resolveSshTarget(target.alias || target.hostname));
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    if (disconnectSuperseded(ticket)) {
      yield* Effect.logInfo("ssh.environment.disconnect.superseded", {
        ...sshTargetLogFields(resolvedTarget),
        key,
      });
      return;
    }
    const hadPending = pendingReplacements.has(key);
    generations.set(key, (generations.get(key) ?? 0) + 1);
    pendingReplacements.delete(key);
    for (const [request, value] of resolvedTargets)
      if (targetConnectionKey(value) === key) resolvedTargets.delete(request);
    yield* withTargetLock(
      key,
      Effect.gen(function* () {
        // A newer request took over while this one waited for the lock.
        if (disconnectSuperseded(ticket)) {
          // The newer ensure owns whatever a cancelled launch left running.
          cancelledLaunches.delete(key);
          yield* Effect.logInfo("ssh.environment.disconnect.superseded", {
            ...sshTargetLogFields(resolvedTarget),
            key,
          });
          return;
        }
        const entry = tunnels.get(key) ?? null;
        yield* Effect.logDebug("ssh.environment.disconnect.targetResolved", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          hasTunnel: entry !== null,
        });
        if (entry !== null) {
          // Remove this entry before closure; an owner stops explicitly below.
          yield* Effect.gen(function* () {
            tunnels.delete(key);
            yield* closeTunnelEntry(entry);
          }).pipe(Effect.uninterruptible);
        }
        const stopRemote = cancelledLaunches.get(key) ?? !hadPending;
        cancelledLaunches.delete(key);
        if (options.leaveRemoteServerRunning !== true && stopRemote) {
          yield* runWithSshAuth({
            key,
            target: resolvedTarget,
            operation: (authOptions) => stopRemoteServer(resolvedTarget, authOptions),
          });
        }
        yield* Effect.logInfo("ssh.environment.disconnect.succeeded", {
          ...sshTargetLogFields(resolvedTarget),
          key,
        });
      }),
    );
  });

  const resolveManagedTarget = Effect.fn("ssh/tunnel.resolveManagedTarget")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    return { resolvedTarget, key: targetConnectionKey(resolvedTarget) };
  });

  const issueMcpClientSession = Effect.fn("ssh/tunnel.issueMcpClientSession")(function* (
    target: DesktopSshEnvironmentTarget,
    sessionOptions: RemoteMcpClientSessionOptions,
  ): Effect.fn.Return<
    RemoteMcpClientSession,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const { resolvedTarget, key } = yield* resolveManagedTarget(target);
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    if (pendingReplacements.has(key) && !tunnels.has(key)) {
      return yield* new SshLaunchError({
        message: "Remote runtime will be replaced when its work finishes.",
        stdout: "",
      });
    }
    // Session preparation waits for a launch in flight and reuses its selection.
    return yield* withTargetLock(
      key,
      runWithSshAuth({
        key,
        target: resolvedTarget,
        operation: (authOptions) =>
          issueRemoteMcpClientSession(
            resolvedTarget,
            sessionOptions,
            authOptions,
            runner,
            tunnels.get(key)?.selectedRuntime,
          ),
      }),
    );
  });

  const runRemoteScript = Effect.fn("ssh/tunnel.runRemoteScript")(function* (
    target: DesktopSshEnvironmentTarget,
    input: { readonly script: string; readonly timeoutMs?: number },
  ): Effect.fn.Return<
    { readonly stdout: string; readonly stderr: string },
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const { resolvedTarget, key } = yield* resolveManagedTarget(target);
    return yield* runWithSshAuth({
      key,
      target: resolvedTarget,
      operation: (authOptions) =>
        runSshCommand(resolvedTarget, {
          remoteCommandArgs: ["sh", "-s"],
          stdin: input.script,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(authOptions.authSecret === undefined ? {} : { authSecret: authOptions.authSecret }),
          ...(authOptions.batchMode === undefined ? {} : { batchMode: authOptions.batchMode }),
          ...(authOptions.interactiveAuth === undefined
            ? {}
            : { interactiveAuth: authOptions.interactiveAuth }),
        }),
    });
  });

  return SshEnvironmentManager.of({
    ensureEnvironment,
    disconnectEnvironment,
    revalidateTunnels,
    issueMcpClientSession,
    runRemoteScript,
  });
});

/**
 * @effect-expect-leaking ChildProcessSpawner | Crypto | FileSystem | HttpClient | NetService | Path | SshPasswordPrompt
 */
export class SshEnvironmentManager extends Context.Service<
  SshEnvironmentManager,
  SshEnvironmentManagerShape
>()("@goat/ssh/tunnel/SshEnvironmentManager") {
  static readonly layer = (options: SshEnvironmentManagerOptions = {}) =>
    Layer.effect(SshEnvironmentManager, makeSshEnvironmentManager(options));
}
