import { applyScriptPlaceholders } from "./remoteRuntime.ts";
import { REMOTE_PROTOCOL_TOKEN_SCRIPT } from "./runtimeFactsScripts.ts";
import {
  REMOTE_OWNED_IDENTITY_SCRIPT,
  REMOTE_REPLACEMENT_LOCK_SCRIPT,
} from "./runtimeOwnershipScripts.ts";

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
acquire_replacement_lock || { printf 'Another client is replacing the remote runtime.\\n' >&2; exit 1; }; [ -e "$STATE_DIR/run-t3.sh" ] || rm -f "$STATE_DIR/run-goat.sh" || :
fact_slurp "$MANAGED_FILE" || FACT_TEXT=; REMOTE_MANAGED="$FACT_TEXT"
fact_slurp "$PID_FILE" || FACT_TEXT=; REMOTE_PID="$FACT_TEXT"
fact_slurp "$PORT_FILE" || FACT_TEXT=; REMOTE_PORT="$FACT_TEXT"
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
