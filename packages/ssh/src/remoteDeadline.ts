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
 * The script runs in a subshell so this shell can stop the watchdog the moment it ends: a ticking
 * watchdog held a Windows SSH channel open until its next tick. This shell, whose PID the
 * script's lock records as owner, outlives a hang-up until the script's own cleanup has run.
 */
export function withRemoteDeadline(
  script: string,
  timeoutMs: number,
  // `command -p` bypasses PATH, so a script's own sleep shim cannot speed up the deadline.
  sleep = "command -p sleep",
) {
  const seconds = Math.ceil(timeoutMs / 1000) + GRACE_SECONDS;
  return `trap ':' HUP
(
  trap '' HUP
  goat_deadline_sleep=
  trap 'kill "$goat_deadline_sleep" 2>/dev/null; wait "$goat_deadline_sleep" 2>/dev/null; exit 0' TERM
  goat_deadline_left=${seconds}
  while [ "$goat_deadline_left" -gt 0 ]; do
    ${sleep} ${CHECK_SECONDS} &
    goat_deadline_sleep=$!
    wait "$goat_deadline_sleep"
    kill -0 $$ 2>/dev/null || exit 0
    goat_deadline_left=$((goat_deadline_left - ${CHECK_SECONDS}))
  done
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      # Native goat.exe children are Windows processes; end the script's whole tree.
      if goat_deadline_winpid="$(cat "/proc/$$/winpid" 2>/dev/null)"; then
        MSYS2_ARG_CONV_EXCL='*' taskkill.exe /PID "$goat_deadline_winpid" /T /F >/dev/null 2>&1
      fi ;;
  esac
  if [ "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')" = "$$" ]; then kill -HUP 0
  else
    # Read the tree before anything exits: the script subshell and its children, which a
    # trapping shell waits for.
    goat_deadline_children="$(pgrep -P $$ 2>/dev/null || true)"
    goat_deadline_tree="$goat_deadline_children"
    for goat_deadline_child in $goat_deadline_children; do
      goat_deadline_tree="$goat_deadline_tree $(pgrep -P "$goat_deadline_child" 2>/dev/null || true)"
    done
    kill -HUP $$ 2>/dev/null
    for goat_deadline_child in $goat_deadline_tree; do kill -HUP "$goat_deadline_child" 2>/dev/null; done
  fi
) >/dev/null 2>&1 </dev/null &
goat_deadline_watchdog=$!
(
trap - HUP
${script}
)
goat_deadline_status=$?
kill "$goat_deadline_watchdog" 2>/dev/null
wait "$goat_deadline_watchdog" 2>/dev/null
exit "$goat_deadline_status"`;
}
