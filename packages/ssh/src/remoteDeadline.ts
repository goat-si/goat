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
  goat_deadline_sleep=; goat_deadline_stop=
  # The script ended: stop the running tick and leave. KILL, since a TERM landing between a tick's
  # fork and exec is lost; a stop before a tick is named is acted on once it is.
  trap 'if [ -n "$goat_deadline_sleep" ]; then kill -KILL "$goat_deadline_sleep" 2>/dev/null; wait "$goat_deadline_sleep" 2>/dev/null; exit 0; fi; goat_deadline_stop=1' TERM
  goat_deadline_tick() {
    [ -z "$goat_deadline_stop" ] || exit 0
    ${sleep} ${CHECK_SECONDS} &
    goat_deadline_sleep=$!
    if [ -n "$goat_deadline_stop" ]; then kill -KILL "$goat_deadline_sleep" 2>/dev/null; wait "$goat_deadline_sleep" 2>/dev/null; exit 0; fi
    wait "$goat_deadline_sleep"
    goat_deadline_sleep=
  }
  goat_deadline_left=${seconds}
  while [ "$goat_deadline_left" -gt 0 ]; do
    goat_deadline_tick
    kill -0 $$ 2>/dev/null || exit 0
    goat_deadline_left=$((goat_deadline_left - ${CHECK_SECONDS}))
  done
  if [ "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')" = "$$" ]; then kill -HUP 0
  else
    # Freeze each child before reading its children, so none forks or orphans one unseen. Git Bash
    # has no pgrep; its ps lists PID PPID ..., with a status letter in front of some rows.
    goat_deadline_children() {
      if command -v pgrep >/dev/null 2>&1; then pgrep -P "$1" 2>/dev/null || true
      else ps 2>/dev/null | awk -v p="$1" 'NR > 1 { if ($1 !~ /^[0-9]+$/) { $1 = ""; $0 = $0 } if ($2 == p) print $1 }'; fi
    }
    goat_deadline_self="$(exec sh -c 'echo "$PPID"')"
    goat_deadline_tree=
    for goat_deadline_child in $(goat_deadline_children $$); do
      [ "$goat_deadline_child" != "$goat_deadline_self" ] || continue
      kill -STOP "$goat_deadline_child" 2>/dev/null
      goat_deadline_tree="$goat_deadline_tree $goat_deadline_child $(goat_deadline_children "$goat_deadline_child")"
    done
    for goat_deadline_child in $goat_deadline_tree; do kill -HUP "$goat_deadline_child" 2>/dev/null; done
    for goat_deadline_child in $goat_deadline_tree; do kill -CONT "$goat_deadline_child" 2>/dev/null; done
  fi
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      # Native goat.exe children can ignore the hang-up. After the script's own cleanup had its
      # grace, end what is left of its tree.
      goat_deadline_left=${WINDOWS_HANGUP_GRACE_SECONDS}
      while [ "$goat_deadline_left" -gt 0 ] && kill -0 $$ 2>/dev/null; do
        goat_deadline_tick
        goat_deadline_left=$((goat_deadline_left - ${CHECK_SECONDS}))
      done
      if kill -0 $$ 2>/dev/null && goat_deadline_winpid="$(cat "/proc/$$/winpid" 2>/dev/null)"; then
        MSYS2_ARG_CONV_EXCL='*' taskkill.exe /PID "$goat_deadline_winpid" /T /F >/dev/null 2>&1
      fi ;;
  esac
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
