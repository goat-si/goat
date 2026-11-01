import { ChildProcess } from "effect/process";

// Both forwards and masters keep askpass inside a private scoped runtime directory.
const OWNED_AUTH_DIRECTORY = /^(.*\/goat-ssh-runtime-[^/]+)\/t3code-ssh-askpass\/[^/]+$/u;

/**
 * The directory the supervisor may delete when the owner dies. Anything other than GOAT's
 * own per-session temp directory yields "", so a crash can never remove a shared directory.
 */
export function ownedAuthDirectory(askpassPath: string | undefined): string {
  return askpassPath === undefined ? "" : (OWNED_AUTH_DIRECTORY.exec(askpassPath)?.[1] ?? "");
}

// ssh -N ignores stdin EOF. A separate reader keeps the owner's pipe alive and
// kills only this dedicated process group if the owner disappears without cleanup.
// The reader ignores the group's graceful signals: an owner that dies during its own
// SIGTERM grace period must still leave the reader to fence a SIGTERM-resistant ssh.
// The reader takes the pipe through fd 3 because dash points a background job's stdin
// at /dev/null even when the job redirects from fd 0. The supervisor waits until ssh has
// really exited, since each further signal interrupts wait.
export const OWNER_PIPE_SUPERVISOR = `auth_directory=$1
shift
exec 3<&0
(
  trap '' TERM INT HUP
  while IFS= read -r ignored <&3; do :; done
  if [ -n "$auth_directory" ]; then rm -rf -- "$auth_directory"; fi
  kill -KILL "-$$"
) &
watcher=$!
"$@" </dev/null 3<&- &
ssh_pid=$!
exec 3<&-
trap 'interrupted=1; kill -TERM "$ssh_pid" 2>/dev/null' TERM INT HUP
status=
while :; do
  interrupted=0
  wait "$ssh_pid" 2>/dev/null
  waited=$?
  # A signal right after wait returned makes the next wait find no child: macOS sh then
  # answers 127, and the status already collected stands.
  if [ "$waited" -ne 127 ] || [ -z "$status" ]; then status=$waited; fi
  [ "$interrupted" -eq 0 ] && break
done
kill -KILL "$watcher" 2>/dev/null
wait "$watcher" 2>/dev/null
exit "$status"
`;

export function makeOwnedSshTunnelCommand(
  platform: NodeJS.Platform,
  executable: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions,
  authDirectory: string = "",
) {
  if (platform === "win32") return ChildProcess.make(executable, args, options);
  return ChildProcess.make(
    "/bin/sh",
    ["-c", OWNER_PIPE_SUPERVISOR, "goat-ssh-forward", authDirectory, executable, ...args],
    {
      ...options,
      // $$ must identify a group exclusively owned by this supervisor.
      detached: true,
      stdin: { stream: "pipe", endOnDone: false },
    },
  );
}
