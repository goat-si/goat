import { SshForceReplaceTarget } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type RemoteGoatRunnerOptions, shellSingleQuote } from "./remoteRuntime.ts";

const decodeTarget = Schema.decodeUnknownOption(SshForceReplaceTarget);

/** The status field naming the recorded runtime process; absent when the host reported none. */
export const replaceTargetOf = (probe: { readonly replaceTarget?: unknown }) => {
  const target = Option.getOrUndefined(decodeTarget(probe.replaceTarget));
  return target === undefined ? {} : { replaceTarget: target };
};

/** Fills the approved process a confirmed replacement may stop; empty without confirmation. */
export const withForcedReplacement = (
  script: string,
  input: RemoteGoatRunnerOptions | undefined,
) => {
  const target = input?.confirmReplacement === true ? input.forceReplace : undefined;
  return script
    .replace("@@GOAT_FORCE_PID@@", target === undefined ? "''" : String(target.pid))
    .replace("@@GOAT_FORCE_PORT@@", target === undefined ? "''" : String(target.port))
    .replace("@@GOAT_FORCE_START@@", shellSingleQuote(target?.startedAt ?? ""));
};

// Runs in the owning launch under the replacement lock, after classification selected the approved
// process (forced_target_recorded). Expects the launch's process, listener and log helpers.
export const REMOTE_FORCED_STOP_SCRIPT = `if [ "$FORCE_STOP" = 1 ]; then
  # A person approved stopping exactly this process. Every check runs again under the lock, and
  # a process that fails one is left running. Nothing is matched by name.
  forced_refused() {
    printf 'GOAT did not stop PID %s on the remote host because %s; it was left running. Ask again so the approval names the runtime running now.\\n' "$FORCE_PID" "$1" >&2; exit 1
  }
  forced_start_of() { server_start "$1" | awk '{ $1 = $1; print }'; }
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then forced_refused "GOAT cannot signal processes on a Windows host"; fi
  [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] || forced_refused "this client no longer holds the replacement lock"
  fact_file_is "$PID_FILE" "$FORCE_PID" && fact_file_is "$PORT_FILE" "$FORCE_PORT" || forced_refused "its launch records changed"
  server_alive "$FORCE_PID" || forced_refused "it is no longer running"
  [ "$(server_uid "$FORCE_PID" | tr -d ' ')" = "$(id -u)" ] || forced_refused "another user owns it"
  forced_start="$(forced_start_of "$FORCE_PID")"
  [ -n "$forced_start" ] && [ "$forced_start" = "$FORCE_START" ] || forced_refused "its start time differs from the approved one"
  server_owns_listener "$FORCE_PID" "$FORCE_PORT" || forced_refused "it does not listen on port $FORCE_PORT"
  # Descendants are recorded with their start times now; afterwards only those still matching
  # are signalled, so a reused PID never is.
  forced_children="$(ps -A -o pid= -o ppid= 2>/dev/null | awk -v root="$FORCE_PID" '
    { parent[$1] = $2 }
    END { for (pid in parent) { up = parent[pid]; for (depth = 0; depth < 32 && up != ""; depth++) { if (up == root) { print pid; break } up = parent[up] } } }')" || forced_children=
  forced_records=
  for forced_child in $forced_children; do
    valid_positive "$forced_child" || continue
    forced_child_start="$(forced_start_of "$forced_child")"
    if [ -n "$forced_child_start" ]; then forced_records="$forced_records$forced_child $forced_child_start
"; fi
  done
  printf 'Stopping GOAT PID %s (started %s, port %s) for an approved forced update.\\n' "$FORCE_PID" "$FORCE_START" "$FORCE_PORT" >>"$LOG_FILE" 2>/dev/null || :
  kill -TERM "$FORCE_PID" 2>/dev/null || :
  forced_waited=0
  while server_alive "$FORCE_PID" && [ "$forced_waited" -lt "$DRAIN_GRACE_SECONDS" ]; do
    sleep 1; forced_waited=$((forced_waited + 1))
  done
  if server_alive "$FORCE_PID"; then
    if [ "$(forced_start_of "$FORCE_PID")" = "$FORCE_START" ]; then kill -KILL "$FORCE_PID" 2>/dev/null || :; fi
    forced_waited=0
    while server_alive "$FORCE_PID" && [ "$forced_waited" -lt 10 ]; do sleep 1; forced_waited=$((forced_waited + 1)); done
    if server_alive "$FORCE_PID" && [ "$(forced_start_of "$FORCE_PID")" = "$FORCE_START" ]; then
      printf 'GOAT PID %s on the remote host did not exit after SIGKILL; the update stopped. See %s.\\n' "$FORCE_PID" "$LOG_FILE" >&2; exit 1
    fi
  fi
  forced_signal_children() {
    printf '%s' "$forced_records" | while read -r forced_child forced_child_start; do
      [ -n "$forced_child" ] && server_alive "$forced_child" || continue
      [ "$(forced_start_of "$forced_child")" = "$forced_child_start" ] || continue
      [ "$(server_uid "$forced_child" | tr -d ' ')" = "$(id -u)" ] || continue
      kill "-$1" "$forced_child" 2>/dev/null || :
      printf '%s\\n' "$forced_child"
    done || :
  }
  forced_signalled="$(forced_signal_children TERM)" || forced_signalled=
  forced_waited=0
  while [ -n "$forced_signalled" ] && [ "$forced_waited" -lt 5 ]; do
    forced_left=
    for forced_child in $forced_signalled; do if server_alive "$forced_child"; then forced_left="$forced_left $forced_child"; fi; done
    [ -n "$forced_left" ] || break
    sleep 1; forced_waited=$((forced_waited + 1))
  done
  [ -z "$forced_signalled" ] || forced_signal_children KILL >/dev/null || :
  if [ -f "$DEFAULT_RUNTIME_FILE" ] && sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9]*\\).*/\\1/p' "$DEFAULT_RUNTIME_FILE" 2>/dev/null | grep -qx "$FORCE_PID"; then
    rm -f "$DEFAULT_RUNTIME_FILE"
  fi
  rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity" "$STATE_DIR/draining"
  FORCE_STOP=0; LIVE_STATUS=none; LIVE_PID=0; LIVE_PORT=0
fi
`;
