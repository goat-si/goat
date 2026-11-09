/**
 * Without a terminal, sshd never hangs up a script whose client timed out, so it and its goat
 * helpers kept running. A watchdog in the same shell hangs it up after the client's deadline;
 * nohup and detached-PowerShell servers are outside its reach and keep running.
 */
const GRACE_SECONDS = 5;
const CHECK_SECONDS = 2;
// sshd starts the shell for a request the client sent before it gave up; this covers that delay.
const START_SLACK_SECONDS = 5;

const DEFAULT_SLEEP = "command -p sleep";
/** Shell bodies for a read tick: `now` sets goat_deadline_t in microseconds or fails; `read` waits up to $1 s, a decimal. */
export type ReadTick = { readonly now: string; readonly read: string };
// EPOCHREALTIME (bash 5) separates seconds from microseconds with the locale's decimal point.
export const READ_TICK: ReadTick = {
  now: [
    '        goat_deadline_t="${EPOCHREALTIME:-}"',
    '        case "$goat_deadline_t" in *[.,]*) ;; *) return 1 ;; esac',
    '        goat_deadline_t="${goat_deadline_t%[.,]*}${goat_deadline_t#*[.,]}"',
    '        case "$goat_deadline_t" in *[!0123456789]*) return 1 ;; esac',
  ].join("\n"),
  read: '          read -t "$1" -u 9 goat_deadline_line',
};

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
  sleep = DEFAULT_SLEEP,
  // Tests point this at a missing file to take /proc away.
  selfStat = "/proc/self/stat",
  // A caller that brings its own sleep tick keeps it unless it brings read-tick hooks too.
  ticks: ReadTick | undefined = sleep === DEFAULT_SLEEP ? READ_TICK : undefined,
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
      # Leaving from the trap stops the watchdog even when TERM lands just before a wait begins, and
      # takes a tick directory of its own still being set up with it. A sleep tick ends by itself: a
      # shell may already have reaped it, so its PID could name another process.
      trap 'goat_deadline_drop; exit 0' TERM
      goat_deadline_me=; goat_deadline_dir=
      # Removes the tick directory, named before it was made, when it is this user's own directory.
      goat_deadline_drop() {
        [ -n "$goat_deadline_dir" ] && [ -d "$goat_deadline_dir" ] && [ ! -L "$goat_deadline_dir" ] &&
          [ -O "$goat_deadline_dir" ] && rm -rf "$goat_deadline_dir"
        goat_deadline_dir=
      }
      # The job's shell signals this PID, so only a parent seen to have changed ends the watchdog;
      # one it cannot see counts as alive.
      goat_deadline_alive() { ! goat_deadline_ids || [ "$goat_deadline_ppid" = "$goat_deadline_job" ]; }
      # Sets goat_deadline_t to a time in microseconds, or fails.
      goat_deadline_now() {
${ticks?.now ?? "        return 1"}
      }
      # Windows OpenSSH keeps a channel open while a sleep tick outlives a stopped watchdog, so bash
      # reads, until a deadline taken from the clock, on a private FIFO that nothing writes. Other
      # shells, and any failed step, sleep and count each step.
      goat_deadline_tick=sleep
      goat_deadline_left=${seconds * 1_000_000}
      if [ -n "\${BASH_VERSION:-}" ] && goat_deadline_now; then
        goat_deadline_end=$((goat_deadline_t + goat_deadline_left))
        for goat_deadline_try in 1 2 3; do
          goat_deadline_dir="\${TMPDIR:-/tmp}/goat-deadline.$$.$RANDOM$RANDOM"
          mkdir -m 700 "$goat_deadline_dir" 2>/dev/null && break
          goat_deadline_dir=
        done
        if [ -n "$goat_deadline_dir" ] && mkfifo "$goat_deadline_dir/tick" 2>/dev/null &&
          { command exec 9<>"$goat_deadline_dir/tick"; } 2>/dev/null; then goat_deadline_tick=read; fi
        goat_deadline_drop
      fi
      goat_deadline_read() {
${ticks?.read ?? "        return 1"}
      }
      # Sleeps $1 whole seconds or reads up to \${2:-$1}. A read that ends any way but its timeout or a
      # signal leaves the FIFO for sleep.
      goat_deadline_wait() {
        if [ "$goat_deadline_tick" = read ]; then
          goat_deadline_read "\${2:-$1}"
          [ "$?" -gt 128 ] && return 0
          goat_deadline_tick=sleep; exec 9<&-
        fi
        ${sleep} "$1" & wait $!
      }
      while :; do
        goat_deadline_part=
        if [ "$goat_deadline_tick" = read ]; then
          if goat_deadline_now; then goat_deadline_left=$((goat_deadline_end - goat_deadline_t))
          else goat_deadline_tick=sleep; exec 9<&-; fi
        fi
        [ "$goat_deadline_left" -gt 0 ] || break
        goat_deadline_step=$(( (goat_deadline_left + 999999) / 1000000 ))
        [ "$goat_deadline_step" -le ${CHECK_SECONDS} ] || goat_deadline_step=${CHECK_SECONDS}
        if [ "$goat_deadline_tick" = read ] && [ "$goat_deadline_left" -lt ${CHECK_SECONDS * 1_000_000} ]; then
          printf -v goat_deadline_part '%d.%06d' $((goat_deadline_left / 1000000)) $((goat_deadline_left % 1000000))
        fi
        goat_deadline_wait "$goat_deadline_step" "$goat_deadline_part"
        goat_deadline_alive || exit 0
        [ "$goat_deadline_tick" = read ] ||
          goat_deadline_left=$((goat_deadline_left - goat_deadline_step * 1000000))
      done
      # Only a group that is this run's alone: the job's own, or the session shell's when it leads
      # its group, as under sshd. Inside another caller's group nothing is hung up.
      if [ "$goat_deadline_group" = "$goat_deadline_job" ] || [ "$goat_deadline_group" = "$$" ]; then
        kill -HUP 0
      fi
      while :; do goat_deadline_wait ${CHECK_SECONDS}; goat_deadline_alive || exit 0; done
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
