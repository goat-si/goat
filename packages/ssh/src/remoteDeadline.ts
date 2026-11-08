/**
 * Without a terminal, sshd never hangs up a script whose client timed out, so it and its goat
 * helpers kept running. A watchdog in the same shell hangs it up after the client's deadline;
 * nohup and detached-PowerShell servers are outside its reach and keep running.
 */
const GRACE_SECONDS = 5;
const CHECK_SECONDS = 2;
// sshd starts the shell for a request the client sent before it gave up; this covers that delay.
const START_SLACK_SECONDS = 5;

/** `sh [-l] -s [-- args]`: the script arrives on stdin. Uploads (`sh -c`) stream data instead. */
export function isRemoteShellScript(args: ReadonlyArray<string> | undefined) {
  if (args === undefined || args[0] !== "sh") return false;
  const options = args.slice(1, args.includes("--") ? args.indexOf("--") : undefined);
  return options.includes("-s") && options.every((option) => option === "-s" || option === "-l");
}

/**
 * How long after the client's timeout a script it gave up on can still run: it may have started
 * as late as that timeout, and its watchdog allows the whole timeout again. A retry that waits this
 * long rarely meets that script's replacement lock; the lock's own contention and dead-owner
 * recovery stay what makes overlap safe.
 */
export function remoteDeadlineSettleMs(timeoutMs: number) {
  return (Math.ceil(timeoutMs / 1000) + GRACE_SECONDS + CHECK_SECONDS + START_SLACK_SECONDS) * 1000;
}

/**
 * A watchdog in the script's job hangs up only its own process group and signals no listed PID.
 * No deadline cleanup happens without group isolation or when a probe cannot read the job's IDs;
 * a native Git Bash child that ignores the hang-up keeps its script running until it ends. The
 * outer shell, which the script's locks record as owner, outlives the script's own cleanup.
 */
export function withRemoteDeadline(
  script: string,
  timeoutMs: number,
  // `command -p` bypasses PATH, so a script's own sleep shim cannot speed up the deadline.
  sleep = "command -p sleep",
  // Tests point this at a missing file to take /proc away.
  selfStat = "/proc/self/stat",
) {
  const seconds = Math.ceil(timeoutMs / 1000) + GRACE_SECONDS;
  return `trap 'goat_deadline_hup=1' HUP
goat_deadline_hup=
# bash gives the job its own process group; dash without a terminal cannot, and keeps this shell's.
# With a controlling terminal job control would wait to own it, so it stays off there.
if ! { true </dev/tty; } 2>/dev/null; then set -m 2>/dev/null || :; fi
(
  trap 'goat_deadline_hup=1' HUP
  set +m 2>/dev/null || :
  # Sets goat_deadline_ppid and goat_deadline_pgid for the calling process, or fails.
  goat_deadline_ids() {
    goat_deadline_ppid=; goat_deadline_pgid=
    if [ -r '${selfStat}' ] && IFS= read -r goat_deadline_stat <'${selfStat}'; then
      set -f; set -- \${goat_deadline_stat##*) }; set +f
    else
      [ -n "\${goat_deadline_me:-}" ] || goat_deadline_me="$(exec sh -c 'echo "$PPID"' 2>/dev/null)"
      set -f; set -- - $(ps -o ppid=,pgid= -p "$goat_deadline_me" 2>/dev/null); set +f
    fi
    case "\${2:-}:\${3:-}" in *[!0123456789:]*|:*|*:) return 1 ;; esac
    goat_deadline_ppid="$2"; goat_deadline_pgid="$3"
  }
  # A child's probe names this shell and its process group. When it cannot, no watchdog starts and
  # the script runs without deadline cleanup.
  goat_deadline_watchdog=
  if goat_deadline_probe="$(goat_deadline_ids && echo "$goat_deadline_ppid $goat_deadline_pgid")"; then
    goat_deadline_job="\${goat_deadline_probe% *}"; goat_deadline_group="\${goat_deadline_probe#* }"
    (
      trap '' HUP
      # Leaving from the trap stops the watchdog even when TERM lands just before a wait begins.
      # Its tick ends by itself: a shell may already have reaped it, so its PID could name another
      # process. The tick holds nothing but /dev/null.
      trap 'exit 0' TERM
      goat_deadline_me=
      # The job's shell signals this PID, so only a parent seen to have changed ends the watchdog;
      # one it cannot see counts as alive.
      goat_deadline_alive() { ! goat_deadline_ids || [ "$goat_deadline_ppid" = "$goat_deadline_job" ]; }
      goat_deadline_tick() { ${sleep} ${CHECK_SECONDS} & wait $!; }
      goat_deadline_left=${seconds}
      while [ "$goat_deadline_left" -gt 0 ]; do
        goat_deadline_tick
        goat_deadline_alive || exit 0
        goat_deadline_left=$((goat_deadline_left - ${CHECK_SECONDS}))
      done
      # Only a group that is this run's alone: the job's own, or the session shell's when it leads
      # its group, as under sshd. Inside another caller's group nothing is hung up.
      if [ "$goat_deadline_group" = "$goat_deadline_job" ] || [ "$goat_deadline_group" = "$$" ]; then
        kill -HUP 0
      fi
      while :; do goat_deadline_tick; goat_deadline_alive || exit 0; done
    ) >/dev/null 2>&1 </dev/null &
    goat_deadline_watchdog=$!
  fi
  (
  trap - HUP
${script}
  )
  goat_deadline_status=$?
  if [ -n "$goat_deadline_watchdog" ]; then
    kill -TERM "$goat_deadline_watchdog" 2>/dev/null
    # Only the watchdog's one hang-up can cut this wait short. A shell answers a finished child's
    # status again, even one a signal ended, so waiting while it exceeds 128 would spin.
    goat_deadline_hup=
    wait "$goat_deadline_watchdog" 2>/dev/null
    [ -z "$goat_deadline_hup" ] || wait "$goat_deadline_watchdog" 2>/dev/null
  fi
  exit "$goat_deadline_status"
) </dev/null &
goat_deadline_job=$!
set +m 2>/dev/null || :
goat_deadline_status=
while :; do
  wait "$goat_deadline_job"; goat_deadline_last=$?
  # A job reaped by an earlier wait answers 127; its status is the one already kept.
  [ -z "$goat_deadline_status" ] || [ "$goat_deadline_last" != 127 ] || break
  goat_deadline_status="$goat_deadline_last"
  # A hang-up of this shell cuts the wait short while the job still runs its cleanup.
  [ -n "$goat_deadline_hup" ] || break
  goat_deadline_hup=
done
exit "$goat_deadline_status"
`;
}
