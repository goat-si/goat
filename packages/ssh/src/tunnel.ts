import {
  LEGACY_SSH_ARCHIVE_VERSION_KEY,
  LEGACY_SSH_NODE_SCRIPT_PATH_KEY,
} from "@goat/contracts/legacyT3Names";
import type {
  DesktopSshEnvironmentReadyOrPending,
  DesktopSshPreparationProgress,
  DesktopSshRuntimePendingResult,
  SshRuntimePendingReplacement,
  DesktopSshEnvironmentTarget,
  SshHostFailure,
  SshHostResult,
  SshHostStatus,
  SshHostProviders,
  SshHostSetupProgress,
  SshRuntimePhase,
} from "@goat/contracts";
import {
  SshRuntimePendingReplacementSchema,
  ORCHESTRATION_PROTOCOL_VERSION,
  RUNTIME_DRAIN_DEFAULT_GRACE_SECONDS,
  RUNTIME_DRAIN_MAX_GRACE_SECONDS,
  SERVER_EXIT_CODE_DATABASE_AHEAD,
} from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { describeReadinessCause } from "@goat/shared/httpReadiness";
import { cliReleaseDownloadBaseUrl } from "@goat/shared/cliRelease";
import * as KeyedLock from "@goat/shared/KeyedLock";
import * as NetService from "@goat/shared/Net";
import * as HostProcess from "@goat/shared/HostProcess";
import { fromLenientJson } from "@goat/shared/schemaJson";
import { compareRuntimeBuilds } from "@goat/shared/semver";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import {
  makeEnsureFlights,
  supersededPreparation,
  type PreparationAdmission,
} from "./ensureFlight.ts";
import { REMOTE_NODE_ENGINE_CHECK_SCRIPT } from "./remoteNodeEngineCheck.ts";
import { ensureSshMaster } from "./master.ts";
import { makeOwnedSshTunnelCommand, ownedAuthDirectory } from "./tunnelOwner.ts";
import {
  SSH_READY_PROBE_TIMEOUT_MS,
  SSH_READY_TIMEOUT_MS,
  type SshReadinessBudget,
  sshReadinessBudget,
  waitForHttpReady,
} from "./sshReadiness.ts";
export { type SshReadinessBudget, sshReadinessBudget, waitForHttpReady } from "./sshReadiness.ts";
export { hostEnvironmentIdScript } from "./appServer.ts";
import {
  type AppServerProbe,
  appServerLaunch,
  appServerStatus,
  probeAppServer,
  readForwardDescriptor,
  shouldMoveToAppServer,
} from "./appServer.ts";
import {
  applyScriptPlaceholders,
  decodeRemoteJsonOutput,
  isNodeScriptRunner,
  matchesSignals,
  liveRuntimeBlocksUpdate,
  notifyRuntimePhase,
  REMOTE_ARCHIVE_CHECKSUMS_SECONDS,
  REMOTE_ARCHIVE_DOWNLOAD_SECONDS,
  REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
  REMOTE_ARCHIVE_LOCK_WAIT_SECONDS,
  requestedRuntime,
  shellSingleQuote,
  sshTargetLogFields,
  stripTrailingNewlines,
  type PreparedRemoteRuntime,
  type RemoteGoatRunnerOptions,
  type SshRuntimeProgressCallback,
} from "./remoteRuntime.ts";
import { REMOTE_PROTOCOL_TOKEN_SCRIPT, REMOTE_RUNNER_HINT_SCRIPT } from "./runtimeFactsScripts.ts";
import { remoteUploadCommand } from "./runtimeInstallScripts.ts";
import { runtimePreparationError } from "./runtimePreparationErrors.ts";
import { buildRemoteRuntimeProbeScript, decodeRemoteRuntimeProbe } from "./runtimeProbe.ts";
import { makeRuntimeProvisioning } from "./runtimeProvisioning.ts";
import { makeManagedTrust } from "./managedTrust.ts";
import { makeTargetAdmission, type RequestTicket } from "./targetAdmission.ts";
import { makeFailureEnrichment, runtimeFailureResult } from "./sshFailureDiagnostics.ts";
import {
  makeRemoteSessions,
  memoryScopesUnsupportedError,
  type RemoteClientSession,
  type RemoteClientSessionOptions,
  type RemoteMcpClientSession,
  type RemoteMcpClientSessionOptions,
} from "./remoteSessions.ts";
import {
  REMOTE_RUNTIME_CLEANUP_SCRIPT,
  REMOTE_RUNTIME_FACT_WARMUP_SCRIPT,
} from "./runtimeMaintenanceScripts.ts";
import {
  KEEP_EXISTING_RUNNER_INSTALL,
  REMOTE_LAUNCH_LISTENER_SCRIPT,
  REMOTE_LEGACY_IDENTITY_SCRIPT,
  REMOTE_OWNED_IDENTITY_SCRIPT,
  REMOTE_PROTOCOL_GUARD_SCRIPT,
  REMOTE_REPLACEMENT_LOCK_SCRIPT,
  REMOTE_RUNNER_SETUP_SCRIPT,
  REPLACE_RUNNER_INSTALL,
  VERIFY_OWNED_BEFORE_PUBLICATION,
} from "./runtimeOwnershipScripts.ts";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  getLastNonEmptyOutputLine,
  REMOTE_RUNTIME_STATE_KEY,
  resolveSshCommand,
  resolveSshTarget,
  runSshCommand,
  SshReconnectCost,
  SshHostAnswered,
  SshConnectionSharing,
  healthySshMaster,
  type SshMasterConnection,
  measureSshReconnectStep,
  SSH_KEEPALIVE_ARGS,
  sshDiagnosticChunks,
  SSH_DIAGNOSTIC_ARGS,
  targetConnectionKey,
} from "./command.ts";
import {
  SshCommandError,
  SshHttpBridgeError,
  SshInvalidTargetError,
  SshLaunchError,
  SshEnsureSupersededError,
  SshPreparationTimeoutError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "./errors.ts";

const DEFAULT_REMOTE_PORT = 3773;
const REMOTE_PORT_SCAN_WINDOW = 200;
const REMOTE_LAUNCH_ATTEMPTS = 3;
// How long an open forward has to answer before it counts as dead. A forward
// whose TCP connection died during sleep accepts locally and never answers.
const EXISTING_TUNNEL_CHECK_TIMEOUT_MS = 2_000;
/** How long a target uses the managed server after its GOAT app server refused a credential. */
const APP_SERVER_REFUSAL_MS = 600_000;
const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;
const TUNNEL_STDERR_TAIL_CHARS = 16_384;
const REMOTE_READY_TIMEOUT_MS = 60_000;
const REMOTE_LAUNCH_TIMEOUT_MS = 90_000;
// Cold archive launches download and extract ~70 MB and may wait on an install lock.
// Lock waits must outlast both downloads and extraction; SSH must outlast install or wait plus readiness.
// Leave slack for verification and extraction, which have no timeout.
const REMOTE_ARCHIVE_CHECKSUMS_SECONDS = 30;
const REMOTE_ARCHIVE_DOWNLOAD_SECONDS = 240;
const REMOTE_ARCHIVE_LOCK_WAIT_SECONDS = 360;
const REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS = 900_000;
const REMOTE_REUSE_READY_TIMEOUT_MS = 2_000;
// Reserved by the folded launch protocol for re-entering preparation, never a launch failure.
const REMOTE_RECONNECT_REPROBE_EXIT_CODE = 76;

export interface SshEnvironmentManagerOptions {
  readonly resolveCliRunner?: Effect.Effect<RemoteGoatRunnerOptions>;
  /**
   * Close only the local forward when a tunnel ends. A second client of a
   * host (the server's own SSH dispatch) shares the remote server with the
   * client that started it, so it must never stop that server.
   */
  readonly leaveRemoteServerRunning?: boolean;
}

interface ReconnectSelection {
  readonly runtime: PreparedRemoteRuntime;
  readonly generation: number;
  readonly revision: number;
  readonly identity: string;
}

interface SshTunnelEntry {
  readonly master?: SshMasterConnection;
  selectedRuntime: PreparedRemoteRuntime;
  reconnectSelection?: ReconnectSelection;
  attachmentInvalidated?: boolean;
  // Status can revalidate an attachment, but cannot prove a submitted drain was cancelled.
  uncertainDrain?: boolean;
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly remoteServerKind: "app" | "external" | "managed" | null;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly readiness: SshReadinessBudget;
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
  | SshEnsureSupersededError
  | SshPreparationTimeoutError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

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
export interface SshEnvironmentEnsureOptions {
  readonly preparedAttachmentId?: string;
  readonly onPreparationProgress?: (progress: DesktopSshPreparationProgress) => void;
  readonly onPreparationAdmission?: (admission: PreparationAdmission) => void;
  readonly issuePairingToken?: boolean;
  readonly keyOnly?: boolean;
  readonly reuseWhileRefreshPending?: boolean;
  readonly refreshRuntime?: boolean;
  readonly confirmReplacement?: boolean;
  readonly onPhase?: SshRuntimeProgressCallback;
}

/** Publications never resolve aliases or acquire installation locks; stale operations are ignored. */
export type SshSetupOutcome =
  | { readonly kind: "complete" }
  | {
      readonly kind: "error";
      readonly reason:
        | "diagnosis_failed"
        | "approval_expired"
        | "authorization_revoked"
        | "operation_failed";
      readonly message: string;
      readonly fix: SshHostFailure["fix"];
    };

export interface SshEnvironmentManagerShape {
  readonly readyEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<
    Exclude<DesktopSshEnvironmentReadyOrPending, DesktopSshRuntimePendingResult>,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;

  readonly beginSetupOperation: (
    target: DesktopSshEnvironmentTarget,
    operationId: string,
  ) => Effect.Effect<SshHostSetupProgress, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  readonly publishSetupOutcome: (
    target: DesktopSshEnvironmentTarget,
    operation: Pick<SshHostSetupProgress, "generation" | "operationId">,
    outcome: SshSetupOutcome,
  ) => Effect.Effect<boolean>;
  readonly publishProviderDiagnosis: (
    target: DesktopSshEnvironmentTarget,
    operation: Pick<SshHostSetupProgress, "generation" | "operationId">,
    providers: SshHostProviders,
  ) => Effect.Effect<boolean, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  readonly forgetEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options: { readonly stopRuntime: "if_idle" | "no" },
  ) => Effect.Effect<SshHostResult, SshEnvironmentEffectError, SshEnvironmentEffectContext>;

  readonly status: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<SshHostResult, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: SshEnvironmentEnsureOptions,
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
  readonly issueClientSession: (
    target: DesktopSshEnvironmentTarget,
    options: RemoteClientSessionOptions,
  ) => Effect.Effect<RemoteClientSession, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  /** The kind of server this manager's connection to the target uses, if any. */
  readonly attachedServerKind?: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<"app" | "external" | "managed" | null>;
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

const decodeRemoteLaunchResult = Schema.decodeEffect(fromLenientJson(RemoteLaunchResult));

const decodeRemoteLaunchOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemoteLaunchResult);

function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

function buildRemoteContendedOutput(
  pending: Pick<SshRuntimePendingReplacement, "replacement" | "requestedVersion" | "liveVersion">,
) {
  const fields = JSON.stringify({ reason: "contended", ...pending }).slice(1, -1);
  return `lock_pending_fields=${shellSingleQuote(fields)}
if [ "$LOCK_DETAIL" = recovery-stale ]; then lock_pending_fields="$lock_pending_fields,"'"detail":"recovery-stale"'; fi
printf '{"status":"pending","pending":{%s}}\\n' "$lock_pending_fields"`;
}

export { describeReadinessCause };
export type {
  PreparedRemoteRuntime,
  RemoteGoatRunnerOptions,
  SshRuntimeProgress,
  SshRuntimeProgressCallback,
} from "./remoteRuntime.ts";

export const REMOTE_PICK_PORT_SCRIPT = `const fs = require("node:fs");
const net = require("node:net");
const filePath = process.argv[2] ?? "";
const defaultPort = Number.parseInt(process.argv[3] ?? "", 10);
const scanWindow = Number.parseInt(process.argv[4] ?? "", 10);
const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
const preferred = Number.parseInt(raw, 10);
const start = Number.isInteger(preferred) ? preferred : defaultPort;
const end = start + scanWindow;

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(!error));
    });
  });
}

// macOS lets the bind above succeed while another process listens on
// *:<port>, so also skip any port that already answers on loopback.
function answersOnLoopback(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

(async () => {
  for (let port = start; port < end; port += 1) {
    const available = (await canBind(port)) && !(await answersOnLoopback(port));
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
  # lsof lives in sbin on macOS. A login PATH that already has node returns
  # before these lines, so the launch script also prepends them unconditionally.
  prepend_path_if_dir "/usr/sbin"
  prepend_path_if_dir "/sbin"

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
  # Cleanup takes this mutex exclusively; installs may still run concurrently.
  if [ "$(uname -s)" = Linux ] && command -v flock >/dev/null 2>&1; then
    GOAT_MAINTENANCE="$HOME/.goat/runtime/goat/versions/.maintenance.lock"
    [ ! -L "$GOAT_MAINTENANCE" ] || exit 1
    exec 9>"$GOAT_MAINTENANCE"
    flock -w @@GOAT_ARCHIVE_LOCK_WAIT_SECONDS@@ -s 9
  fi
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
    MINGW* | MSYS* | CYGWIN*) GOAT_PLATFORM="win32" ;;
    *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) GOAT_ARCH="arm64" ;;
    x86_64 | amd64) GOAT_ARCH="x64" ;;
    *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -m)" >&2; exit 1 ;;
  esac
  GOAT_ARCHIVE="goat-$GOAT_ARCHIVE_VERSION-$GOAT_PLATFORM-$GOAT_ARCH.tar.gz"
  if [ "$GOAT_PLATFORM" = win32 ]; then GOAT_ARCHIVE="goat-$GOAT_ARCHIVE_VERSION-$GOAT_PLATFORM-$GOAT_ARCH.zip"; fi
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
  if [ "$GOAT_PLATFORM" = win32 ]; then
    # Git Bash's GNU tar cannot read zip; Windows ships bsdtar in System32.
    "$(cygpath -S)/tar.exe" -xf "$GOAT_STAGING/$GOAT_ARCHIVE" -C "$GOAT_STAGING" --strip-components=1
  else
    tar -xzf "$GOAT_STAGING/$GOAT_ARCHIVE" -C "$GOAT_STAGING" --strip-components=1
  fi
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
  if command -v shasum >/dev/null 2>&1; then
    GOAT_EXECUTABLE_SHA256="$(shasum -a 256 "$GOAT_STAGING/goat" | cut -d' ' -f1)"
  else
    GOAT_EXECUTABLE_SHA256="$(sha256sum "$GOAT_STAGING/goat" | cut -d' ' -f1)"
  fi
  # Publish provenance with the verified executable, never backfill legacy directories.
  # The uploader names its source in the environment so run-t3.sh bytes stay source-free:
  # retained-runner identity compares those bytes across launches.
  case "\${GOAT_SSH_ARCHIVE_SOURCE:-}" in
    bundle|cache|gh) GOAT_RECORD_SOURCE="$GOAT_SSH_ARCHIVE_SOURCE" ;;
    *) GOAT_RECORD_SOURCE=@@GOAT_DOWNLOAD_SOURCE@@ ;;
  esac
  printf '%s %s %s %s\\n' "$GOAT_ARCHIVE_VERSION" "$GOAT_EXPECTED" "$GOAT_EXECUTABLE_SHA256" "$GOAT_RECORD_SOURCE" > "$GOAT_STAGING/.install-record"
  printf '%s\\n' "$GOAT_ARCHIVE_VERSION" > "$GOAT_STAGING/.install-complete"
  rm -rf "$GOAT_RUNTIME_DIR"
  mv "$GOAT_STAGING" "$GOAT_RUNTIME_DIR"
fi
if [ -n "\${GOAT_LOCK:-}" ]; then
  goat_lock_cleanup
  trap - 0 1 2 3 15
fi
exec 9>&-
exec "$GOAT_RUNTIME_DIR/goat" "$@"
`;

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
  printf 'GOAT ownership could not be verified; process and ownership files were preserved. The running server does not match the launch identity in %s/identity. If you started it by hand, stop it on the host and reconnect so GOAT starts its own.\\n' "$STATE_DIR" >&2; exit 1
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
${REMOTE_LAUNCH_LISTENER_SCRIPT}
wait_for_pid_exit() {
  PID_TO_WAIT="$1"
  WAIT_COUNT=0
  while server_alive "$PID_TO_WAIT" && [ "$WAIT_COUNT" -lt 20 ]; do
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
}
reuse_live_server() {
    REMOTE_PORT="$LIVE_PORT"
    if ! wait_ready "@@GOAT_READY_TIMEOUT_MS@@"; then
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
[ "\${RECONCILING_DRAIN:-0}" != 1 ] || NEEDS_OWNED_UPGRADE=1
[ "$DEFER_NO_DRAIN" != 1 ] || emit_pending unknown drain-unavailable
REMOTE_PID=""
REMOTE_PORT=""
REMOTE_MANAGED=""
# Refuse before drain or a fresh start. Stopping the server and then failing
# this check would leave the host with nothing to attach to.
ensure_listener_path
if ! listener_probe_available; then
  if [ "$NEEDS_OWNED_UPGRADE" = 1 ] || [ "$LIVE_STATUS" = live ]; then
    printf 'Cannot verify the launched GOAT listener: this host needs /proc or lsof. The existing server was left running.\\n' >&2
  else
    printf 'Cannot verify the launched GOAT listener: this host needs /proc or lsof.\\n' >&2
  fi
  exit 1
fi
if [ "$NEEDS_OWNED_UPGRADE" = 1 ]; then
  UPGRADE_PID="$LIVE_PID"; UPGRADE_PORT="$LIVE_PORT"; UPGRADE_VERSION="$LIVE_VERSION"
  UPGRADE_INSTANCE="$LIVE_INSTANCE_ID"
  if [ "$GOAT_HOST_WINDOWS" = 1 ] &&
     { [ "$GOAT_ARCHIVE_MODE" != 1 ] || [ ! -x "$HOME/.goat/runtime/goat/versions/$UPGRADE_VERSION/goat" ]; }; then
    # The Windows supervisor restarts installed release executables only.
    printf 'Live GOAT PID=%s port=%s can only be replaced by a GOAT release on this Windows host; it was left running. Stop it when its work is done, then reconnect.\\n' "$UPGRADE_PID" "$UPGRADE_PORT" >&2; exit 1
  fi
  # Validate bytes and authority before the final PID-validated idle probe.
  check_candidate_protocol
  check_retained_runner
  if [ "$LEGACY_PENDING" = 1 ] && [ "$LEGACY_COMMITTED" = 0 ]; then
    verify_legacy_identity || ownership_unverified
  else verify_owned_identity "$LIVE_PID" "$LIVE_PORT" || repair_owned_identity || ownership_unverified; fi
  UPGRADE_START="$(server_start "$UPGRADE_PID")" || ownership_unverified
  [ -n "$UPGRADE_START" ] || ownership_unverified
  if [ "$RECONCILING_DRAIN" != 1 ] && [ "$REPLACEMENT_REASON" != incompatible ] && [ "$DRAIN_FORCE" != 1 ]; then
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
  [ "$(server_start "$UPGRADE_PID")" = "$UPGRADE_START" ] || ownership_unverified
  [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] || ownership_unverified
  PREVIOUS_IDENTITY="$(cat "$STATE_DIR/identity")" || ownership_unverified
  PREVIOUS_RUNNER="$STATE_DIR/run-t3.previous"
  if [ -f "$RETAINED_SNAPSHOT_FILE" ]; then cp -p "$RETAINED_SNAPSHOT_FILE" "$PREVIOUS_RUNNER"
  elif [ -e "$RUNNER_FILE" ] || [ -L "$RUNNER_FILE" ] || [ "$GOAT_ARCHIVE_MODE" != 1 ]; then cp -p "$RUNNER_FILE" "$PREVIOUS_RUNNER"
  else
    # An adopted server lost its runner with its records. Rollback restarts its installed
    # release through this app's runner with only the archive version changed.
    awk -v v="$UPGRADE_VERSION" '/^GOAT_ARCHIVE_VERSION=/ { print "GOAT_ARCHIVE_VERSION=\\047" v "\\047"; next }
      /^T3_ARCHIVE_VERSION=/ { print "T3_ARCHIVE_VERSION=\\047" v "\\047"; next } { print }' "$RUNNER_CANDIDATE_FILE.pin" >"$PREVIOUS_RUNNER" &&
      chmod 700 "$PREVIOUS_RUNNER" || ownership_unverified
    [ "$(read_runner_hint "$PREVIOUS_RUNNER" GOAT_ARCHIVE_VERSION ${LEGACY_SSH_ARCHIVE_VERSION_KEY})" = "$UPGRADE_VERSION" ] &&
      [ "$(read_runner_hint "$PREVIOUS_RUNNER" T3_ARCHIVE_VERSION T3_ARCHIVE_VERSION)" = "$UPGRADE_VERSION" ] || ownership_unverified
  fi
  # The server, not this script, stops itself: it refuses new turns, lets running work
  # finish within the grace window, and exits. Unconfirmed, an expired window cancels.
  drain_force=
  [ "$DRAIN_FORCE" != 1 ] || drain_force=--force
  # A lost response or a dead SSH owner cannot prove the server stopped draining.
  printf '%s\\n' "$UPGRADE_INSTANCE" > "$STATE_DIR/draining.next.$$"
  mv "$STATE_DIR/draining.next.$$" "$STATE_DIR/draining"
  # Only an automatic refresh of an older runtime is a request the runtime may arbitrate. A
  # reconciliation retry keeps the marker: the runtime joins a drain that is still active and
  # arbitrates only a request that would start a new one.
  drain_automatic=0
  if [ "$DRAIN_AUTOMATIC" = 1 ] && [ "$REPLACEMENT_REASON" = older ]; then drain_automatic=1; fi
  drain_result="$(GOAT_RUNTIME_DRAIN_AUTOMATIC="$drain_automatic" "$RUNNER_CANDIDATE_FILE.pin" __ssh-helper drain --port "$UPGRADE_PORT" --instance-id "$UPGRADE_INSTANCE" --target-version "$TARGET_VERSION" --grace-seconds "$DRAIN_GRACE_SECONDS" $drain_force --token-file "$DEFAULT_SERVER_HOME/userdata/runtime-control.token" 2>/dev/null || true)"
  case "$drain_result" in
    drained) ;;
    cancelled) rm -f "$STATE_DIR/draining" "$PREVIOUS_RUNNER"; DRAIN_UNCERTAIN=0; emit_pending busy ;;
    *) DRAIN_UNCERTAIN=1; rm -f "$PREVIOUS_RUNNER"; emit_pending unknown ;;
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
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then
    # Windows OpenSSH ends every process left in the session, so the supervisor also starts
    # outside it and this script waits on its PID. Paths are native; identities stay POSIX.
    # cmd.exe cannot append to a log another cmd.exe holds, so the supervisor writes its own.
    SUPERVISE_LOG="$STATE_DIR/supervisor.log"
    SUPERVISE_PID="$(windows_spawn_detached "$SUPERVISE_LOG" "$(cygpath -w "$SPAWN_IDENTITY")" __ssh-helper supervise --old-pid "$UPGRADE_PID" --old-instance-id "$UPGRADE_INSTANCE" --port "$UPGRADE_PORT" --base-dir "$(cygpath -w "$DEFAULT_SERVER_HOME")" --state-dir "$(cygpath -w "$STATE_DIR")" --runner "$(cygpath -w "$RUNNER_FILE")" --previous-runner "$(cygpath -w "$PREVIOUS_RUNNER")" --executable "$(cygpath -w "$SPAWN_IDENTITY")" --previous-executable "$(cygpath -w "$HOME/.goat/runtime/goat/versions/$UPGRADE_VERSION/goat")" --target-version "$TARGET_VERSION" --previous-version "$UPGRADE_VERSION" --identity "$SPAWN_IDENTITY serve --host 127.0.0.1 --port $UPGRADE_PORT --base-dir $DEFAULT_SERVER_HOME" --previous-identity "$PREVIOUS_IDENTITY" --ready-timeout-ms "@@GOAT_READY_TIMEOUT_MS@@" --log "$(cygpath -w "$LOG_FILE")" --result "$(cygpath -w "$SUPERVISE_RESULT")")" || SUPERVISE_PID=
    if valid_positive "$SUPERVISE_PID"; then
      while server_alive "$SUPERVISE_PID"; do sleep 1; done
    fi
    # A running replacement may hold server.log; then the supervisor log is kept beside it.
    if cat "$SUPERVISE_LOG" >>"$LOG_FILE" 2>/dev/null; then rm -f "$SUPERVISE_LOG"; fi
  else
    nohup "$RUNNER_FILE" __ssh-helper supervise --old-pid "$UPGRADE_PID" --old-instance-id "$UPGRADE_INSTANCE" --port "$UPGRADE_PORT" --base-dir "$DEFAULT_SERVER_HOME" --state-dir "$STATE_DIR" --runner "$RUNNER_FILE" --previous-runner "$PREVIOUS_RUNNER" --target-version "$TARGET_VERSION" --previous-version "$UPGRADE_VERSION" --identity "$SPAWN_IDENTITY serve --host 127.0.0.1 --port $UPGRADE_PORT --base-dir $DEFAULT_SERVER_HOME" --previous-identity "$PREVIOUS_IDENTITY" --ready-timeout-ms "@@GOAT_READY_TIMEOUT_MS@@" --log "$LOG_FILE" --result "$SUPERVISE_RESULT" >/dev/null 2>>"$LOG_FILE" </dev/null &
    wait "$!" || true
  fi
  supervise_status=failed; supervise_pid=0; supervise_version=
  if [ -f "$SUPERVISE_RESULT" ]; then read -r supervise_status supervise_pid supervise_version <"$SUPERVISE_RESULT" || true; fi
  rm -f "$SUPERVISE_RESULT"
  case "$supervise_status" in
    replaced)
      REMOTE_PID="$supervise_pid"; REMOTE_PORT="$UPGRADE_PORT"; REMOTE_MANAGED=managed
      REFRESH_DECISION=replaced ;;
    rolled-back)
      if [ "$LIVE_COMPATIBLE" != 1 ]; then
        # The restored server is a new instance, so the fence for the drained one is done.
        rm -f "$STATE_DIR/draining"
        printf 'GOAT %s did not start on the remote host; GOAT %s was restored and is running, but this app cannot attach to it. See %s.\n' "$TARGET_VERSION" "$supervise_version" "$LOG_FILE" >&2; exit 1
      fi
      printf 'GOAT %s did not start on the remote host; GOAT %s was restored.\n' "$TARGET_VERSION" "$supervise_version" >&2
      REMOTE_PID="$supervise_pid"; REMOTE_PORT="$UPGRADE_PORT"; REMOTE_MANAGED=managed
      SELECTED_VERSION="$supervise_version" ;;
    old-alive)
      printf 'The drained GOAT %s server on the remote host did not exit, so it was left running and not replaced. Reconnect after it stops; see %s.\\n' "$UPGRADE_VERSION" "$LOG_FILE" >&2; exit 1 ;;
    *)
      printf 'Remote runtime replacement failed; see %s.\n' "$LOG_FILE" >&2; exit 1 ;;
  esac
  rm -f "$STATE_DIR/draining"
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
  if [ "@@GOAT_REQUIRE_FRESH_HOST@@" = 1 ]; then
    for fresh_db in "$DEFAULT_SERVER_HOME/userdata/statev2.sqlite" "$DEFAULT_SERVER_HOME/userdata/state.sqlite"; do
      if [ -e "$fresh_db" ] || [ -L "$fresh_db" ]; then
        printf 'GOAT data appeared on this host while it was being set up; reconnect.\\n' >&2; exit 1
      fi
    done
  fi
  publish_selected_runner
fi
# A runtime older than this host's database exits before ready on every start. The marker
# names that runtime, so later launches report it without starting it again, until another
# runtime is selected or a newer server writes the database.
DATABASE_AHEAD_FILE="$STATE_DIR/database-ahead"
database_ahead_exit() {
  printf 'GOAT %s on this host cannot open its data because a newer GOAT build already upgraded it. Update this app or the GOAT runtime on this host, then reconnect.\\n' "$SELECTED_VERSION" >&2
  exit 1
}
database_ahead_marked() {
  [ -f "$DATABASE_AHEAD_FILE" ] && [ "$(cat "$DATABASE_AHEAD_FILE" 2>/dev/null || true)" = "$SELECTED_VERSION" ] || return 1
  [ -z "$(find "$DEFAULT_SERVER_HOME/userdata" -maxdepth 1 -name 'statev2.sqlite*' -newer "$DATABASE_AHEAD_FILE" 2>/dev/null || true)" ]
}
LAUNCH_ATTEMPTS=0
while [ -z "$REMOTE_PORT" ]; do
  LAUNCH_ATTEMPTS=$((LAUNCH_ATTEMPTS + 1))
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
  if database_ahead_marked; then database_ahead_exit; fi
  if [ "$GOAT_ARCHIVE_MODE" = 1 ]; then
    GOAT_RUNTIME_DIR="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION"
    SPAWN_IDENTITY="$GOAT_RUNTIME_DIR/goat"
  else
    SPAWN_IDENTITY="$GOAT_NODE_SCRIPT_PATH"
  fi
  touch "$LOG_FILE"
  LAUNCH_LOG_OFFSET="$(wc -c <"$LOG_FILE")"
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then
    # Windows OpenSSH ends every process left in the session, so the server starts outside it.
    if [ "$GOAT_ARCHIVE_MODE" = 1 ]; then set -- "$(cygpath -w "$SPAWN_IDENTITY")"
    else set -- "$(cygpath -w "$(command -v node)")" "$(cygpath -w "$SPAWN_IDENTITY")"; fi
    REMOTE_PID="$(windows_spawn_detached "$LOG_FILE" "$@" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$(cygpath -w "$DEFAULT_SERVER_HOME")")" || REMOTE_PID=
    if ! valid_positive "$REMOTE_PID"; then
      printf 'Could not start the GOAT server outside the SSH session on this Windows host.\\n' >&2
      tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
      exit 1
    fi
  else
    nohup env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$DEFAULT_SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
    REMOTE_PID="$!"
  fi
  printf '%s\\n' "$SPAWN_IDENTITY serve --host 127.0.0.1 --port $REMOTE_PORT --base-dir $DEFAULT_SERVER_HOME" >"$IDENTITY_NEXT"
  mv "$IDENTITY_NEXT" "$STATE_DIR/identity"
  printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
  printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
  printf 'managed\\n' >"$MANAGED_FILE"
  if ! wait_launched_listener || ! wait_ready "@@GOAT_READY_TIMEOUT_MS@@" ||
     ! server_owns_listener "$REMOTE_PID" "$REMOTE_PORT"; then
    # Only this attempt's exited child and bind error authorize another port selection.
    # Never signal the listener that won the race between pick-port and serve.
    if ! server_alive "$REMOTE_PID" &&
       tail -c "+$((LAUNCH_LOG_OFFSET + 1))" "$LOG_FILE" | grep -q EADDRINUSE; then
      wait "$REMOTE_PID" 2>/dev/null || true
      rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity"
      if [ "$LAUNCH_ATTEMPTS" -lt @@GOAT_LAUNCH_ATTEMPTS@@ ]; then
        printf 'Remote GOAT port %s was taken during launch; retrying.\\n' "$REMOTE_PORT" >&2
        REMOTE_PORT=
        continue
      fi
    fi
    database_ahead=0
    if ! server_alive "$REMOTE_PID"; then
      launch_exit=0
      if [ "$GOAT_HOST_WINDOWS" = 0 ]; then wait "$REMOTE_PID" 2>/dev/null || launch_exit=$?; fi
      # Windows launches and runtimes that predate the exit code only leave these errors in the log.
      if [ "$launch_exit" = ${SERVER_EXIT_CODE_DATABASE_AHEAD} ] ||
         tail -c "+$((LAUNCH_LOG_OFFSET + 1))" "$LOG_FILE" 2>/dev/null |
           grep -q -e 'upgraded by a newer GOAT build' -e 'Cannot move GOAT migrations onto ids another migration recorded' -e 'would skip required schema migrations'; then
        database_ahead=1
      fi
    fi
    printf 'Remote GOAT server did not become ready with its own listener on 127.0.0.1:%s.\\n' "$REMOTE_PORT" >&2
    if [ -s "$LOG_FILE" ]; then
      tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
    else
      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' "$LOG_FILE" >&2
    fi
    if server_alive "$REMOTE_PID"; then server_kill "$REMOTE_PID" || true; fi
    wait_for_pid_exit "$REMOTE_PID"
    rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity"
    if [ "$database_ahead" = 1 ]; then
      printf '%s\\n' "$SELECTED_VERSION" >"$DATABASE_AHEAD_FILE.next.$$"
      mv "$DATABASE_AHEAD_FILE.next.$$" "$DATABASE_AHEAD_FILE"
      database_ahead_exit
    fi
    exit 1
  fi
  rm -f "$DATABASE_AHEAD_FILE"
  # A held published fallback becomes an ordinary runtime only once its own server is ready
  # and owns the port, so it serves this host's data.
  if [ "@@GOAT_REQUIRE_FRESH_HOST@@" = 1 ]; then rm -f "$HOME/.goat/runtime/goat/held/$SELECTED_VERSION"; fi
done
refresh_fields=
[ "$REFRESH_DECISION" != replaced ] || refresh_fields=',"refresh":"replaced"'
if [ "$OWNING_LAUNCH" = 1 ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" != "$OWNER" ]; then
  printf 'Replacement lock ownership changed before attachment.\\n' >&2; exit 1
fi
@@GOAT_READY_BASELINE@@printf '{"status":"ready","remotePort":%s,"serverKind":"%s","selectedVersion":"%s"%s}\n' "$REMOTE_PORT" "\${REMOTE_MANAGED:-managed}" "$SELECTED_VERSION" "$refresh_fields"

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
# Forget may stop only an owned runtime; external/unknown state belongs to another owner.
if [ @@GOAT_STOP_OWNED_ONLY@@ = 1 ] && [ "$REMOTE_MANAGED" != managed ]; then
  printf '{"stopped":false,"activity":"unknown"}\\n'
  exit 0
fi
ownership_unverified() {
  printf 'GOAT ownership could not be verified for PID %s; process and ownership files were preserved.\\n' "$REMOTE_PID" >&2
  exit 1
}
@@GOAT_OWNED_IDENTITY@@
if [ "$REMOTE_MANAGED" = managed ] && [ -n "$REMOTE_PID" ]; then
  valid_positive "$REMOTE_PID" || ownership_unverified
  if server_alive "$REMOTE_PID"; then
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
    server_kill "$REMOTE_PID" || true
    STOP_WAIT_ATTEMPTS=@@GOAT_STOP_WAIT_ATTEMPTS@@
    STOP_WAIT_INTERVAL=@@GOAT_STOP_WAIT_INTERVAL@@
    WAIT_COUNT=0
    while server_alive "$REMOTE_PID" && [ "$WAIT_COUNT" -lt "$STOP_WAIT_ATTEMPTS" ]; do
      WAIT_COUNT=$((WAIT_COUNT + 1))
      sleep "$STOP_WAIT_INTERVAL"
    done
    if server_alive "$REMOTE_PID"; then
      printf 'Remote GOAT server with PID %s did not stop within @@GOAT_STOP_WAIT_LABEL@@. Its ownership files were kept.\\n' "$REMOTE_PID" >&2
      exit 1
    fi
  fi
elif [ "$REMOTE_MANAGED" != external ] && [ -n "$REMOTE_PID" ]; then
  valid_positive "$REMOTE_PID" || ownership_unverified
  if server_alive "$REMOTE_PID"; then ownership_unverified; fi
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
  const releaseBaseUrl = cliReleaseDownloadBaseUrl("", input?.releaseBaseUrl ?? undefined).replace(
    /\/v$/u,
    "",
  );
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_RUNNER_SCRIPT, {
      GOAT_NODE_SCRIPT_PATH: shellSingleQuote(nodeScriptPath),
      GOAT_ARCHIVE_VERSION: shellSingleQuote(archiveVersion),
      GOAT_RELEASE_BASE_URL: shellSingleQuote(releaseBaseUrl),
      GOAT_DOWNLOAD_SOURCE: input?.releaseBaseUrl?.trim() ? "mirror" : "https",
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
      GOAT_NODE_ENGINE_CHECK_SCRIPT: REMOTE_NODE_ENGINE_CHECK_SCRIPT,
    }),
  );
}

function buildRemoteRunnerSetupScript(
  input: RemoteGoatRunnerOptions | undefined,
  selection: PreparedRemoteRuntime,
  verifyOwnedBeforePublication = false,
  reconnect = false,
  captureBaseline = false,
): string {
  const preserve = selection.source === "retained";
  return applyScriptPlaceholders(REMOTE_RUNNER_SETUP_SCRIPT, {
    GOAT_OWNING_LAUNCH: verifyOwnedBeforePublication ? "1" : "0",
    GOAT_DRAIN_FORCE: input?.confirmReplacement === true ? "1" : "0",
    GOAT_DRAIN_AUTOMATIC:
      input?.confirmReplacement !== true && input?.manualRefresh !== true ? "1" : "0",
    GOAT_DRAIN_GRACE_SECONDS: String(
      Math.min(
        Math.max(
          0,
          Math.trunc(input?.replacementGraceSeconds ?? RUNTIME_DRAIN_DEFAULT_GRACE_SECONDS),
        ),
        RUNTIME_DRAIN_MAX_GRACE_SECONDS,
      ),
    ),
    GOAT_REPLACEMENT_LOCK:
      REMOTE_REPLACEMENT_LOCK_SCRIPT +
      (reconnect
        ? `
# The outer folded command holds this exact owner link across probe and attachment.
OWNER="\${2:-}"
acquire_replacement_lock() {
  [ -n "$OWNER" ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] || return 1
  LOCK_HELD=1
}
release_replacement_lock() { LOCK_HELD=0; }
# The outer command already spent the lock wait budget. A borrowed owner cannot be reacquired.
wait_for_replacement_lock() { return 1; }
`
        : "") +
      (captureBaseline
        ? `
${buildReconnectProbeScript(selection)}
capture_reconnect_baseline() {
  if [ "$LOCK_HELD" = 1 ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] &&
     probe_output="$(reconnect_probe capture)"; then printf 'GOAT_RECONNECT_PROBE=%s\\n' "$probe_output"; fi
}
`
        : ""),
    GOAT_READY_BASELINE: captureBaseline ? "capture_reconnect_baseline\n" : "",
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
    GOAT_INSTALLED_EXECUTABLE_SHA256: shellSingleQuote(selection.installedExecutableSha256 ?? ""),
    GOAT_PROTOCOL_TOKENS: REMOTE_PROTOCOL_TOKEN_SCRIPT,
    GOAT_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteGoatRunnerScript(input)),
    GOAT_PROTOCOL_GUARD: applyScriptPlaceholders(REMOTE_PROTOCOL_GUARD_SCRIPT, {
      GOAT_SSH_PROTOCOL: String(input?.candidateProtocol?.ssh ?? SSH_RUNTIME_PROTOCOL_VERSION),
      GOAT_ORCHESTRATION_PROTOCOL: String(
        input?.candidateProtocol?.orchestration ?? ORCHESTRATION_PROTOCOL_VERSION,
      ),
      GOAT_RECONNECT_LIVE_GUARD: reconnect
        ? `  # A folded reconnect may only attach to the owned selection; a race must re-enter preparation.
  if [ "$LIVE_STATUS" != live ] || [ "$LIVE_VERSION" != "$SELECTED_VERSION" ] ||
     [ "$LIVE_OWNED" != 1 ] || ! verify_owned_identity "$LIVE_PID" "$LIVE_PORT"; then
    printf 'Cached GOAT selection changed; reconnect.\\n' >&2; exit ${REMOTE_RECONNECT_REPROBE_EXIT_CODE}
  fi
`
        : "",
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
  reconnect = false,
  captureBaseline = false,
): string {
  return applyScriptPlaceholders(REMOTE_LAUNCH_SCRIPT, {
    GOAT_ARCHIVE_MODE: isNodeScriptRunner(input) ? "0" : "1",
    GOAT_NODE_SCRIPT_PATH: shellSingleQuote(input?.nodeScriptPath?.trim() || ""),
    GOAT_OWNED_IDENTITY: REMOTE_OWNED_IDENTITY_SCRIPT,
    GOAT_LEGACY_IDENTITY: REMOTE_LEGACY_IDENTITY_SCRIPT,
    GOAT_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    GOAT_RUNNER_SETUP: buildRemoteRunnerSetupScript(
      input,
      selection,
      true,
      reconnect,
      captureBaseline,
    ),
    GOAT_READY_BASELINE: captureBaseline ? "capture_reconnect_baseline\n" : "",
    GOAT_PICK_PORT_SCRIPT: stripTrailingNewlines(REMOTE_PICK_PORT_SCRIPT),
    GOAT_WAIT_READY_SCRIPT: stripTrailingNewlines(REMOTE_WAIT_READY_SCRIPT),
    GOAT_DEFAULT_REMOTE_PORT: String(DEFAULT_REMOTE_PORT),
    GOAT_REMOTE_PORT_SCAN_WINDOW: String(REMOTE_PORT_SCAN_WINDOW),
    GOAT_LAUNCH_ATTEMPTS: String(REMOTE_LAUNCH_ATTEMPTS),
    GOAT_READY_TIMEOUT_MS: String(REMOTE_READY_TIMEOUT_MS),
    GOAT_REUSE_READY_TIMEOUT_MS: String(REMOTE_REUSE_READY_TIMEOUT_MS),
    GOAT_READY_PROBE_TIMEOUT_MS: String(SSH_READY_PROBE_TIMEOUT_MS),
    GOAT_REQUIRE_FRESH_HOST: selection.requireFreshHost === true ? "1" : "0",
  });
}

// GOAT runtime provisioning lives in runtimeProvisioning.ts and embeds the runner built above.
export const {
  buildRemoteGoatUploadInstallerScript,
  buildRemoteHostDownloadScript,
  buildRemoteUploadScript,
  prepareRemoteRuntime,
} = makeRuntimeProvisioning(buildRemoteGoatRunnerScript);
export { buildRemoteRuntimeProbeScript, remoteUploadCommand };

// GOAT remote MCP and client sessions live in remoteSessions.ts; they reuse the setup above.
const {
  buildRemoteClientSessionScript,
  buildRemoteMcpSessionScript,
  buildRemotePairingScript,
  issueRemoteClientSession,
  issueRemoteMcpClientSession,
  issueRemotePairingToken,
} = makeRemoteSessions({ buildRemoteRunnerSetupScript, prepareRemoteRuntime });
export {
  buildRemoteClientSessionScript,
  buildRemoteMcpSessionScript,
  buildRemotePairingScript,
  issueRemoteMcpClientSession,
  issueRemotePairingToken,
};
export { decodeRemoteClientSessionOutput, decodeRemoteMcpSessionOutput } from "./remoteSessions.ts";
export type {
  RemoteClientSession,
  RemoteClientSessionOptions,
  RemoteMcpClientSession,
  RemoteMcpClientSessionOptions,
} from "./remoteSessions.ts";

const DEFAULT_STOP_WAIT_ATTEMPTS = 20;
const DEFAULT_STOP_WAIT_INTERVAL_SECONDS = "0.1";
const STOP_WAIT_INTERVAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Production waits 20×0.1s. Tests pass interval `0` so the loop follows process exit. */
function stopWaitPlaceholders(options: {
  readonly stopWaitAttempts?: number;
  readonly stopWaitIntervalSeconds?: string;
}): {
  readonly GOAT_STOP_WAIT_ATTEMPTS: string;
  readonly GOAT_STOP_WAIT_INTERVAL: string;
  readonly GOAT_STOP_WAIT_LABEL: string;
} {
  const attempts = options.stopWaitAttempts ?? DEFAULT_STOP_WAIT_ATTEMPTS;
  const interval = options.stopWaitIntervalSeconds ?? DEFAULT_STOP_WAIT_INTERVAL_SECONDS;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 1_000_000) {
    throw new Error(`stopWaitAttempts must be an integer from 1 to 1000000, got ${attempts}`);
  }
  if (!STOP_WAIT_INTERVAL_PATTERN.test(interval)) {
    throw new Error(`stopWaitIntervalSeconds must be a non-negative decimal, got ${interval}`);
  }
  return {
    GOAT_STOP_WAIT_ATTEMPTS: String(attempts),
    GOAT_STOP_WAIT_INTERVAL: interval,
    GOAT_STOP_WAIT_LABEL:
      attempts === DEFAULT_STOP_WAIT_ATTEMPTS && interval === DEFAULT_STOP_WAIT_INTERVAL_SECONDS
        ? "2 seconds"
        : "the stop deadline",
  };
}

export function buildRemoteStopScript(
  stateKey: string,
  options: {
    readonly ownedOnly?: boolean;
    readonly stopWaitAttempts?: number;
    readonly stopWaitIntervalSeconds?: string;
  } = {},
): string {
  return applyScriptPlaceholders(REMOTE_STOP_SCRIPT, {
    GOAT_STATE_KEY: stateKey,
    GOAT_STOP_OWNED_ONLY: options.ownedOnly === true ? "1" : "0",
    GOAT_PROTOCOL_TOKENS: REMOTE_PROTOCOL_TOKEN_SCRIPT,
    GOAT_REPLACEMENT_LOCK: REMOTE_REPLACEMENT_LOCK_SCRIPT,
    GOAT_OWNED_IDENTITY: REMOTE_OWNED_IDENTITY_SCRIPT,
    ...stopWaitPlaceholders(options),
  });
}

function buildRemoteLogTailScript(stateKey: string): string {
  return applyScriptPlaceholders(REMOTE_LOG_TAIL_SCRIPT, {
    GOAT_STATE_KEY: stateKey,
  });
}

// Keep the probe in its own shell: its exit paths and shell options must not affect launch.
function buildReconnectProbeScript(selected: PreparedRemoteRuntime) {
  return `reconnect_probe() {
sh -s -- "\${1:-}" <<'GOAT_RECONNECT_PROBE_SCRIPT'
${buildRemoteRuntimeProbeScript(selected.requestedVersion ?? "", REMOTE_RUNTIME_STATE_KEY, false, true)}
GOAT_RECONNECT_PROBE_SCRIPT
}`;
}

function buildReconnectLaunchScript(selected: PreparedRemoteRuntime, expectedProbe?: string) {
  const pending = selected.reconnectPending ?? {
    reason: "contended" as const,
    replacement: "incompatible" as const,
    requestedVersion: selected.requestedVersion ?? "",
    liveVersion: selected.version ?? "unknown",
  };
  const successor = {
    ...selected,
    version: selected.requestedVersion,
    source: "installed" as const,
    runner: { ...selected.runner, archiveVersion: selected.requestedVersion },
    retainedRunnerSha256: null,
    mayUpgradeOwnedServer: false,
    refreshIfIdle: false,
  };
  delete successor.installedExecutableSha256;
  delete successor.expectedLiveRunnerSha256;
  delete successor.expectedLiveVersion;
  return `set -eu
${
  expectedProbe === undefined
    ? ""
    : `STATE_DIR="$HOME/.goat/ssh-launch/$1"
DEFAULT_SERVER_HOME="$HOME/.goat"
${REMOTE_PROTOCOL_TOKEN_SCRIPT}
${REMOTE_REPLACEMENT_LOCK_SCRIPT}
trap 'release_recovery_lock; release_replacement_lock' EXIT
trap 'exit 1' HUP INT TERM
if ! acquire_replacement_lock; then
  if ! wait_for_replacement_lock || ! acquire_replacement_lock; then
    ${
      selected.reconnectPending === undefined
        ? ": # Launch revalidates lock-only reuse, including the drain fence."
        : `${buildRemoteContendedOutput({
            replacement: pending.replacement,
            requestedVersion: pending.requestedVersion,
            liveVersion: pending.liveVersion,
          })}
    exit 0`
    }
  fi
fi
${buildReconnectProbeScript(selected)}
probe_output="$(reconnect_probe)"
reconnect_successor=0
if [ "$probe_output" != ${shellSingleQuote(expectedProbe)} ]; then
  case "$probe_output" in
    *${shellSingleQuote(`"liveVersion":"${selected.requestedVersion}"`)}*)
      ${selected.version !== selected.requestedVersion ? "reconnect_successor=1" : ":"} ;;
  esac
  if [ "$reconnect_successor" = 0 ]; then
    printf 'GOAT_RECONNECT_PROBE=%s\\n' "$probe_output"
    printf '{"status":"reprobe"}\\n'
    exit 0
  fi
fi`
}
reconnect_launch() {
sh -s -- "$1" "\${OWNER:-}" <<'GOAT_RECONNECT_LAUNCH_SCRIPT'
${buildRemoteLaunchScript(selected.runner, expectedProbe === undefined ? selected : { ...selected, mayUpgradeOwnedServer: false }, expectedProbe !== undefined, expectedProbe === undefined)}
GOAT_RECONNECT_LAUNCH_SCRIPT
}
${
  expectedProbe !== undefined && selected.version !== selected.requestedVersion
    ? `if [ "$reconnect_successor" = 1 ]; then
reconnect_launch() {
sh -s -- "$1" "$OWNER" <<'GOAT_RECONNECT_SUCCESSOR_SCRIPT'
${buildRemoteLaunchScript(successor.runner, successor, true)}
GOAT_RECONNECT_SUCCESSOR_SCRIPT
}
fi`
    : ""
}
if launch_output="$(reconnect_launch "$1")"; then
  :
else
  launch_status=$?
  if [ "$launch_status" -ne ${REMOTE_RECONNECT_REPROBE_EXIT_CODE} ]; then exit "$launch_status"; fi
  # A guard can fail after the probe; selection must observe that race afresh.
  printf '{"status":"reprobe"}\\n'
  exit 0
fi
${expectedProbe === undefined ? "" : "printf 'GOAT_RECONNECT_PROBE=%s\\n' \"$probe_output\""}
printf '%s\\n' "$launch_output"
`;
}

export const launchOrReuseRemoteServer = Effect.fn("ssh/tunnel.launchOrReuseRemoteServer")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input?: SshAuth.SshAuthOptions,
    runner?: RemoteGoatRunnerOptions,
    onPhase?: SshRuntimeProgressCallback,
    previousSelection?: PreparedRemoteRuntime,
    onLaunched?: (launch: {
      readonly status: "ready" | "pending";
      readonly pending?: SshRuntimePendingReplacement;
    }) => Effect.Effect<
      void,
      never,
      ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
    >,
    /** The app server refused a credential recently, so this launch goes to the managed server. */
    skipAppServer = false,
  ): Effect.fn.Return<
    | {
        readonly status: "ready";
        readonly remotePort: number;
        readonly remoteServerKind: "app" | "external" | "managed" | null;
        readonly selectedRuntime: PreparedRemoteRuntime;
        readonly refresh?: "replaced";
        readonly pending?: SshRuntimePendingReplacement;
      }
    | { readonly status: "pending"; readonly pending: SshRuntimePendingReplacement },
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  > {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const stateKey = REMOTE_RUNTIME_STATE_KEY;
        yield* Effect.logInfo("ssh.remoteServer.launch.start", {
          ...sshTargetLogFields(target),
          ...sshRunnerLogFields(runner),
          stateKey,
        });
        // The host's GOAT app server comes first; see appServer.ts. It is never started, stopped,
        // replaced or updated from here, so no launch cleanup is registered for it.
        const app: AppServerProbe =
          skipAppServer || runner?.attachAppServer !== true
            ? { kind: "none" }
            : yield* restore(probeAppServer(target, input));
        if (app.kind === "attach") return yield* appServerLaunch(target, app, runner);
        const canFoldProbe =
          previousSelection?.reconnectProbe !== undefined &&
          previousSelection.requestedVersion === runner?.archiveVersion?.trim() &&
          previousSelection.runner.archiveCommitTime === runner?.archiveCommitTime &&
          (previousSelection.runner.keepExistingRunner === true) ===
            (runner?.keepExistingRunner === true) &&
          previousSelection.upgradeFailure === undefined &&
          previousSelection.updateBlocked === undefined &&
          !isNodeScriptRunner(runner) &&
          runner?.refreshOwnedRuntimeOnFirstConnection !== true &&
          runner?.confirmReplacement !== true;
        const launch = (selected: PreparedRemoteRuntime, expectedProbe?: string) => {
          const command = runSshCommand(target, {
            remoteCommandArgs: ["sh", "-l", "-s", "--", stateKey],
            stdin:
              isNodeScriptRunner(selected.runner) || selected.hostPlatform === "win32"
                ? buildRemoteLaunchScript(selected.runner, selected)
                : buildReconnectLaunchScript(selected, expectedProbe),
            timeoutStage: "runtime-launch",
            timeoutMs: isNodeScriptRunner(selected.runner)
              ? REMOTE_LAUNCH_TIMEOUT_MS
              : REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
            ...input,
          });
          return onLaunched === undefined ? restore(command) : command;
        };
        let folded = canFoldProbe
          ? yield* measureSshReconnectStep(
              "runtime-probe-folded",
              launch(
                { ...previousSelection, uploaded: false, requireInstalled: true },
                previousSelection.reconnectProbe,
              ),
            )
          : undefined;
        const observedProbe = folded?.stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith("GOAT_RECONNECT_PROBE="))
          ?.slice("GOAT_RECONNECT_PROBE=".length);
        if (
          folded !== undefined &&
          getLastNonEmptyOutputLine(folded.stdout) === '{"status":"reprobe"}'
        ) {
          yield* Effect.logDebug("ssh.runtime.reconnect.reprobe", sshTargetLogFields(target));
          folded = undefined;
        }
        const selected =
          folded !== undefined && previousSelection !== undefined
            ? { ...previousSelection, uploaded: false, requireInstalled: true }
            : yield* restore(
                prepareRemoteRuntime(
                  target,
                  input ?? {},
                  runner,
                  stateKey,
                  true,
                  onPhase,
                  observedProbe,
                ),
              );
        yield* Effect.annotateCurrentSpan("goat.runtime.selectedVersion", selected.version);
        yield* Effect.annotateCurrentSpan(
          "goat.runtime.requestedVersion",
          selected.requestedVersion,
        );
        const result = folded ?? (yield* launch(selected));
        if (!getLastNonEmptyOutputLine(result.stdout)) {
          return yield* new SshLaunchError({
            message: "SSH launch did not return a remote port.",
            stdout: result.stdout,
          });
        }
        const parsed = yield* decodeRemoteLaunchOutput(
          result.stdout
            .split(/\r?\n/u)
            .filter((line) => !line.startsWith("GOAT_RECONNECT_PROBE="))
            .join("\n"),
        ).pipe(
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
        const pending =
          parsed.pending ??
          (folded !== undefined && parsed.selectedVersion === previousSelection?.version
            ? previousSelection?.reconnectPending
            : undefined);
        if (!Number.isInteger(parsed.remotePort)) {
          return yield* new SshLaunchError({
            message: `SSH launch returned an invalid remote port: ${String(parsed.remotePort)}.`,
            stdout: result.stdout,
          });
        }
        // The response and cleanup ownership must be atomic with respect to interruption.
        if (onLaunched !== undefined)
          yield* onLaunched({ status: "ready", ...(pending === undefined ? {} : { pending }) });
        yield* Effect.logInfo("ssh.remoteServer.launch.ready", {
          ...sshTargetLogFields(target),
          remotePort: parsed.remotePort,
          remoteServerKind: parsed.serverKind ?? null,
          selectedVersion: parsed.selectedVersion ?? selected.version,
          requestedVersion: selected.requestedVersion,
          refresh: parsed.refresh ?? null,
          stateKey,
        });
        let probeOutput = result.stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith("GOAT_RECONNECT_PROBE="))
          ?.slice("GOAT_RECONNECT_PROBE=".length);
        if (
          !isNodeScriptRunner(selected.runner) &&
          // Garbage appears only when this launch installed a runtime; skip the round trip otherwise.
          (selected.uploaded === true || !selected.requireInstalled) &&
          parsed.pending === undefined &&
          parsed.refresh === undefined &&
          parsed.selectedVersion === selected.version
        ) {
          // A separate round trip makes even a hung cleanup or a dropped SSH connection best-effort.
          yield* restore(
            Effect.gen(function* () {
              const cleanup = yield* runSshCommand(target, {
                ...input,
                // The trailing word is only $1 to the script; it names this call in traces and tests.
                remoteCommandArgs: ["sh", "-l", "-s", "goat-runtime-cleanup"],
                timeoutMs: runner?.cleanupTimeoutMs ?? 10_000,
                stdin: `set -eu
DEFAULT_SERVER_HOME="$HOME/.goat"
STATE_DIR="$DEFAULT_SERVER_HOME/ssh-launch/${stateKey}"
DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
PID_FILE="$STATE_DIR/pid"; PORT_FILE="$STATE_DIR/port"; RUNNER_FILE="$STATE_DIR/run-t3.sh"
SELECTED_VERSION=${shellSingleQuote(selected.version ?? "")}
REQUESTED_VERSION=${shellSingleQuote(selected.requestedVersion ?? "")}
REMOTE_PORT=${parsed.remotePort}; GOAT_ARCHIVE_MODE=1
${REMOTE_PROTOCOL_TOKEN_SCRIPT}
${REMOTE_RUNNER_HINT_SCRIPT}
${REMOTE_REPLACEMENT_LOCK_SCRIPT}
trap 'release_recovery_lock; release_replacement_lock' EXIT
trap 'exit 1' HUP INT TERM
if [ "$GOAT_HOST_WINDOWS" = 1 ]; then exit 0; fi
if [ -e "$LOCK" ] || [ -L "$LOCK" ] || ! acquire_replacement_lock; then
  printf 'ssh.runtime.cleanup.skipped replacement lock held\\n' >&2
  exit 0
fi
${REMOTE_RUNTIME_CLEANUP_SCRIPT}
release_recovery_lock
release_replacement_lock
# Cleanup gets the full deadline under the mutex; only optional fact warming uses what remains.
${REMOTE_RUNTIME_FACT_WARMUP_SCRIPT}
# A fresh install could not be keyed before warm-up; return its baseline in this round trip.
${buildReconnectProbeScript(selected)}
if probe_output="$(reconnect_probe capture)"; then printf 'GOAT_RECONNECT_PROBE=%s\\n' "$probe_output"; fi`,
              });
              probeOutput =
                cleanup.stdout
                  .split(/\r?\n/u)
                  .find((line) => line.startsWith("GOAT_RECONNECT_PROBE="))
                  ?.slice("GOAT_RECONNECT_PROBE=".length) ?? probeOutput;
              for (const line of cleanup.stderr.split(/\r?\n/u)) {
                if (line.startsWith("ssh.runtime.cleanup.")) {
                  yield* Effect.logInfo("ssh.runtime.cleanup.result", {
                    ...sshTargetLogFields(target),
                    detail: line,
                  });
                }
              }
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("ssh.runtime.cleanup.failed", {
                  ...sshTargetLogFields(target),
                  cause,
                }),
              ),
            ),
          );
        }
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
        const durableSelection = {
          ...cachedSelection,
          runner: { ...cachedSelection.runner, confirmReplacement: false },
        };
        delete durableSelection.refreshIfIdle;
        delete durableSelection.expectedLiveVersion;
        delete durableSelection.expectedLiveRunnerSha256;
        delete durableSelection.reconnectProbe;
        delete durableSelection.reconnectPending;
        if (pending !== undefined) durableSelection.reconnectPending = pending;
        if (
          probeOutput !== undefined &&
          selected.upgradeFailure === undefined &&
          selected.updateBlocked === undefined &&
          parsed.selectedVersion === cachedSelection.version
        ) {
          const probe = yield* decodeRemoteRuntimeProbe(probeOutput).pipe(Effect.option);
          if (
            Option.isSome(probe) &&
            probe.value.reconnectKey !== undefined &&
            probe.value.platform !== "win32" &&
            probe.value.liveStatus === "live" &&
            probe.value.liveOwned === true &&
            probe.value.identityAbsent === false &&
            probe.value.liveVersion === cachedSelection.version &&
            probe.value.retainedVersion === cachedSelection.version &&
            (cachedSelection.source !== "retained" ||
              cachedSelection.retainedRunnerSha256 === null ||
              probe.value.retainedRunnerSha256 === cachedSelection.retainedRunnerSha256) &&
            probe.value.liveSignals !== undefined &&
            probe.value.liveBinarySignals !== undefined &&
            matchesSignals(probe.value.liveSignals, selected.requestedVersion ?? "") &&
            matchesSignals(probe.value.liveBinarySignals, selected.requestedVersion ?? "")
          ) {
            durableSelection.reconnectProbe = probeOutput;
            durableSelection.source = "retained";
            durableSelection.retainedRunnerSha256 = probe.value.retainedRunnerSha256 ?? null;
          }
        }
        notifyRuntimePhase(target, "starting", onPhase);
        return {
          status: "ready" as const,
          remotePort: parsed.remotePort,
          remoteServerKind: parsed.serverKind ?? null,
          selectedRuntime: {
            ...durableSelection,
            requireInstalled: !isNodeScriptRunner(selected.runner),
            ...(app.kind === "declined" ? { appServerDeclined: true } : {}),
          },
          ...(parsed.refresh === undefined ? {} : { refresh: parsed.refresh }),
          ...(pending === undefined ? {} : { pending }),
        };
      }),
    );
  },
);

const stopRemoteServer = Effect.fn("ssh/tunnel.stopRemoteServer")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuth.SshAuthOptions & { readonly ownedOnly?: boolean },
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
    stdin: buildRemoteStopScript(stateKey, { ownedOnly: input?.ownedOnly === true }),
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

/**
 * Liveness check for an open forward. On a slow link a healthy forward needs
 * longer than the fast-host window, or every reconnect would tear it down, so
 * the window covers at least two of the forward's own probes.
 */
const existingTunnelCheck = (entry: SshTunnelEntry, minimumMs: number) => ({
  baseUrl: entry.httpBaseUrl,
  timeoutMs: Math.max(minimumMs, entry.readiness.probeTimeoutMs * 2),
  probeTimeoutMs: entry.readiness.probeTimeoutMs,
});

const startSshTunnelAttempt = Effect.fn("ssh/tunnel.startSshTunnel")(function* (input: {
  readonly selectedRuntime: PreparedRemoteRuntime;
  readonly key: string;
  readonly resolvedTarget: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly authOptions: SshAuth.SshAuthOptions;
  readonly remoteServerKind: "app" | "external" | "managed" | null;
  readonly scope: Scope.Closeable;
  readonly readiness: SshReadinessBudget;
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
    Effect.provideService(Scope.Scope, input.scope),
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
  let master = yield* healthySshMaster(input.resolvedTarget);
  const platform = yield* HostProcess.Platform;
  const args = [
    ...SSH_DIAGNOSTIC_ARGS,
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
    ...SSH_KEEPALIVE_ARGS,
    "-n",
    "-N",
    "-L",
    `${input.localPort}:127.0.0.1:${input.remotePort}`,
    "--",
    hostSpec,
  ];
  const sshCommand = yield* resolveSshCommand;
  const authDirectory = ownedAuthDirectory(childEnvironment.SSH_ASKPASS);
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
  if (master !== undefined) {
    const connection = master;
    const forward = `${input.localPort}:127.0.0.1:${input.remotePort}`;
    const added = yield* runSshCommand(input.resolvedTarget, {
      ...input.authOptions,
      preHostArgs: [
        "-S",
        connection.socket,
        "-O",
        "forward",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        forward,
      ],
      timeoutMs: 5_000,
    }).pipe(Effect.result);
    if (added._tag === "Failure") {
      yield* Scope.close(connection.scope, Exit.void);
      master = undefined;
    } else {
      const services = yield* Effect.context<
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
      >();
      yield* Scope.addFinalizer(
        scope,
        runSshCommand(input.resolvedTarget, {
          ...input.authOptions,
          preHostArgs: ["-S", connection.socket, "-O", "cancel", "-L", forward],
          timeoutMs: 2_000,
        }).pipe(Effect.provideContext(services), Effect.ignore),
      );
    }
  }
  const child =
    master !== undefined
      ? { ...master.process, stderr: Stream.empty, kill: () => Effect.void }
      : yield* spawner
          .spawn(
            makeOwnedSshTunnelCommand(
              platform,
              sshCommand,
              args,
              {
                // Spawn can be interrupted before the handle's explicit kill finalizer is installed.
                forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
                env: childEnvironment,
                extendEnv: true,
                stdin: {
                  stream: Stream.empty,
                  endOnDone: true,
                },
              },
              authDirectory,
            ),
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
  const cost = yield* SshReconnectCost;
  if (cost?.active && master === undefined) cost.spawns++;
  yield* Effect.logDebug("ssh.tunnel.spawn.succeeded", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    pid: child.pid,
    localPort: input.localPort,
    remotePort: input.remotePort,
    httpBaseUrl: input.httpBaseUrl,
  });
  const tunnelEntry: SshTunnelEntry = {
    ...(master === undefined ? {} : { master }),
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
    readiness: input.readiness,
  };
  // Readiness cancels the exit waiter, but diagnostics must drain until the tunnel closes.
  let stderrTail = "";
  const stderrDrain = yield* sshDiagnosticChunks(child.stderr).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        stderrTail = (stderrTail + chunk).slice(-TUNNEL_STDERR_TAIL_CHARS);
      }),
    ),
    // Diagnostics are best-effort: a failed read must not hide the real exit.
    Effect.ignore,
    Effect.forkIn(scope),
  );
  const exitFailure = Effect.all(
    [Fiber.join(stderrDrain), child.exitCode.pipe(Effect.map(Number))],
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
    Effect.flatMap(([, exitCode]) => {
      const stderr = stderrTail;
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
      timeoutMs: input.readiness.timeoutMs,
      probeTimeoutMs: input.readiness.probeTimeoutMs,
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
          readiness: input.readiness,
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

const startSshTunnel = (input: Parameters<typeof startSshTunnelAttempt>[0]) =>
  measureSshReconnectStep("ssh/tunnel.startSshTunnel", startSshTunnelAttempt(input));

const withSshCost = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  message: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const current = yield* SshReconnectCost;
    if (current?.active) return yield* effect;
    const cost = {
      active: true,
      spawns: 0,
      authentications: 0,
      mastersStarted: 0,
      controlCommands: 0,
      steps: {},
    };
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(
      Effect.provideService(SshReconnectCost, cost),
      Effect.ensuring(
        Effect.gen(function* () {
          const wallMs = (yield* Clock.currentTimeMillis) - startedAt;
          // A retained tunnel's diagnostic drain must not mutate an already emitted summary.
          cost.active = false;
          yield* Effect.logInfo(message).pipe(
            Effect.annotateLogs({
              spawns: cost.spawns,
              authentications: cost.authentications,
              mastersStarted: cost.mastersStarted,
              controlCommands: cost.controlCommands,
              wallMs,
              steps: cost.steps,
            }),
          );
        }),
      ),
    );
  });

const withReconnectCost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withSshCost(effect, "ssh.reconnect.cost");

const makeSshEnvironmentManager = Effect.fn("ssh/tunnel.SshEnvironmentManager.make")(function* (
  options: SshEnvironmentManagerOptions = {},
): Effect.fn.Return<SshEnvironmentManagerShape, never, Scope.Scope> {
  const managerScope = yield* Scope.Scope;
  const sharing = {
    configurations: new Map<string, string>(),
    masters: new Map<string, SshMasterConnection>(),
  };
  const tunnels = new Map<string, SshTunnelEntry>();
  // Until when each target skips the GOAT app server after it refused a credential.
  const appServerRefusals = new Map<string, number>();
  // One slot per target, consumed by the next ensure attempt.
  const reconnectSelections = new Map<string, ReconnectSelection>();
  const selectionRevisions = new Map<string, number>();
  const takeReconnectSelection = (key: string) => {
    const selection = reconnectSelections.get(key);
    reconnectSelections.delete(key);
    return selection;
  };
  const invalidateReconnectSelection = (key: string) => {
    selectionRevisions.set(key, (selectionRevisions.get(key) ?? 0) + 1);
    reconnectSelections.delete(key);
    const entry = tunnels.get(key);
    if (entry !== undefined) delete entry.reconnectSelection;
    const intent = pendingReplacements.get(key);
    if (intent !== undefined) intent.reconnectSelection = undefined;
  };
  interface Attachment {
    readonly id: string;
    readonly operationId: string;
    readonly generation: number;
    readonly selection: PreparedRemoteRuntime;
    readonly localPort: number;
    readonly remotePort: number;
    readonly version: string | null;
    readonly pin: ManagedPin | undefined;
  }
  interface PreparedEnsure {
    readonly operationId: string;
    readonly key: string;
    readonly generation: number;
    readonly runner: RemoteGoatRunnerOptions | undefined;
    readonly result: SshTunnelEntry | DesktopSshRuntimePendingResult;
    readonly attachment?: Attachment;
  }
  const attachments = new WeakMap<SshTunnelEntry, Attachment>();
  const flights = yield* makeEnsureFlights<PreparedEnsure, SshEnvironmentEffectError>({
    scope: managerScope,
  });
  const firstConnectionDecisions = new Set<string>();
  const generations = new Map<string, number>();
  const resolvedTargets = new Map<string, DesktopSshEnvironmentTarget>();
  const statuses = new Map<string, SshHostResult>();
  const acquisitionFailures = new Map<string, SshHostFailure>();
  const setupOperations = new Map<
    string,
    SshHostSetupProgress & { readonly diagnosisRequired?: boolean }
  >();
  const forgotten = new Set<string>();
  const setupFields = (key: string, stage?: SshHostSetupProgress["stage"]) => {
    const previous = setupOperations.get(key);
    if (previous === undefined) return {};
    const setup = { ...previous, stage: stage ?? previous.stage };
    setupOperations.set(key, setup);
    return {
      setup: { operationId: setup.operationId, generation: setup.generation, stage: setup.stage },
    };
  };
  const {
    managedAliases,
    observedPins,
    managedDirectory,
    pinError,
    readManagedPin,
    samePin,
    validateManagedPin,
  } = makeManagedTrust();
  type ManagedPin = NonNullable<Effect.Success<ReturnType<typeof readManagedPin>>>;
  const reconnectIdentity = (
    target: DesktopSshEnvironmentTarget,
    runner: RemoteGoatRunnerOptions | undefined,
    pin: ManagedPin | undefined,
  ) =>
    JSON.stringify([
      targetConnectionKey(target),
      sharing.configurations.get(target.alias),
      pin,
      runner?.archiveVersion?.trim(),
      runner?.archiveCommitTime,
      runner?.nodeScriptPath,
      runner?.keepExistingRunner === true,
    ]);
  const { enrichFailure } = makeFailureEnrichment({ managedDirectory, resolvedTargets });
  const setupTerminalFailure = (key: string) => {
    const current = statuses.get(key)?.status;
    return (
      current?.setup?.stage === "complete" &&
      current.state === "failed" &&
      [
        "diagnosis_failed",
        "approval_expired",
        "authorization_revoked",
        "operation_failed",
      ].includes(current.failure?.reason ?? "")
    );
  };
  const publishPhase = (
    key: string,
    target: DesktopSshEnvironmentTarget,
    requestedVersion: string,
    phase: SshRuntimePhase,
    onPhase?: SshRuntimeProgressCallback,
    upload?: SshHostStatus["upload"],
  ) => {
    if (setupTerminalFailure(key)) return;
    const previous = statuses.get(key);
    const previousUpload = previous?.status?.upload;
    if (
      upload !== undefined &&
      previousUpload !== undefined &&
      upload.totalBytes === previousUpload.totalBytes &&
      upload.sentBytes >= previousUpload.sentBytes &&
      upload.sentBytes - previousUpload.sentBytes < 1024 * 1024 &&
      upload.sentBytes !== upload.totalBytes
    )
      return;
    statuses.set(key, {
      kind: "ok",
      status: {
        host: target.alias || target.hostname,
        requestedVersion,
        runtimeVersion: previous?.status?.runtimeVersion ?? null,
        state: "preparing",
        phase,
        ...(upload === undefined ? {} : { upload }),
        ...setupFields(key, "runtime"),
      },
    });
    notifyRuntimePhase(target, phase, onPhase, upload);
  };
  const deferredArchiveRefresh = (requestedVersion: string) => ({
    reason: "archive_unavailable" as const,
    requestedVersion,
    detail: `Upgrade to ${requestedVersion} deferred`,
  });
  const deferredDrainRefresh = (requestedVersion: string) => ({
    reason: "archive_unavailable" as const,
    refreshCause: "drain_unavailable" as const,
    requestedVersion,
    detail: "Refresh deferred: this runtime could not drain for the refresh",
  });
  const publishResult = Effect.fn("ssh/tunnel.publishResult")(function* (
    key: string,
    target: DesktopSshEnvironmentTarget,
    result: SshTunnelEntry | DesktopSshRuntimePendingResult,
    runner?: RemoteGoatRunnerOptions,
  ) {
    if (closed || setupTerminalFailure(key)) return;
    const generation = generations.get(key) ?? 0;
    const intent = pendingReplacements.get(key);
    const pending = "type" in result ? result.pending : intent?.pending;
    const host = target.alias || target.hostname;
    const runtimeVersion =
      "type" in result ? result.pending.liveVersion : result.selectedRuntime.version;
    const requestedVersion = pending?.requestedVersion ?? runner?.archiveVersion?.trim() ?? "";
    const base = { host, runtimeVersion, requestedVersion };
    const observed = statuses.get(key);
    const drainAttached =
      !("type" in result) &&
      result.attachmentInvalidated !== true &&
      result.uncertainDrain !== true &&
      pending?.refreshCause === "drain_unavailable" &&
      (pending.replacement === "older" || pending.replacement === "capability") &&
      pending.liveVersion === runtimeVersion &&
      result.selectedRuntime.requestedVersion === requestedVersion &&
      intent?.requestedRunner.archiveVersion?.trim() === requestedVersion &&
      intent.generation === generation &&
      tunnels.get(key) === result &&
      (yield* result.process.isRunning.pipe(Effect.orElseSucceed(() => false)));
    if (
      closed ||
      (generations.get(key) ?? 0) !== generation ||
      pendingReplacements.get(key) !== intent ||
      (!("type" in result) && tunnels.get(key) !== result) ||
      (drainAttached &&
        (result.attachmentInvalidated === true || statuses.get(key) !== observed)) ||
      setupTerminalFailure(key)
    )
      return;
    let snapshot: SshHostStatus;
    if (drainAttached) {
      const refreshDeferred = deferredDrainRefresh(requestedVersion);
      snapshot = { ...base, state: "ready", refreshDeferred, detail: refreshDeferred.detail };
      acquisitionFailures.delete(key);
    } else if (pending !== undefined) {
      const detail =
        pending.detail === "recovery-stale"
          ? "Check that no other GOAT client is updating this host before clearing the stale lock."
          : pending.reason === "contended"
            ? `Another computer is updating ${host}. GOAT will retry.`
            : pending.reason === "unknown"
              ? `GOAT can't tell whether ${host} is busy. It retries every 10 minutes.`
              : `Update to ${requestedVersion} waits for running work`;
      snapshot = { ...base, state: "update_waiting", waitingReason: pending.reason, detail };
    } else if (!("type" in result) && result.selectedRuntime.upgradeFailure !== undefined) {
      const refreshDeferred = deferredArchiveRefresh(requestedVersion);
      snapshot = { ...base, state: "ready", refreshDeferred, detail: refreshDeferred.detail };
      acquisitionFailures.set(key, result.selectedRuntime.upgradeFailure);
    } else if (!("type" in result) && result.selectedRuntime.updateBlocked !== undefined) {
      snapshot = { ...base, state: "update_blocked", detail: result.selectedRuntime.updateBlocked };
    } else {
      snapshot = { ...base, state: "ready" };
      if (runtimeVersion === requestedVersion) acquisitionFailures.delete(key);
    }
    const setup = setupOperations.get(key);
    const providers = statuses.get(key)?.status?.providers;
    if (snapshot.state === "ready" && setup?.stage === "complete" && providers !== undefined)
      snapshot = {
        ...snapshot,
        state: providers.ready ? "ready" : "providers_not_ready",
        providers,
      };
    snapshot = {
      ...snapshot,
      ...setupFields(
        key,
        snapshot.state === "ready" &&
          setup?.stage !== "complete" &&
          setup?.diagnosisRequired !== false
          ? "diagnosis"
          : "complete",
      ),
    };
    statuses.set(key, { kind: "ok", status: snapshot });
  });
  const publishFailure = Effect.fn("ssh/tunnel.publishFailure")(function* (
    key: string,
    target: DesktopSshEnvironmentTarget,
    runner: RemoteGoatRunnerOptions | undefined,
    error: SshEnvironmentEffectError,
  ) {
    if (error instanceof SshEnsureSupersededError) return;
    const generation = generations.get(key) ?? 0;
    let result = runtimeFailureResult(
      target.alias || target.hostname,
      runner?.archiveVersion?.trim() ?? "",
      statuses.get(key)?.status?.runtimeVersion ?? null,
      error,
    );
    if (
      result.status?.failure?.reason === "archive_unavailable" ||
      result.status?.failure?.reason === "unsupported_platform"
    )
      acquisitionFailures.set(key, result.status.failure);
    result = yield* enrichFailure(target, result);
    if (closed || (generations.get(key) ?? 0) !== generation) return;
    if (result.status !== undefined)
      result = { ...result, status: { ...result.status, ...setupFields(key, "complete") } };
    statuses.set(key, result);
  });
  // A disconnect waits on the target lock, then acts on the completed launch result.
  const cancelledLaunches = new Map<string, boolean>();
  const pendingReplacements = new Map<
    string,
    {
      target: DesktopSshEnvironmentTarget;
      requestedRunner: RemoteGoatRunnerOptions;
      generation: number;
      managedPin?: ManagedPin;
      nextAttemptAt: number;
      reconnectSelection: ReconnectSelection | undefined;
    } & (
      | { pending: SshRuntimePendingReplacement; archiveFailure?: never }
      | { pending?: never; archiveFailure: SshHostFailure }
    )
  >();
  const takePendingReconnectSelection = (key: string) => {
    const intent = pendingReplacements.get(key);
    const selection = intent?.reconnectSelection;
    if (intent !== undefined) intent.reconnectSelection = undefined;
    return selection;
  };
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
  const {
    latestRequest,
    takeRequestTicket,
    disconnectSuperseded,
    ensureSuperseded,
    withTargetLock,
    notReady,
    withIdleTargetLock,
  } = makeTargetAdmission(targetLocks);

  const closeTunnelEntry = Effect.fn("ssh/tunnel.closeTunnelEntry")(function* (
    entry: SshTunnelEntry,
  ) {
    attachments.delete(entry);
    yield* Effect.logDebug("ssh.tunnel.close.start", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
    if (entry.master !== undefined)
      yield* Scope.close(entry.master.scope, Exit.void).pipe(Effect.ignore);
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
      reconnectSelections.clear();
      resolvedTargets.clear();
      statuses.clear();
      acquisitionFailures.clear();
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
      prompt: `Enter the SSH password or verification code for ${hostSpec}.`,
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

  const createTunnel = Effect.fn("ssh/tunnel.ensureTunnelEntry.create")(function* (input: {
    readonly key: string;
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly keyOnly?: boolean;
    readonly runner?: RemoteGoatRunnerOptions;
    readonly previous?: SshTunnelEntry;
    readonly previousLocalPort?: number;
    readonly previousSelection?: ReconnectSelection;
    readonly background?: boolean;
    readonly onPhase?: SshRuntimeProgressCallback;
    /** A request admitted under this generation; a newer one supersedes it before any launch. */
    readonly expectedGeneration?: number;
  }): Effect.fn.Return<
    SshTunnelEntry | DesktopSshRuntimePendingResult,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext | Scope.Scope
  > {
    yield* Effect.logDebug("ssh.environment.tunnel.create.start", {
      ...sshTargetLogFields(input.resolvedTarget),
      ...sshRunnerLogFields(input.runner),
      key: input.key,
    });
    const generation = generations.get(input.key) ?? 0;
    if (input.expectedGeneration !== undefined && input.expectedGeneration !== generation)
      return yield* supersededPreparation();
    const previousSelection =
      input.previousSelection?.revision === (selectionRevisions.get(input.key) ?? 0)
        ? input.previousSelection
        : undefined;
    invalidateReconnectSelection(input.key);
    const revision = selectionRevisions.get(input.key) ?? 0;
    const managedPin = yield* validateManagedPin(input.resolvedTarget);
    const identity = reconnectIdentity(input.resolvedTarget, input.runner, managedPin);
    if (closed || (generations.get(input.key) ?? 0) !== generation)
      return yield* supersededPreparation();
    const phase: SshRuntimeProgressCallback = ({ phase, upload }) => {
      // A background refresh of a host whose forward still works keeps its published status;
      // "preparing" would drop provider diagnosis and flap a healthy host every ten minutes.
      if (input.background === true && tunnels.has(input.key)) return;
      if (!closed && (generations.get(input.key) ?? 0) === generation) {
        publishPhase(
          input.key,
          input.resolvedTarget,
          input.runner?.archiveVersion?.trim() ?? "",
          phase,
          input.onPhase,
          upload,
        );
      }
    };
    // The caller skipped "connecting" while a forward existed; that forward was found stale.
    if (input.previousLocalPort !== undefined && !tunnels.has(input.key))
      phase({ target: input.resolvedTarget, phase: "connecting" });
    const launchScope = yield* Scope.Scope;
    let launchTransferred = false;
    const operation = (authOptions: SshAuth.SshAuthOptions) =>
      Effect.gen(function* () {
        yield* ensureSshMaster(input.resolvedTarget, authOptions, managerScope);
        const currentPin = yield* readManagedPin(input.resolvedTarget);
        // Preparation is cancellable; launch registers cleanup before restoring interruption.
        return yield* Effect.interruptible(
          launchOrReuseRemoteServer(
            input.resolvedTarget,
            authOptions,
            input.runner,
            phase,
            (selectionRevisions.get(input.key) ?? 0) === revision &&
              previousSelection?.generation === (generations.get(input.key) ?? 0) &&
              previousSelection.identity ===
                reconnectIdentity(input.resolvedTarget, input.runner, currentPin)
              ? previousSelection.runtime
              : undefined,
            (launch) =>
              Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  if (
                    launchTransferred ||
                    launch.status !== "ready" ||
                    launch.pending !== undefined ||
                    options.leaveRemoteServerRunning === true ||
                    pendingReplacements.has(input.key) ||
                    tunnels.has(input.key)
                  )
                    return;
                  yield* stopRemoteServer(input.resolvedTarget, authOptions).pipe(Effect.ignore);
                }),
              ).pipe(Effect.provideService(Scope.Scope, launchScope)),
            (appServerRefusals.get(input.key) ?? 0) > (yield* Clock.currentTimeMillis),
          ),
        );
      });
    const launchStartedAt = yield* Clock.currentTimeMillis;
    const observedLaunch = yield* (
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
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.sync(() => {
              const previous = input.previous ?? tunnels.get(input.key);
              if (previous !== undefined) {
                previous.uncertainDrain = true;
                attachments.delete(previous);
              }
            }),
      ),
    );
    const deferredIntent = pendingReplacements.get(input.key);
    const retainedPending = deferredIntent?.pending;
    const remoteLaunch =
      observedLaunch.status === "ready" &&
      // A managed replacement intent never describes the app server.
      observedLaunch.remoteServerKind !== "app" &&
      observedLaunch.pending === undefined &&
      retainedPending !== undefined &&
      deferredIntent !== undefined &&
      deferredIntent.generation === generation &&
      observedLaunch.selectedRuntime.requestedVersion === retainedPending.requestedVersion &&
      observedLaunch.selectedRuntime.version === retainedPending.liveVersion &&
      observedLaunch.selectedRuntime.version !== retainedPending.requestedVersion &&
      observedLaunch.selectedRuntime.updateBlocked === undefined &&
      observedLaunch.selectedRuntime.upgradeFailure === undefined
        ? {
            ...observedLaunch,
            pending: retainedPending,
            selectedRuntime: {
              ...observedLaunch.selectedRuntime,
              reconnectPending: retainedPending,
            },
          }
        : observedLaunch;
    const currentPin = yield* readManagedPin(input.resolvedTarget).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (
      !closed &&
      (generations.get(input.key) ?? 0) === generation &&
      !samePin(managedPin, currentPin)
    ) {
      generations.set(input.key, (generations.get(input.key) ?? 0) + 1);
      invalidateReconnectSelection(input.key);
      pendingReplacements.delete(input.key);
      setupOperations.delete(input.key);
      const error = pinError(
        managedPin !== undefined &&
          currentPin !== undefined &&
          managedPin.fingerprint !== currentPin.fingerprint,
      );
      yield* publishFailure(input.key, input.resolvedTarget, input.runner, error);
      return yield* error;
    }
    // The launch round trip measures this link; the forward's readiness budget scales with it.
    const launchMs = (yield* Clock.currentTimeMillis) - launchStartedAt;
    if (closed || (generations.get(input.key) ?? 0) !== generation) {
      const stop =
        remoteLaunch.status === "ready" &&
        remoteLaunch.remoteServerKind !== "app" &&
        remoteLaunch.pending === undefined;
      if (!closed) {
        cancelledLaunches.set(input.key, stop);
        launchTransferred = true;
      }
      return yield* supersededPreparation();
    }
    const archiveFailure =
      remoteLaunch.status === "ready" ? remoteLaunch.selectedRuntime.upgradeFailure : undefined;
    const needsArchiveRetry = archiveFailure?.reason === "archive_unavailable";
    if ((remoteLaunch.pending !== undefined || needsArchiveRetry) && input.runner !== undefined) {
      const previousIntent = pendingReplacements.get(input.key);
      const sameIntent =
        previousIntent !== undefined &&
        previousIntent.generation === generation &&
        previousIntent.requestedRunner.archiveVersion === input.runner.archiveVersion;
      const intent = {
        target: input.resolvedTarget,
        // A person's request stays manual on every retry, so the runtime never arbitrates it.
        requestedRunner: sameIntent
          ? {
              ...previousIntent.requestedRunner,
              ...(input.runner.manualRefresh === true ? { manualRefresh: true } : {}),
            }
          : { ...input.runner, confirmReplacement: false },
        generation,
        ...(managedPin === undefined ? {} : { managedPin }),
        nextAttemptAt: sameIntent
          ? previousIntent.nextAttemptAt
          : (yield* Clock.currentTimeMillis) + 600_000,
        reconnectSelection:
          remoteLaunch.status === "ready"
            ? { runtime: remoteLaunch.selectedRuntime, generation, revision, identity }
            : undefined,
      };
      if (remoteLaunch.pending !== undefined) {
        yield* Effect.logWarning("ssh.runtime.refresh.deferred", {
          ...sshTargetLogFields(input.resolvedTarget),
          liveVersion: remoteLaunch.pending.liveVersion,
          requestedVersion: remoteLaunch.pending.requestedVersion,
          reason: remoteLaunch.pending.reason,
          replacement: remoteLaunch.pending.replacement,
          detail: remoteLaunch.pending.detail,
          retryInMinutes: 10,
        });
        pendingReplacements.set(input.key, { ...intent, pending: remoteLaunch.pending });
      } else if (needsArchiveRetry) {
        yield* Effect.logWarning("ssh.runtime.refresh.deferred", {
          ...sshTargetLogFields(input.resolvedTarget),
          actualVersion:
            remoteLaunch.status === "ready" ? remoteLaunch.selectedRuntime.version : null,
          requestedVersion: archiveFailure.archive?.requestedVersion,
          reason: archiveFailure.reason,
          sourcesTried: archiveFailure.archive?.sourcesTried,
          retryInMinutes: 10,
        });
        pendingReplacements.set(input.key, { ...intent, archiveFailure });
      }
    }
    if (setupTerminalFailure(input.key)) pendingReplacements.delete(input.key);
    // The host already runs the requested build (another client, a self-update or a person
    // replaced it), so an intent kept from the older server must not report or retry an update.
    if (
      remoteLaunch.status === "ready" &&
      remoteLaunch.pending === undefined &&
      !needsArchiveRetry &&
      (remoteLaunch.selectedRuntime.version === remoteLaunch.selectedRuntime.requestedVersion ||
        // The managed runtime is not in use while the app server serves this host.
        remoteLaunch.remoteServerKind === "app")
    )
      pendingReplacements.delete(input.key);
    if (remoteLaunch.status === "pending") {
      const previous = input.previous ?? tunnels.get(input.key);
      if (previous !== undefined) {
        previous.attachmentInvalidated = true;
        attachments.delete(previous);
      }
      return pendingResult(input.resolvedTarget, remoteLaunch.pending);
    }
    const reconnectSelection = {
      runtime: remoteLaunch.selectedRuntime,
      generation,
      revision,
      identity,
    };
    if (
      input.previous !== undefined &&
      remoteLaunch.refresh !== "replaced" &&
      input.previous.remotePort === remoteLaunch.remotePort &&
      input.previous.selectedRuntime.version === remoteLaunch.selectedRuntime.version
    ) {
      if (remoteLaunch.pending === undefined && !needsArchiveRetry)
        pendingReplacements.delete(input.key);
      // Keep the forward's identity for its finalizer while updating the latest selection.
      input.previous.selectedRuntime = remoteLaunch.selectedRuntime;
      input.previous.attachmentInvalidated = false;
      input.previous.uncertainDrain = false;
      input.previous.reconnectSelection = reconnectSelection;
      launchTransferred = true;
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
    // Shutdown also owns forwards still awaiting readiness, before they enter the tunnel map.
    const entryScope = yield* Scope.fork(managerScope, "sequential");
    const start = (authOptions: SshAuth.SshAuthOptions) =>
      Effect.gen(function* () {
        if (input.previous?.master !== undefined)
          yield* ensureSshMaster(input.resolvedTarget, authOptions, managerScope);
        return yield* startSshTunnel({
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
          readiness: sshReadinessBudget(launchMs),
        });
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
      if (!closed) {
        cancelledLaunches.set(
          input.key,
          remoteLaunch.pending === undefined && remoteLaunch.remoteServerKind !== "app",
        );
        launchTransferred = true;
      }
      return yield* supersededPreparation();
    }
    yield* Effect.gen(function* () {
      tunnels.set(input.key, tunnelEntry);
      tunnelEntry.reconnectSelection = reconnectSelection;
      if (remoteLaunch.pending === undefined && !needsArchiveRetry)
        pendingReplacements.delete(input.key);
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
            // GOAT never stops the app server it only attached to.
            tunnelEntry.remoteServerKind === "app" ||
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
            Effect.provideService(SshConnectionSharing, sharing),
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
      launchTransferred = true;
    }).pipe(Effect.uninterruptible);
    yield* Effect.logDebug("ssh.environment.tunnel.create.succeeded", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    return tunnelEntry;
  }, withReconnectCost);

  const createTunnelEntry = (input: Parameters<typeof createTunnel>[0]) =>
    createTunnel(input).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.gen(function* () {
          const master = sharing.masters.get(input.key);
          if (master !== undefined && tunnels.get(input.key)?.master !== master)
            yield* Scope.close(master.scope, Exit.void);
        }),
      ),
    );

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
    retainSelection = false,
    // Only a caller that reconnects right away may drop a forward for the app server.
    allowAppServerMove = false,
  ) {
    const logFields = {
      ...sshTargetLogFields(entry.target),
      key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    };
    yield* Effect.logDebug("ssh.environment.tunnel.existing.check", logFields);
    // A forward whose ssh process already exited (after sleep, or a keepalive timeout) cannot
    // answer, so skip the readiness window. An unreadable state falls back to the HTTP check.
    const forwardRunning = yield* entry.process.isRunning.pipe(Effect.orElseSucceed(() => true));
    let runtimeChanged = false;
    if (!forwardRunning) {
      yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
        ...logFields,
        reason: "forward-exited",
      });
    } else {
      const readinessExit = yield* Effect.exit(
        waitForHttpReady(existingTunnelCheck(entry, EXISTING_TUNNEL_CHECK_TIMEOUT_MS)),
      );
      if (Exit.isSuccess(readinessExit)) {
        const selectedVersion = entry.selectedRuntime.version;
        const descriptor =
          selectedVersion === null || selectedVersion === ""
            ? undefined
            : yield* readForwardDescriptor(entry.httpBaseUrl, entry.readiness.probeTimeoutMs);
        const liveVersion = descriptor?.serverVersion;
        const moveToAppServer =
          allowAppServerMove &&
          (appServerRefusals.get(key) ?? 0) <= (yield* Clock.currentTimeMillis) &&
          (liveVersion === undefined || liveVersion === selectedVersion) &&
          (yield* shouldMoveToAppServer({
            descriptor,
            remoteServerKind: entry.remoteServerKind,
            selection: entry.selectedRuntime,
            httpBaseUrl: entry.httpBaseUrl,
            timeoutMs: entry.readiness.probeTimeoutMs,
          }));
        if ((liveVersion === undefined || liveVersion === selectedVersion) && !moveToAppServer) {
          yield* Effect.logDebug("ssh.environment.tunnel.reused", logFields);
          return true;
        }
        // Reconnecting re-reads the live server, so the reported version and every runtime
        // decision follow the server that now answers, never this attachment's old selection.
        runtimeChanged = true;
        yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
          ...logFields,
          reason: moveToAppServer ? "app-server" : "runtime-changed",
          selectedVersion,
          liveVersion,
        });
      } else {
        yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
          ...logFields,
          cause: readinessExit.cause,
        });
      }
    }
    yield* Effect.gen(function* () {
      if (tunnels.get(key) === entry) {
        const selection = entry.reconnectSelection;
        // Wake cleanup may finish before reconnect reaches the lock. Keep only launch proof,
        // whose host-side fingerprint is still checked by the folded command.
        if (
          retainSelection &&
          !runtimeChanged &&
          !closed &&
          !forgotten.has(key) &&
          entry.attachmentInvalidated !== true &&
          entry.uncertainDrain !== true &&
          selection !== undefined &&
          selection.revision === (selectionRevisions.get(key) ?? 0) &&
          selection.generation === (generations.get(key) ?? 0)
        )
          reconnectSelections.set(key, selection);
        if (entry.attachmentInvalidated === true || entry.uncertainDrain === true || runtimeChanged)
          invalidateReconnectSelection(key);
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
    reuseWhileRefreshPending: boolean = false,
    onPhase?: SshRuntimeProgressCallback,
    allowFoldedProbe = true,
    capturedSelection?: ReconnectSelection,
  ): Effect.fn.Return<
    SshTunnelEntry | DesktopSshRuntimePendingResult,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const entry = tunnels.get(key);
    const retainedSelection = takeReconnectSelection(key);
    const pendingSelection = takePendingReconnectSelection(key);
    const selection =
      entry?.reconnectSelection ?? retainedSelection ?? capturedSelection ?? pendingSelection;
    if (entry !== undefined) delete entry.reconnectSelection;
    const managedPin = yield* validateManagedPin(resolvedTarget);
    keyOnly = keyOnly || managedPin !== undefined;
    const previousSelection =
      allowFoldedProbe &&
      entry?.attachmentInvalidated !== true &&
      entry?.uncertainDrain !== true &&
      runner?.refreshOwnedRuntimeOnFirstConnection !== true &&
      selection?.revision === (selectionRevisions.get(key) ?? 0) &&
      selection?.generation === (generations.get(key) ?? 0) &&
      selection.identity === reconnectIdentity(resolvedTarget, runner, managedPin)
        ? selection
        : undefined;
    if (entry !== undefined) {
      if (entry.attachmentInvalidated === true || entry.uncertainDrain === true)
        allowFoldedProbe = false;
      // The background retry owns a deferred refresh; this caller only needs a forward.
      if (
        reuseWhileRefreshPending &&
        pendingReplacements.has(key) &&
        entry.attachmentInvalidated !== true &&
        entry.uncertainDrain !== true
      ) {
        if (yield* keepAnsweringTunnel(key, entry, false, true)) {
          if (
            previousSelection !== undefined &&
            selection !== undefined &&
            selection.revision === (selectionRevisions.get(key) ?? 0)
          )
            entry.reconnectSelection = selection;
          return entry;
        }
        // The stale forward is closed; connect anew, refreshing if the host is idle now.
        return yield* createTunnelEntry({
          key,
          resolvedTarget,
          keyOnly,
          ...(runner === undefined ? {} : { runner }),
          previousLocalPort: entry.localPort,
          ...(previousSelection === undefined ? {} : { previousSelection }),
          background,
          ...(onPhase === undefined ? {} : { onPhase }),
        });
      }
      if (
        allowFoldedProbe &&
        pendingReplacements.has(key) &&
        runner?.refreshOwnedRuntimeOnFirstConnection !== true
      ) {
        if (yield* keepAnsweringTunnel(key, entry, false, true)) {
          if (
            previousSelection !== undefined &&
            selection !== undefined &&
            selection.revision === (selectionRevisions.get(key) ?? 0)
          )
            entry.reconnectSelection = selection;
          return entry;
        }
        return yield* createTunnelEntry({
          key,
          resolvedTarget,
          keyOnly,
          ...(runner === undefined ? {} : { runner }),
          previousLocalPort: entry.localPort,
          ...(previousSelection === undefined ? {} : { previousSelection }),
          background,
          ...(onPhase === undefined ? {} : { onPhase }),
        });
      }
      const replace =
        entry.attachmentInvalidated === true ||
        entry.uncertainDrain === true ||
        pendingReplacements.has(key) ||
        runner?.refreshOwnedRuntimeOnFirstConnection === true;
      if (!replace && (yield* keepAnsweringTunnel(key, entry, false, true))) {
        if (
          previousSelection !== undefined &&
          selection !== undefined &&
          selection.revision === (selectionRevisions.get(key) ?? 0)
        )
          entry.reconnectSelection = selection;
        return entry;
      }
      if (replace) {
        const readiness = yield* Effect.exit(waitForHttpReady(existingTunnelCheck(entry, 2_000)));
        if (Exit.isSuccess(readiness)) {
          return yield* createTunnelEntry({
            key,
            resolvedTarget,
            ...(runner === undefined ? {} : { runner }),
            previous: entry,
            background,
            keyOnly,
            ...(onPhase === undefined ? {} : { onPhase }),
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
      ...(previousSelection === undefined ||
      selection?.revision !== (selectionRevisions.get(key) ?? 0)
        ? {}
        : { previousSelection }),
      background,
      ...(onPhase === undefined ? {} : { onPhase }),
    });
  });

  const startRetry = Effect.gen(function* () {
    if (retryStarted) return;
    retryStarted = true;
    const context = (yield* Effect.context<SshEnvironmentEffectContext>()).pipe(
      Context.omit(Scope.Scope, SshHostAnswered, SshReconnectCost),
    );
    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("1 minute");
        if (closed) return;
        const now = yield* Clock.currentTimeMillis;
        for (const [key, intent] of pendingReplacements) {
          if (intent.nextAttemptAt > now) continue;
          const retryRunner = {
            ...intent.requestedRunner,
            refreshOwnedRuntimeOnFirstConnection: true,
            confirmReplacement: false,
          };
          yield* Effect.scoped(
            flights.join({
              key,
              generation: intent.generation,
              intent: preparationIntent(retryRunner, { keyOnly: true, refreshRuntime: true }, true),
              terminal: preparationTerminal,
              prepare: (report) =>
                withTargetLock(
                  key,
                  Effect.gen(function* () {
                    if (
                      closed ||
                      pendingReplacements.get(key) !== intent ||
                      (generations.get(key) ?? 0) !== intent.generation
                    )
                      return yield* supersededPreparation();
                    if (intent.managedPin !== undefined) {
                      const current = yield* readManagedPin(intent.target).pipe(
                        Effect.orElseSucceed(() => undefined),
                      );
                      if (!samePin(intent.managedPin, current)) {
                        pendingReplacements.delete(key);
                        generations.set(key, (generations.get(key) ?? 0) + 1);
                        invalidateReconnectSelection(key);
                        setupOperations.delete(key);
                        acquisitionFailures.delete(key);
                        forgotten.add(key);
                        const error = pinError(
                          current !== undefined &&
                            current.fingerprint !== intent.managedPin.fingerprint,
                        );
                        yield* publishFailure(key, intent.target, intent.requestedRunner, error);
                        const entry = tunnels.get(key);
                        if (entry !== undefined) {
                          tunnels.delete(key);
                          yield* closeTunnelEntry(entry);
                        }
                        authSecrets.delete(key);
                        return yield* error;
                      }
                    }
                    intent.nextAttemptAt = (yield* Clock.currentTimeMillis) + 600_000;
                    const result = yield* ensureTunnelEntry(
                      key,
                      intent.target,
                      retryRunner,
                      true,
                      true,
                      false,
                      ({ phase, upload }) => report.onPhase(phase, upload),
                    );
                    if (closed || (generations.get(key) ?? 0) !== intent.generation)
                      return yield* supersededPreparation();
                    yield* publishResult(key, intent.target, result, intent.requestedRunner);
                    if (!("type" in result) && !pendingReplacements.has(key)) {
                      firstConnectionDecisions.add(
                        `${key}:${intent.requestedRunner.archiveVersion ?? intent.requestedRunner.nodeScriptPath ?? ""}`,
                      );
                    }
                    const pin = yield* readManagedPin(intent.target);
                    return {
                      key,
                      operationId: report.operationId,
                      generation: intent.generation,
                      runner: retryRunner,
                      result,
                      ...("type" in result
                        ? {}
                        : {
                            attachment: rememberAttachment(
                              result,
                              intent.generation,
                              report.operationId,
                              pin,
                            ),
                          }),
                    };
                  }),
                ).pipe(
                  withReconnectCost,
                  Effect.provideService(SshReconnectCost, null),
                  Effect.provideService(SshHostAnswered, report.onHostAnswered),
                  Effect.annotateLogs({
                    key,
                    generation: intent.generation,
                    operationId: report.operationId,
                  }),
                ),
            }),
          ).pipe(
            Effect.tapError((cause) =>
              Effect.gen(function* () {
                if (!closed && (generations.get(key) ?? 0) === intent.generation)
                  yield* publishFailure(key, intent.target, intent.requestedRunner, cause);
                yield* Effect.logWarning("ssh.runtime.retry.failed", {
                  alias: intent.target.alias,
                  cause,
                });
              }),
            ),
            Effect.ignore,
          );
        }
      }
    }).pipe(
      Effect.provide(context),
      // Deferred preparations own their cost even when the initiating ensure is still running.
      Effect.provideService(SshReconnectCost, null),
      Effect.forkIn(managerScope),
    );
  });

  // Only preparation policy participates: tokens, callbacks and request identity are per waiter.
  const preparationIntent = (
    runner: RemoteGoatRunnerOptions | undefined,
    requestOptions: SshEnvironmentEnsureOptions | undefined,
    background = false,
  ) =>
    JSON.stringify({
      background,
      keyOnly: requestOptions?.keyOnly === true,
      refreshRuntime: requestOptions?.refreshRuntime === true,
      confirmReplacement: requestOptions?.confirmReplacement === true,
      reuseWhileRefreshPending: requestOptions?.reuseWhileRefreshPending === true,
      allowFoldedProbe:
        requestOptions?.refreshRuntime !== true && requestOptions?.confirmReplacement !== true,
      nodeScriptPath: runner?.nodeScriptPath ?? null,
      nodeEngineRange: runner?.nodeEngineRange ?? null,
      archiveVersion: runner?.archiveVersion ?? null,
      archiveCommitTime: runner?.archiveCommitTime ?? null,
      archiveSource: runner?.archiveSource ?? null,
      releaseBaseUrl: runner?.releaseBaseUrl ?? null,
      archiveDirectory: runner?.archiveDirectory ?? null,
      bundledArchiveDirectory: runner?.bundledArchiveDirectory ?? null,
      hostDownload: runner?.hostDownload === true,
      publishedFallback: runner?.publishedFallback === true,
      ghCommand: runner?.ghCommand ?? null,
      cleanupTimeoutMs: runner?.cleanupTimeoutMs ?? null,
      keepExistingRunner: runner?.keepExistingRunner === true,
      refreshOwnedRuntimeOnFirstConnection: runner?.refreshOwnedRuntimeOnFirstConnection === true,
      runnerConfirmReplacement: runner?.confirmReplacement === true,
      replacementGraceSeconds: runner?.replacementGraceSeconds ?? null,
    });
  const preparationTerminal = (prepared: PreparedEnsure) => {
    if (
      closed ||
      (generations.get(prepared.key) ?? 0) !== prepared.generation ||
      (!("type" in prepared.result) && tunnels.get(prepared.key) !== prepared.result)
    )
      return { outcome: "superseded" as const };
    const runtimeStatus = statuses.get(prepared.key)?.status;
    return prepared.attachment !== undefined &&
      runtimeStatus !== undefined &&
      (runtimeStatus.state === "ready" || runtimeStatus.state === "providers_not_ready") &&
      !("type" in prepared.result) &&
      prepared.result.attachmentInvalidated !== true &&
      prepared.result.uncertainDrain !== true
      ? { outcome: "ready" as const, attachmentId: prepared.attachment.id, runtimeStatus }
      : { outcome: "pending" as const };
  };
  const rememberAttachment = (
    entry: SshTunnelEntry,
    generation: number,
    operationId: string,
    pin: ManagedPin | undefined,
  ): Attachment => {
    const previous = attachments.get(entry);
    if (
      previous !== undefined &&
      previous.generation === generation &&
      previous.selection === entry.selectedRuntime &&
      samePin(previous.pin, pin)
    )
      return previous;
    const attachment = {
      id: `${operationId}-attachment`,
      operationId,
      generation,
      selection: entry.selectedRuntime,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
      version: entry.selectedRuntime.version,
      pin,
    };
    attachments.set(entry, attachment);
    return attachment;
  };
  const validatePreparedAttachment = Effect.fn("ssh/tunnel.validatePreparedAttachment")(function* (
    key: string,
    entry: SshTunnelEntry,
    attachment: Attachment,
  ) {
    if (
      closed ||
      (generations.get(key) ?? 0) !== attachment.generation ||
      tunnels.get(key) !== entry ||
      attachments.get(entry) !== attachment ||
      attachment.selection !== entry.selectedRuntime ||
      attachment.localPort !== entry.localPort ||
      attachment.remotePort !== entry.remotePort ||
      attachment.version !== entry.selectedRuntime.version ||
      entry.attachmentInvalidated === true ||
      entry.uncertainDrain === true
    )
      return yield* supersededPreparation();
    const pin = yield* readManagedPin(entry.target).pipe(
      Effect.mapError(() => {
        attachments.delete(entry);
        return supersededPreparation();
      }),
    );
    if (!samePin(attachment.pin, pin)) {
      attachments.delete(entry);
      return yield* supersededPreparation();
    }
    if (!(yield* keepAnsweringTunnel(key, entry))) {
      attachments.delete(entry);
      return yield* supersededPreparation();
    }
    if (
      closed ||
      (generations.get(key) ?? 0) !== attachment.generation ||
      tunnels.get(key) !== entry ||
      Boolean(entry.attachmentInvalidated) ||
      Boolean(entry.uncertainDrain) ||
      entry.selectedRuntime !== attachment.selection
    )
      return yield* supersededPreparation();
  });
  const finishEnsureEnvironment = Effect.fn("ssh/tunnel.finishEnsureEnvironment")(function* (
    prepared: PreparedEnsure,
    ticket: RequestTicket,
    requestOptions?: SshEnvironmentEnsureOptions,
  ) {
    return yield* withTargetLock(
      prepared.key,
      Effect.gen(function* () {
        const { key, generation, runner, result: entry } = prepared;
        if (closed || ensureSuperseded(ticket) || (generations.get(key) ?? 0) !== generation)
          return yield* supersededPreparation();
        if ("type" in entry) return entry;
        if (prepared.attachment === undefined) return yield* supersededPreparation();
        yield* validatePreparedAttachment(key, entry, prepared.attachment);
        if (requestOptions?.preparedAttachmentId !== undefined) {
          yield* Effect.sync(() => {
            try {
              requestOptions.onPreparationAdmission?.({
                operationId: prepared.operationId,
                disposition: "attachment-completion",
                generation,
              });
            } catch {
              /* A detached observer does not own the attachment. */
            }
          });
        }
        const pairingResult = requestOptions?.issuePairingToken
          ? yield* runWithSshAuth({
              key,
              keyOnly: requestOptions?.keyOnly === true || managedAliases.has(entry.target.alias),
              target: entry.target,
              operation: (authOptions) =>
                issueRemotePairingToken(entry.target, authOptions, runner, entry.selectedRuntime),
            }).pipe(
              // A desktop reconnecting after this lands on the managed server.
              Effect.tapError((error) =>
                entry.remoteServerKind === "app" && error._tag === "SshPairingError"
                  ? Clock.currentTimeMillis.pipe(
                      Effect.map((now) => {
                        appServerRefusals.set(key, now + APP_SERVER_REFUSAL_MS);
                        entry.attachmentInvalidated = true;
                      }),
                    )
                  : Effect.void,
              ),
            )
          : null;
        const currentPin = yield* readManagedPin(entry.target).pipe(
          Effect.mapError(() => supersededPreparation()),
        );
        if (
          closed ||
          ensureSuperseded(ticket) ||
          (generations.get(key) ?? 0) !== generation ||
          tunnels.get(key) !== entry ||
          entry.selectedRuntime !== prepared.attachment.selection ||
          entry.attachmentInvalidated === true ||
          entry.uncertainDrain === true ||
          !samePin(prepared.attachment.pin, currentPin)
        )
          return yield* supersededPreparation();
        yield* Effect.logInfo("ssh.environment.ensure.succeeded", {
          ...sshTargetLogFields(entry.target),
          key,
          operationId: prepared.operationId,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
          issuedPairingToken: pairingResult !== null,
        });
        const pendingReplacement = pendingReplacements.get(key)?.pending;
        return {
          target: entry.target,
          httpBaseUrl: entry.httpBaseUrl,
          wsBaseUrl: entry.wsBaseUrl,
          pairingToken: pairingResult?.credential ?? null,
          attachmentId: prepared.attachment.id,
          remotePort: entry.remotePort,
          ...(entry.remoteServerKind ? { remoteServerKind: entry.remoteServerKind } : {}),
          ...(entry.selectedRuntime.version
            ? { remoteServerVersion: entry.selectedRuntime.version }
            : {}),
          ...(pendingReplacement === undefined ? {} : { pendingReplacement }),
        };
      }),
    );
  });

  const ensureEnvironmentAttempt = Effect.fn("ssh/tunnel.ensureEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
    requestOptions?: SshEnvironmentEnsureOptions,
  ): Effect.fn.Return<
    DesktopSshEnvironmentReadyOrPending,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext | Scope.Scope
  > {
    const ticket = yield* takeRequestTicket(target, "ensure");
    const requestKey = targetConnectionKey(target);
    const knownKey = targetConnectionKey(resolvedTargets.get(requestKey) ?? target);
    const requestGeneration = generations.get(knownKey) ?? 0;
    const knownEntry = tunnels.get(knownKey);
    const retainedSelection = takeReconnectSelection(knownKey);
    const pendingSelection = takePendingReconnectSelection(knownKey);
    const reconnectSelection =
      knownEntry?.reconnectSelection ?? retainedSelection ?? pendingSelection;
    if (knownEntry !== undefined) delete knownEntry.reconnectSelection;
    if (requestOptions?.refreshRuntime === true || requestOptions?.confirmReplacement === true)
      invalidateReconnectSelection(knownKey);
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    if (
      closed ||
      ensureSuperseded(ticket) ||
      (generations.get(knownKey) ?? 0) !== requestGeneration
    )
      return yield* supersededPreparation();
    yield* startRetry;
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname, target).pipe(
      Effect.tapError((error) =>
        Effect.suspend(() =>
          !closed &&
          !ensureSuperseded(ticket) &&
          (generations.get(knownKey) ?? 0) === requestGeneration
            ? publishFailure(knownKey, target, runner, error)
            : Effect.void,
        ),
      ),
    );
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    if (
      closed ||
      ensureSuperseded(ticket) ||
      (generations.get(knownKey) ?? 0) !== requestGeneration
    )
      return yield* supersededPreparation();
    const key = targetConnectionKey(resolvedTarget);
    if (key !== knownKey) invalidateReconnectSelection(knownKey);
    const admittedGeneration = generations.get(key) ?? 0;
    resolvedTargets.set(requestKey, resolvedTarget);
    if (key !== knownKey && !statuses.has(key)) {
      const initial = statuses.get(knownKey);
      if (initial !== undefined) statuses.set(key, initial);
      statuses.delete(knownKey);
    }
    yield* Effect.logDebug("ssh.environment.target.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      key,
    });
    yield* Effect.logDebug("ssh.environment.runner.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      ...sshRunnerLogFields(runner),
      key,
    });
    if (requestOptions?.preparedAttachmentId !== undefined) {
      const prepared = yield* withTargetLock(
        key,
        Effect.gen(function* () {
          const entry = tunnels.get(key);
          const attachment = entry === undefined ? undefined : attachments.get(entry);
          if (
            entry === undefined ||
            attachment === undefined ||
            attachment.id !== requestOptions.preparedAttachmentId
          )
            return yield* supersededPreparation();
          return {
            key,
            operationId: attachment.operationId,
            generation: admittedGeneration,
            runner,
            result: entry,
            attachment,
          };
        }),
      );
      return yield* finishEnsureEnvironment(prepared, ticket, requestOptions);
    }
    const managedPin = yield* readManagedPin(resolvedTarget);
    const preparationOptions = {
      keyOnly: requestOptions?.keyOnly === true || managedPin !== undefined,
      refreshRuntime: requestOptions?.refreshRuntime === true,
      confirmReplacement: requestOptions?.confirmReplacement === true,
      reuseWhileRefreshPending: requestOptions?.reuseWhileRefreshPending === true,
    };
    const onHostAnswered = yield* SshHostAnswered;
    const context = (yield* Effect.context<SshEnvironmentEffectContext>()).pipe(
      Context.omit(Scope.Scope, SshHostAnswered, SshReconnectCost),
    );
    const lease = yield* flights.join({
      key,
      generation: admittedGeneration,
      intent: preparationIntent(runner, preparationOptions),
      ...(requestOptions?.onPreparationProgress === undefined
        ? {}
        : { onProgress: requestOptions.onPreparationProgress }),
      ...(requestOptions?.onPreparationAdmission === undefined
        ? {}
        : { onAdmission: requestOptions.onPreparationAdmission }),
      ...(requestOptions?.onPhase === undefined
        ? {}
        : {
            onPhase: (phase, upload) =>
              notifyRuntimePhase(resolvedTarget, phase, requestOptions.onPhase, upload),
          }),
      onHostAnswered,
      terminal: preparationTerminal,
      onFailure: (error) =>
        Effect.suspend(() => {
          if (closed || (generations.get(key) ?? 0) !== admittedGeneration) return Effect.void;
          invalidateReconnectSelection(key);
          return publishFailure(key, resolvedTarget, runner, error);
        }).pipe(Effect.provide(context)),
      prepare: (report) =>
        withTargetLock(
          key,
          Effect.gen(function* () {
            if (closed || (generations.get(key) ?? 0) !== admittedGeneration)
              return yield* supersededPreparation();
            forgotten.delete(key);
            const reusingPending =
              preparationOptions.reuseWhileRefreshPending === true &&
              preparationOptions.refreshRuntime !== true &&
              pendingReplacements.has(key) &&
              tunnels.has(key);
            const onPhase: SshRuntimeProgressCallback = ({ phase, upload }) =>
              report.onPhase(phase, upload);
            // A caller reusing a forward that still answers must not flip a ready host to
            // "preparing"; agents call this before every remote tool. A forward that turns out
            // stale publishes its reconnect from createTunnel.
            if (!reusingPending && !tunnels.has(key))
              publishPhase(
                key,
                resolvedTarget,
                runner?.archiveVersion?.trim() ?? "",
                "connecting",
                onPhase,
              );
            if (preparationOptions.refreshRuntime === true) acquisitionFailures.delete(key);
            const decisionKey = `${key}:${runner?.archiveVersion ?? runner?.nodeScriptPath ?? ""}`;
            const connectionRunner =
              runner === undefined
                ? undefined
                : {
                    ...runner,
                    refreshOwnedRuntimeOnFirstConnection:
                      runner.keepExistingRunner !== true &&
                      (preparationOptions.refreshRuntime === true ||
                        (!firstConnectionDecisions.has(decisionKey) &&
                          !pendingReplacements.has(key))) &&
                      runner.refreshOwnedRuntimeOnFirstConnection === true,
                    confirmReplacement: preparationOptions.confirmReplacement === true,
                    ...(preparationOptions.refreshRuntime === true ? { manualRefresh: true } : {}),
                  };
            const entry = yield* ensureTunnelEntry(
              key,
              resolvedTarget,
              connectionRunner,
              false,
              preparationOptions.keyOnly === true,
              preparationOptions.reuseWhileRefreshPending === true &&
                preparationOptions.refreshRuntime !== true,
              onPhase,
              requestOptions?.refreshRuntime !== true &&
                requestOptions?.confirmReplacement !== true,
              reconnectSelection,
            );
            if (closed || (generations.get(key) ?? 0) !== admittedGeneration)
              return yield* supersededPreparation();
            if (
              !("type" in entry) &&
              connectionRunner?.refreshOwnedRuntimeOnFirstConnection === true &&
              !pendingReplacements.has(key)
            )
              firstConnectionDecisions.add(decisionKey);
            yield* publishResult(key, resolvedTarget, entry, runner);
            const pin = yield* readManagedPin(resolvedTarget);
            if (closed || (generations.get(key) ?? 0) !== admittedGeneration)
              return yield* supersededPreparation();
            return {
              key,
              operationId: report.operationId,
              generation: admittedGeneration,
              runner,
              result: entry,
              ...("type" in entry
                ? {}
                : {
                    attachment: rememberAttachment(
                      entry,
                      admittedGeneration,
                      report.operationId,
                      pin,
                    ),
                  }),
            };
          }),
        ).pipe(
          withReconnectCost,
          Effect.provideService(SshHostAnswered, report.onHostAnswered),
          Effect.provideService(SshReconnectCost, null),
          Effect.provide(context),
          Effect.annotateLogs({
            key,
            generation: admittedGeneration,
            operationId: report.operationId,
          }),
        ),
    });
    return yield* finishEnsureEnvironment(lease.value, ticket, requestOptions);
  });

  const ensureEnvironment: SshEnvironmentManagerShape["ensureEnvironment"] = (...args) =>
    withSshCost(Effect.scoped(ensureEnvironmentAttempt(...args)), "ssh.ensure.request.cost");

  const revalidateTunnels = Effect.fn("ssh/tunnel.revalidateTunnels")(function* () {
    yield* Effect.forEach(
      [...tunnels.keys()],
      // The lock waits out an ensure in flight, which may already be replacing the entry.
      (key) =>
        withTargetLock(
          key,
          Effect.suspend(() => {
            const entry = tunnels.get(key);
            return entry === undefined ? Effect.void : keepAnsweringTunnel(key, entry, true);
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
    const baseResolved =
      stored ?? (yield* resolveSshTarget(target.alias || target.hostname, target));
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
    invalidateReconnectSelection(key);
    yield* flights.retire(key, false);
    pendingReplacements.delete(key);
    statuses.delete(key);
    acquisitionFailures.delete(key);
    setupOperations.delete(key);
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
        const stopRemote =
          (cancelledLaunches.get(key) ?? !hadPending) &&
          (entry === null || entry.remoteServerKind !== "app");
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
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname, target);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    return { resolvedTarget, key: targetConnectionKey(resolvedTarget) };
  });

  const status = Effect.fn("ssh/tunnel.status")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<SshHostResult, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const requestKey = targetConnectionKey(target);
    const knownTarget = resolvedTargets.get(requestKey) ?? target;
    const knownKey = targetConnectionKey(knownTarget);
    const active = statuses.get(knownKey);
    if (forgotten.has(knownKey) && active !== undefined) return active;
    if (
      active?.status?.setup?.stage === "complete" &&
      active.status.state === "failed" &&
      [
        "diagnosis_failed",
        "approval_expired",
        "authorization_revoked",
        "operation_failed",
      ].includes(active.status.failure?.reason ?? "")
    )
      return active;
    if (active?.status?.state === "preparing" || active?.status?.state === "update_waiting")
      if (active.status.state === "update_waiting" || flights.isActive(knownKey)) return active;
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    let key = knownKey;
    let observed = active;
    let generation = generations.get(key) ?? 0;
    const initialGeneration = generation;
    // Applied only after the generation/snapshot checks below, so a stale probe cannot clear newer state.
    let clearArchiveDeferral:
      | { readonly failure: SshHostFailure | undefined; readonly intent: unknown }
      | undefined;
    let drainAttachment:
      | { entry: SshTunnelEntry; intent: NonNullable<ReturnType<typeof pendingReplacements.get>> }
      | undefined;
    let verifiedDrainDeferral:
      | { entry: SshTunnelEntry; intent: NonNullable<ReturnType<typeof pendingReplacements.get>> }
      | undefined;
    const result = yield* Effect.gen(function* () {
      const { resolvedTarget } = yield* resolveManagedTarget(target);
      key = targetConnectionKey(resolvedTarget);
      if ((generations.get(knownKey) ?? 0) !== initialGeneration)
        return (
          statuses.get(knownKey) ??
          statuses.get(key) ??
          ({
            kind: "ok",
            status: {
              host: target.alias || target.hostname,
              requestedVersion: "",
              runtimeVersion: null,
              state: "untrusted",
            },
          } satisfies SshHostResult)
        );
      if (forgotten.has(key) && statuses.has(key)) return statuses.get(key)!;
      generation = generations.get(key) ?? 0;
      resolvedTargets.set(requestKey, resolvedTarget);
      observed = statuses.get(key);
      const entry = tunnels.get(key);
      const intent = pendingReplacements.get(key);
      if (entry !== undefined && intent?.pending?.refreshCause === "drain_unavailable")
        drainAttachment = { entry, intent };
      yield* validateManagedPin(resolvedTarget);
      if (observed?.status?.state === "preparing" || observed?.status?.state === "update_waiting")
        if (observed.status.state === "update_waiting" || flights.isActive(key)) return observed;
      const requestedVersion = runner?.archiveVersion?.trim() ?? "";
      // The managed runtime probe below does not see the app server; ask it directly.
      if (entry?.remoteServerKind === "app") {
        const app = yield* appServerStatus(
          resolvedTarget,
          entry.remotePort,
          requestedVersion,
          observed,
        );
        if (app !== undefined) return app;
      }
      const output = yield* runSshCommand(resolvedTarget, {
        batchMode: "yes",
        interactiveAuth: false,
        preHostArgs: ["-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no"],
        remoteCommandArgs: ["sh", "-l", "-s"],
        stdin: buildRemoteRuntimeProbeScript(requestedVersion, REMOTE_RUNTIME_STATE_KEY),
        timeoutMs: SSH_READY_TIMEOUT_MS,
      });
      const probe = yield* decodeRemoteJsonOutput(output.stdout, decodeRemoteRuntimeProbe).pipe(
        Effect.mapError(runtimePreparationError),
      );
      const host = target.alias || target.hostname;
      const base = { host, requestedVersion };
      let snapshot: SshHostStatus;
      let compatibleLive = false;
      if (probe.liveStatus === "live") {
        if (
          probe.liveVersion === undefined ||
          probe.liveSignals === undefined ||
          probe.liveSignals.serverVersion !== probe.liveVersion
        ) {
          return {
            kind: "error",
            code: "operation_failed",
            message: `${host}: The running GOAT runtime could not be verified.`,
            fix: { actor: "agent", instruction: "Try again" },
          } satisfies SshHostResult;
        }
        const order = compareRuntimeBuilds(
          { version: probe.liveVersion, commitTime: probe.liveCommitTime },
          { version: requestedVersion, commitTime: runner?.archiveCommitTime },
        );
        const compatible = matchesSignals(probe.liveSignals, requestedVersion);
        const runsRequested = probe.liveVersion === requestedVersion;
        const blocked = liveRuntimeBlocksUpdate(probe, order, compatible, runsRequested);
        compatibleLive =
          compatible &&
          probe.identityAbsent !== true &&
          probe.liveBinarySignals !== undefined &&
          probe.liveBinarySignals.serverVersion === probe.liveVersion &&
          matchesSignals(probe.liveBinarySignals, requestedVersion);
        if (!compatible && !blocked) {
          return {
            kind: "error",
            code: "operation_failed",
            message: `${host}: The running GOAT runtime has incompatible protocols.`,
            fix: { actor: "agent", instruction: "Try again" },
          } satisfies SshHostResult;
        }
        const providers = observed?.status?.providers;
        snapshot = {
          ...base,
          runtimeVersion: probe.liveVersion,
          state: blocked
            ? "update_blocked"
            : providers?.ready === false
              ? "providers_not_ready"
              : "ready",
          ...(providers === undefined ? {} : { providers }),
          ...(blocked
            ? {
                detail:
                  order !== undefined && order > 0
                    ? `${host} runs a newer GOAT (${probe.liveVersion}). Update this app from the update button next to Settings.`
                    : `A GOAT server that this app didn't start or cannot replace is running on ${host}. Stop it on the host, then reconnect.`,
              }
            : {}),
        };
      } else if (probe.liveStatus === "unknown") {
        return {
          kind: "error",
          code: "operation_failed",
          message: `${host}: The running GOAT runtime could not be verified.`,
          fix: { actor: "agent", instruction: "Try again" },
        } satisfies SshHostResult;
      } else {
        snapshot = {
          ...base,
          state: "stopped",
          runtimeVersion:
            probe.retained === "ready"
              ? (probe.retainedVersion ?? null)
              : probe.ready
                ? requestedVersion
                : null,
        };
      }
      // A successful probe observes liveness; it does not retry a failed acquisition.
      const pending = intent?.pending;
      if (
        compatibleLive &&
        probe.liveStatus === "live" &&
        probe.liveOwned === true &&
        entry !== undefined &&
        entry.uncertainDrain !== true &&
        intent !== undefined &&
        intent.generation === generation &&
        intent.requestedRunner.archiveVersion?.trim() === requestedVersion &&
        pending?.refreshCause === "drain_unavailable" &&
        (pending.replacement === "older" || pending.replacement === "capability") &&
        pending.requestedVersion === requestedVersion &&
        pending.liveVersion === probe.liveVersion &&
        entry.selectedRuntime.version === probe.liveVersion &&
        entry.selectedRuntime.requestedVersion === requestedVersion &&
        entry.remotePort === probe.livePort &&
        !setupTerminalFailure(key) &&
        (yield* entry.process.isRunning.pipe(Effect.orElseSucceed(() => false))) &&
        (yield* waitForHttpReady(existingTunnelCheck(entry, EXISTING_TUNNEL_CHECK_TIMEOUT_MS)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ))
      ) {
        const pin = yield* validateManagedPin(resolvedTarget);
        if (
          !closed &&
          (generations.get(key) ?? 0) === generation &&
          tunnels.get(key) === entry &&
          pendingReplacements.get(key) === intent &&
          !setupTerminalFailure(key) &&
          samePin(intent.managedPin, pin)
        )
          verifiedDrainDeferral = { entry, intent };
      }
      const previousFailure = acquisitionFailures.get(key);
      if (verifiedDrainDeferral !== undefined) {
        const refreshDeferred = deferredDrainRefresh(requestedVersion);
        snapshot = {
          ...base,
          runtimeVersion: probe.liveVersion!,
          state: snapshot.providers?.ready === false ? "providers_not_ready" : "ready",
          ...(snapshot.providers === undefined ? {} : { providers: snapshot.providers }),
          refreshDeferred,
          detail: refreshDeferred.detail,
        };
      } else if (pending?.refreshCause === "drain_unavailable") {
        snapshot = {
          ...base,
          runtimeVersion: snapshot.runtimeVersion,
          state: "update_blocked",
          detail:
            snapshot.detail ??
            `${host}: The deferred runtime attachment could not be verified. Try reconnecting.`,
        };
      } else if (compatibleLive && snapshot.runtimeVersion === requestedVersion) {
        clearArchiveDeferral = { failure: previousFailure, intent: pendingReplacements.get(key) };
      } else if (
        compatibleLive &&
        previousFailure?.reason === "archive_unavailable" &&
        previousFailure.archive?.requestedVersion === requestedVersion
      ) {
        const refreshDeferred = deferredArchiveRefresh(requestedVersion);
        snapshot = {
          ...base,
          runtimeVersion: snapshot.runtimeVersion,
          detail: refreshDeferred.detail,
          state: snapshot.providers?.ready === false ? "providers_not_ready" : "ready",
          ...(snapshot.providers === undefined ? {} : { providers: snapshot.providers }),
          refreshDeferred,
        };
      } else if (
        previousFailure?.reason === "archive_unavailable" ||
        previousFailure?.reason === "unsupported_platform"
      ) {
        snapshot = {
          ...base,
          state: "failed",
          runtimeVersion: snapshot.runtimeVersion,
          failure: previousFailure,
        };
      }
      return { kind: "ok", status: { ...snapshot, ...setupFields(key) } } satisfies SshHostResult;
    }).pipe(
      Effect.catch((error) => {
        const failure = runtimeFailureResult(
          target.alias || target.hostname,
          runner?.archiveVersion?.trim() ?? "",
          observed?.status?.runtimeVersion ?? null,
          error,
        );
        const previousFailure = acquisitionFailures.get(key);
        if (
          failure.kind === "error" &&
          (previousFailure?.reason === "archive_unavailable" ||
            previousFailure?.reason === "unsupported_platform")
        ) {
          return Effect.succeed<SshHostResult>({
            ...failure,
            status: {
              host: target.alias || target.hostname,
              requestedVersion: runner?.archiveVersion?.trim() ?? "",
              runtimeVersion: observed?.status?.runtimeVersion ?? null,
              state: "failed" as const,
              failure: previousFailure,
            },
          });
        }
        return Effect.succeed<SshHostResult>(failure);
      }),
    );
    // A read started before a launch/disconnect must not overwrite its newer snapshot.
    if (closed || (generations.get(key) ?? 0) !== generation) return statuses.get(key) ?? result;
    const latest = statuses.get(key);
    if (latest !== observed && latest !== undefined) return latest;
    let enriched = yield* enrichFailure(target, result);
    if (closed || (generations.get(key) ?? 0) !== generation) return statuses.get(key) ?? enriched;
    if (statuses.get(key) !== observed && statuses.has(key)) return statuses.get(key)!;
    if (verifiedDrainDeferral !== undefined) {
      if (
        tunnels.get(key) !== verifiedDrainDeferral.entry ||
        pendingReplacements.get(key) !== verifiedDrainDeferral.intent ||
        setupTerminalFailure(key)
      )
        return statuses.get(key) ?? enriched;
      acquisitionFailures.delete(key);
    }
    if (clearArchiveDeferral !== undefined) {
      if (acquisitionFailures.get(key) === clearArchiveDeferral.failure)
        acquisitionFailures.delete(key);
      const intent = pendingReplacements.get(key);
      if (
        intent !== undefined &&
        intent === clearArchiveDeferral.intent &&
        intent.archiveFailure !== undefined
      )
        pendingReplacements.delete(key);
    }
    if (
      tunnels.get(key)?.uncertainDrain === true &&
      enriched.kind === "ok" &&
      (enriched.status.state === "ready" || enriched.status.state === "providers_not_ready")
    ) {
      // Liveness cannot prove that an attempted drain was cancelled.
      verifiedDrainDeferral = undefined;
      const blockedStatus = {
        ...enriched.status,
        state: "update_blocked" as const,
        detail: "The previous runtime drain could not be verified. Try reconnecting.",
      };
      delete blockedStatus.refreshDeferred;
      enriched = { ...enriched, status: blockedStatus };
    }
    if (
      drainAttachment !== undefined &&
      tunnels.get(key) === drainAttachment.entry &&
      pendingReplacements.get(key) === drainAttachment.intent
    ) {
      // Historical launch proof cannot readmit an attachment rejected by a fresh probe.
      drainAttachment.entry.attachmentInvalidated = verifiedDrainDeferral === undefined;
      if (drainAttachment.entry.attachmentInvalidated) attachments.delete(drainAttachment.entry);
    }
    const selected = tunnels.get(key)?.reconnectSelection ?? reconnectSelections.get(key);
    if (
      tunnels.get(key)?.attachmentInvalidated === true ||
      tunnels.get(key)?.uncertainDrain === true ||
      enriched.kind !== "ok" ||
      (enriched.status?.state !== "ready" && enriched.status?.state !== "providers_not_ready") ||
      enriched.status.runtimeVersion !== selected?.runtime.version
    )
      invalidateReconnectSelection(key);
    statuses.set(key, enriched);
    return enriched;
  });

  const requireReadyEntry = Effect.fn("ssh/tunnel.requireReadyEntry")(function* (
    target: DesktopSshEnvironmentTarget,
    key: string,
  ) {
    const entry = tunnels.get(key);
    const snapshot = statuses.get(key)?.status;
    if (
      closed ||
      entry === undefined ||
      entry.attachmentInvalidated === true ||
      entry.uncertainDrain === true ||
      (snapshot?.state !== "ready" && snapshot?.state !== "providers_not_ready") ||
      !(yield* entry.process.isRunning.pipe(Effect.orElseSucceed(() => false)))
    )
      return yield* notReady(target);
    yield* validateManagedPin(entry.target);
    return entry;
  });
  const readyEnvironment: SshEnvironmentManagerShape["readyEnvironment"] = Effect.fn(
    "ssh/tunnel.readyEnvironment",
  )(function* (target) {
    const known = resolvedTargets.get(targetConnectionKey(target)) ?? target;
    const key = targetConnectionKey(known);
    return yield* withIdleTargetLock(
      key,
      target,
      Effect.gen(function* () {
        const entry = yield* requireReadyEntry(target, key);
        return {
          target: entry.target,
          httpBaseUrl: entry.httpBaseUrl,
          wsBaseUrl: entry.wsBaseUrl,
          pairingToken: null,
          remotePort: entry.remotePort,
          ...(entry.remoteServerKind === null ? {} : { remoteServerKind: entry.remoteServerKind }),
          ...(entry.selectedRuntime.version === null
            ? {}
            : { remoteServerVersion: entry.selectedRuntime.version }),
        };
      }),
    );
  });

  /**
   * Issues a credential against the target's current attachment. When that is the GOAT app server
   * and it refuses, the target moves to the managed server on the same local port, so the caller's
   * forward stays valid, and the credential is issued once more there. Hub work never depends on
   * an app server that can be reached but cannot sign anyone in.
   */
  const withAppServerFallback = <A, E, R>(
    key: string,
    resolvedTarget: DesktopSshEnvironmentTarget,
    runner: RemoteGoatRunnerOptions | undefined,
    options: {
      /** Ready-only callers never change which server serves the host. */
      readonly reconnect: boolean;
      readonly keyOnly: boolean;
    },
    issue: (selection: PreparedRemoteRuntime | undefined) => Effect.Effect<A, E, R>,
  ) => {
    const entry = tunnels.get(key);
    if (entry?.remoteServerKind !== "app") return issue(entry?.selectedRuntime);
    const generation = generations.get(key) ?? 0;
    const current = () =>
      !closed && !forgotten.has(key) && (generations.get(key) ?? 0) === generation;
    return issue(entry.selectedRuntime).pipe(
      Effect.catchIf(
        (error): error is E & SshPairingError => error instanceof SshPairingError,
        (error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("ssh.appServer.credential.fallback", {
              ...sshTargetLogFields(resolvedTarget),
              cause: error.message,
              reconnect: options.reconnect,
            });
            appServerRefusals.set(key, (yield* Clock.currentTimeMillis) + APP_SERVER_REFUSAL_MS);
            entry.attachmentInvalidated = true;
            // A disconnect or forget that arrived meanwhile wins; nothing is started for it.
            if (!options.reconnect || !current() || tunnels.get(key) !== entry) return yield* error;
            yield* Effect.gen(function* () {
              tunnels.delete(key);
              yield* closeTunnelEntry(entry);
            }).pipe(Effect.uninterruptible);
            const next = yield* createTunnelEntry({
              key,
              resolvedTarget,
              keyOnly: options.keyOnly,
              ...(runner === undefined ? {} : { runner }),
              previousLocalPort: entry.localPort,
              expectedGeneration: generation,
            });
            if (!current()) return yield* error;
            yield* publishResult(key, resolvedTarget, next, runner);
            if ("type" in next) return yield* error;
            return yield* issue(next.selectedRuntime);
          }),
      ),
    );
  };

  const issueMcpClientSession = Effect.fn("ssh/tunnel.issueMcpClientSession")(function* (
    target: DesktopSshEnvironmentTarget,
    sessionOptions: RemoteMcpClientSessionOptions,
  ): Effect.fn.Return<
    RemoteMcpClientSession,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const known = resolvedTargets.get(targetConnectionKey(target)) ?? target;
    const { resolvedTarget, key } =
      sessionOptions.requireReady === true
        ? { resolvedTarget: known, key: targetConnectionKey(known) }
        : yield* resolveManagedTarget(target);
    if (sessionOptions.requireReady !== true) yield* validateManagedPin(resolvedTarget);
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    if (pendingReplacements.has(key) && !tunnels.has(key)) {
      return yield* new SshLaunchError({
        message: "Remote runtime will be replaced when its work finishes.",
        stdout: "",
      });
    }
    // Session preparation waits for a launch in flight and reuses its selection.
    const issue = Effect.gen(function* () {
      if (sessionOptions.requireReady === true) yield* requireReadyEntry(target, key);
      return yield* withAppServerFallback(
        key,
        resolvedTarget,
        runner,
        {
          reconnect: sessionOptions.requireReady !== true,
          keyOnly: managedAliases.has(resolvedTarget.alias) || sessionOptions.requireReady === true,
        },
        (selection) =>
          runWithSshAuth({
            key,
            keyOnly:
              managedAliases.has(resolvedTarget.alias) || sessionOptions.requireReady === true,
            target: resolvedTarget,
            operation: (authOptions) =>
              issueRemoteMcpClientSession(
                resolvedTarget,
                sessionOptions,
                authOptions,
                runner,
                selection,
              ),
          }),
      );
    });
    return yield* (
      sessionOptions.requireReady === true
        ? withIdleTargetLock(key, target, issue)
        : withTargetLock(key, issue)
    ).pipe(
      Effect.mapError((error) => {
        const pending = pendingReplacements.get(key)?.pending;
        if (
          pending === undefined ||
          error._tag !== "SshPairingError" ||
          error.reason !== "memory-scopes-unsupported"
        )
          return error;
        // The refresh already waits for this runtime to go idle; say so instead of asking for a stop.
        return (
          memoryScopesUnsupportedError(
            error.stdout,
            resolvedTarget.alias,
            `It will be replaced with GOAT ${pending.requestedVersion} when its current work finishes.`,
          ) ?? error
        );
      }),
    );
  });

  const issueClientSession: SshEnvironmentManagerShape["issueClientSession"] = Effect.fn(
    "ssh/tunnel.issueClientSession",
  )(function* (target, sessionOptions) {
    const { resolvedTarget, key } = yield* resolveManagedTarget(target);
    yield* validateManagedPin(resolvedTarget);
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    if (pendingReplacements.has(key) && !tunnels.has(key)) {
      return yield* new SshLaunchError({
        message: "Remote runtime will be replaced when its work finishes.",
        stdout: "",
      });
    }
    return yield* withTargetLock(
      key,
      Effect.suspend(() =>
        withAppServerFallback(
          key,
          resolvedTarget,
          runner,
          { reconnect: true, keyOnly: managedAliases.has(resolvedTarget.alias) },
          (selection) =>
            runWithSshAuth({
              key,
              keyOnly: managedAliases.has(resolvedTarget.alias),
              target: resolvedTarget,
              operation: (authOptions) =>
                issueRemoteClientSession(
                  resolvedTarget,
                  sessionOptions,
                  authOptions,
                  runner,
                  selection,
                ),
            }),
        ),
      ),
    );
  });

  const attachedServerKind = Effect.fn("ssh/tunnel.attachedServerKind")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    const key = targetConnectionKey(resolvedTargets.get(targetConnectionKey(target)) ?? target);
    const kind = tunnels.get(key)?.remoteServerKind ?? null;
    if (kind !== null) return kind;
    // A refused app server is skipped until the refusal ends, so the managed one serves meanwhile.
    return (appServerRefusals.get(key) ?? 0) > (yield* Clock.currentTimeMillis) ? "managed" : null;
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
    yield* validateManagedPin(resolvedTarget);
    return yield* runWithSshAuth({
      key,
      keyOnly: managedAliases.has(resolvedTarget.alias),
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

  const beginSetupOperation: SshEnvironmentManagerShape["beginSetupOperation"] = Effect.fn(
    "ssh/tunnel.beginSetupOperation",
  )(function* (target, operationId) {
    const ticket = yield* takeRequestTicket(target, "ensure");
    const { resolvedTarget, key } = yield* resolveManagedTarget(target);
    if (latestRequest.get(ticket.key) !== ticket.sequence)
      return yield* new SshLaunchError({ message: "SSH setup was cancelled.", stdout: "" });
    resolvedTargets.set(targetConnectionKey(target), resolvedTarget);
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    invalidateReconnectSelection(key);
    yield* flights.retire(key, false);
    pendingReplacements.delete(key);
    forgotten.delete(key);
    const setup: SshHostSetupProgress = { operationId, generation, stage: "runtime" };
    setupOperations.set(key, setup);
    const previous = statuses.get(key)?.status;
    statuses.set(key, {
      kind: "ok",
      status: {
        host: target.alias || target.hostname,
        requestedVersion: previous?.requestedVersion ?? "",
        runtimeVersion: previous?.runtimeVersion ?? null,
        state: "stopped",
        setup,
      },
    });
    return setup;
  });
  const publishSetupOutcome: SshEnvironmentManagerShape["publishSetupOutcome"] = (
    target,
    operation,
    outcome,
  ) =>
    Effect.sync(() => {
      const known = resolvedTargets.get(targetConnectionKey(target)) ?? target;
      const key = targetConnectionKey(known);
      const setup = setupOperations.get(key);
      const previous = statuses.get(key);
      const snapshot =
        previous?.status ??
        (previous?.kind === "error"
          ? {
              host: target.alias || target.hostname,
              requestedVersion: "",
              runtimeVersion: null,
              state: "failed" as const,
              failure: {
                reason: "operation_failed" as const,
                fix: previous.fix ?? { actor: "agent" as const, instruction: "Try again" },
              },
              detail: previous.message,
            }
          : undefined);
      if (
        closed ||
        setup?.operationId !== operation.operationId ||
        setup.generation !== operation.generation ||
        (generations.get(key) ?? 0) !== operation.generation ||
        snapshot === undefined
      )
        return false;
      // Failed runtime acquisition and replacement waits keep their own recovery.
      // Expired/revoked key-auth approvals instead become one terminal setup failure.
      const keepRecovery = [
        "failed",
        "update_waiting",
        "update_blocked",
        "providers_not_ready",
      ].includes(snapshot.state);
      if (outcome.kind === "complete" || (keepRecovery && snapshot.refreshDeferred === undefined)) {
        if (outcome.kind === "complete" && snapshot.state === "preparing") return false;
        setupOperations.set(key, { ...setup, diagnosisRequired: false });
        statuses.set(key, { kind: "ok", status: { ...snapshot, ...setupFields(key, "complete") } });
      } else {
        pendingReplacements.delete(key);
        generations.set(key, operation.generation + 1);
        invalidateReconnectSelection(key);
        const attachmentEntry = tunnels.get(key);
        if (attachmentEntry !== undefined) attachments.delete(attachmentEntry);
        const {
          phase: _phase,
          waitingReason: _waiting,
          publicKey: _publicKey,
          keyAuth: _keyAuth,
          failure: _failure,
          refreshDeferred: _refreshDeferred,
          ...base
        } = snapshot;
        statuses.set(key, {
          kind: "ok",
          status: {
            ...base,
            state: "failed",
            detail: outcome.message,
            failure: { reason: outcome.reason, fix: outcome.fix },
            ...setupFields(key, "complete"),
          },
        });
      }
      return true;
    });
  const publishProviderDiagnosis: SshEnvironmentManagerShape["publishProviderDiagnosis"] = (
    target,
    operation,
    providers,
  ) =>
    Effect.sync(() => {
      // A stale publisher must not resolve or contact a host forgotten in the meantime.
      const known = resolvedTargets.get(targetConnectionKey(target)) ?? target;
      const key = targetConnectionKey(known);
      const setup = setupOperations.get(key);
      const previous = statuses.get(key)?.status;
      if (
        closed ||
        setup?.operationId !== operation.operationId ||
        setup.generation !== operation.generation ||
        (generations.get(key) ?? 0) !== operation.generation ||
        previous === undefined ||
        (previous.state !== "ready" && previous.state !== "providers_not_ready")
      )
        return false;
      statuses.set(key, {
        kind: "ok",
        status: {
          ...previous,
          state: providers.ready ? "ready" : "providers_not_ready",
          providers,
          ...setupFields(key, "complete"),
        },
      });
      return true;
    });
  const forgetEnvironment: SshEnvironmentManagerShape["forgetEnvironment"] = Effect.fn(
    "ssh/tunnel.forgetEnvironment",
  )(function* (target, forgetOptions) {
    const ticket = yield* takeRequestTicket(target, "disconnect");
    const requestKey = targetConnectionKey(target);
    const resolvedTarget =
      resolvedTargets.get(requestKey) ?? (yield* resolveManagedTarget(target)).resolvedTarget;
    const key = targetConnectionKey(resolvedTarget);
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    invalidateReconnectSelection(key);
    yield* flights.retire(key, false);
    pendingReplacements.delete(key);
    acquisitionFailures.delete(key);
    setupOperations.delete(key);
    forgotten.add(key);
    observedPins.delete(target.alias);
    let result: SshHostResult = {
      kind: "ok",
      status: {
        host: target.alias || target.hostname,
        requestedVersion: statuses.get(key)?.status?.requestedVersion ?? "",
        runtimeVersion: statuses.get(key)?.status?.runtimeVersion ?? null,
        state: "untrusted",
      },
    };
    // Publish the fence before waiting on a long upload's lock.
    statuses.set(key, result);
    yield* withTargetLock(
      key,
      Effect.gen(function* () {
        if (disconnectSuperseded(ticket)) return;
        if (forgetOptions.stopRuntime === "if_idle") {
          const stopped = yield* Effect.result(
            stopRemoteServer(resolvedTarget, {
              batchMode: "yes",
              interactiveAuth: false,
              ownedOnly: true,
            }),
          );
          if (stopped._tag === "Failure")
            result = {
              ...result,
              status: { ...result.status!, detail: "Runtime stop was not confirmed." },
            };
        }
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const entry = tunnels.get(key);
            if (entry !== undefined) {
              tunnels.delete(key);
              yield* closeTunnelEntry(entry);
            }
            cancelledLaunches.delete(key);
            authSecrets.delete(key);
            for (const decision of firstConnectionDecisions)
              if (decision.startsWith(`${key}:`)) firstConnectionDecisions.delete(decision);
            if ((generations.get(key) ?? 0) === generation) statuses.set(key, result);
          }),
        ),
        Effect.uninterruptible,
      ),
    );
    return result;
  });

  const withSharing =
    <Args extends unknown[], A, E, R>(operation: (...args: Args) => Effect.Effect<A, E, R>) =>
    (...args: Args) =>
      operation(...args).pipe(Effect.provideService(SshConnectionSharing, sharing));
  return SshEnvironmentManager.of({
    status: withSharing(status),
    readyEnvironment: withSharing(readyEnvironment),
    beginSetupOperation: withSharing(beginSetupOperation),
    publishProviderDiagnosis: withSharing(publishProviderDiagnosis),
    publishSetupOutcome: withSharing(publishSetupOutcome),
    forgetEnvironment: withSharing(forgetEnvironment),
    ensureEnvironment: withSharing(ensureEnvironment),
    disconnectEnvironment: withSharing(disconnectEnvironment),
    revalidateTunnels: withSharing(revalidateTunnels),
    issueMcpClientSession: withSharing(issueMcpClientSession),
    issueClientSession: withSharing(issueClientSession),
    attachedServerKind,
    runRemoteScript: withSharing(runRemoteScript),
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
