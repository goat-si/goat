/**
 * Without a terminal, sshd never hangs up a script whose client timed out, so it and its goat
 * helpers kept running. A watchdog in the same shell hangs it up after the client's deadline;
 * nohup and detached-PowerShell servers are outside its reach and keep running.
 */
const GRACE_SECONDS = 5;
const CHECK_SECONDS = 2;
// sshd starts the shell for a request the client sent before it gave up; this covers that delay.
const START_SLACK_SECONDS = 5;
const WINDOWS_HANGUP_GRACE_SECONDS = 10;

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
  return (
    (Math.ceil(timeoutMs / 1000) +
      GRACE_SECONDS +
      CHECK_SECONDS +
      START_SLACK_SECONDS +
      WINDOWS_HANGUP_GRACE_SECONDS) *
    1000
  );
}

/**
 * The watchdog runs inside the script's job and hangs up only its own process group, so no PID read
 * from a process list is ever signalled. The job's shell outlives the script's own hang-up cleanup
 * and then stops the watchdog, which never ends by itself while that shell is alive; the outer
 * shell, which the script's locks record as owner, waits for the job.
 */
export function withRemoteDeadline(
  script: string,
  timeoutMs: number,
  // `command -p` bypasses PATH, so a script's own sleep shim cannot speed up the deadline.
  sleep = "command -p sleep",
) {
  const seconds = Math.ceil(timeoutMs / 1000) + GRACE_SECONDS;
  return `trap 'goat_deadline_hup=1' HUP
goat_deadline_hup=
# bash gives the job its own process group; dash without a terminal cannot, and keeps this shell's.
set -m 2>/dev/null || :
(
  trap : HUP
  set +m 2>/dev/null || :
  (
    trap '' HUP
    # Leaving from the trap stops the watchdog even when TERM lands just before a wait begins. Its
    # tick ends by itself: a shell may already have reaped it, so its PID could name another
    # process. The tick holds nothing but /dev/null.
    trap 'exit 0' TERM
    # Sets goat_deadline_ppid and goat_deadline_pgid for this process.
    goat_deadline_ids() {
      if [ -r /proc/self/stat ] && IFS= read -r goat_deadline_stat </proc/self/stat; then
        set -f; set -- \${goat_deadline_stat##*) }; set +f
      else
        [ -n "\${goat_deadline_me:-}" ] || goat_deadline_me="$(exec sh -c 'echo "$PPID"')"
        set -f; set -- - $(ps -o ppid=,pgid= -p "$goat_deadline_me" 2>/dev/null); set +f
      fi
      goat_deadline_ppid="\${2:-}"; goat_deadline_pgid="\${3:-}"
    }
    goat_deadline_ids; goat_deadline_job="$goat_deadline_ppid"
    goat_deadline_alive() { goat_deadline_ids; [ -n "$goat_deadline_job" ] && [ "$goat_deadline_ppid" = "$goat_deadline_job" ]; }
    goat_deadline_tick() { ${sleep} ${CHECK_SECONDS} & wait $!; }
    goat_deadline_left=${seconds}
    while [ "$goat_deadline_left" -gt 0 ]; do
      goat_deadline_tick
      goat_deadline_alive || exit 0
      goat_deadline_left=$((goat_deadline_left - ${CHECK_SECONDS}))
    done
    # Only a group that is this run's alone: the job's own, or the session shell's when it leads its
    # group, as under sshd. Inside another caller's group nothing is hung up.
    if [ "$goat_deadline_pgid" = "$goat_deadline_job" ] || [ "$goat_deadline_pgid" = "$$" ]; then
      kill -HUP 0
    fi
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*)
        # Native goat.exe children can ignore the hang-up. After the script's own cleanup had its
        # grace, end the job's tree; its shell waits for this watchdog, so its PID still names it.
        goat_deadline_left=${WINDOWS_HANGUP_GRACE_SECONDS}
        while [ "$goat_deadline_left" -gt 0 ]; do
          goat_deadline_tick
          goat_deadline_alive || exit 0
          goat_deadline_left=$((goat_deadline_left - ${CHECK_SECONDS}))
        done
        if goat_deadline_winpid="$(cat "/proc/$goat_deadline_job/winpid" 2>/dev/null)"; then
          MSYS2_ARG_CONV_EXCL='*' taskkill.exe /PID "$goat_deadline_winpid" /T /F >/dev/null 2>&1
        fi ;;
    esac
    # The job's shell signals this PID, so it stays until stopped or orphaned.
    while :; do goat_deadline_tick; goat_deadline_alive || exit 0; done
  ) >/dev/null 2>&1 </dev/null &
  goat_deadline_watchdog=$!
  (
  trap - HUP
${script}
  )
  goat_deadline_status=$?
  kill -TERM "$goat_deadline_watchdog" 2>/dev/null
  until wait "$goat_deadline_watchdog" 2>/dev/null; [ "$?" -le 128 ]; do :; done
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
exit "$goat_deadline_status"`;
}
