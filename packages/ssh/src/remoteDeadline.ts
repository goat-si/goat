/**
 * Without a terminal, sshd never hangs up a script whose client timed out, so it and its goat
 * helpers kept running. A watchdog in the same shell hangs it up after the client's deadline;
 * nohup and detached-PowerShell servers are outside its reach and keep running.
 */
const GRACE_SECONDS = 5;
const CHECK_SECONDS = 2;

/** `sh [-l] -s [-- args]`: the script arrives on stdin. Uploads (`sh -c`) stream data instead. */
export function isRemoteShellScript(args: ReadonlyArray<string> | undefined) {
  if (args === undefined || args[0] !== "sh") return false;
  const options = args.slice(1, args.includes("--") ? args.indexOf("--") : undefined);
  return options.includes("-s") && options.every((option) => option === "-s" || option === "-l");
}

export function withRemoteDeadline(
  script: string,
  timeoutMs: number,
  // `command -p` bypasses PATH, so a script's own sleep shim cannot speed up the deadline.
  sleep = "command -p sleep",
) {
  const seconds = Math.ceil(timeoutMs / 1000) + GRACE_SECONDS;
  return `(
  trap '' HUP
  goat_deadline_left=${seconds}
  while [ "$goat_deadline_left" -gt 0 ]; do
    ${sleep} ${CHECK_SECONDS}
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
    # Read the children before the shell exits; a trapping shell waits for them to go.
    goat_deadline_children="$(pgrep -P $$ 2>/dev/null || true)"
    kill -HUP $$ 2>/dev/null
    for goat_deadline_child in $goat_deadline_children; do kill -HUP "$goat_deadline_child" 2>/dev/null; done
  fi
) >/dev/null 2>&1 </dev/null &
${script}`;
}
