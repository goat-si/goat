import { applyScriptPlaceholders, shellSingleQuote } from "./remoteRuntime.ts";
import { REMOTE_PROTOCOL_TOKEN_SCRIPT } from "./runtimeFactsScripts.ts";
import { REMOTE_REPLACEMENT_LOCK_SCRIPT } from "./runtimeOwnershipScripts.ts";
import { SshLaunchError } from "./errors.ts";

/**
 * Installers are transient copies of the runner with its fetch block swapped out, so the
 * managed run-t3.sh bytes (and the retained-runner identity built on them) never change.
 */
export function replaceRunnerAcquisitionBlock(
  script: string,
  replace: (block: string) => string,
): string {
  const startAnchor = '  goat_fetch "$GOAT_RELEASE_BASE_URL/v$GOAT_ARCHIVE_VERSION/SHA256SUMS"';
  const endAnchor = "  if command -v sha256sum >/dev/null 2>&1; then";
  const start = script.indexOf(startAnchor);
  const end = script.indexOf(endAnchor);
  if (
    start < 0 ||
    end <= start ||
    script.indexOf(startAnchor, start + 1) !== -1 ||
    script.indexOf(endAnchor, end + 1) !== -1
  ) {
    throw new SshLaunchError({ message: "acquisition block no longer matches", stdout: "" });
  }
  return script.slice(0, start) + replace(script.slice(start, end)) + script.slice(end);
}

// curl --retry and wget --tries back off only on transient failures (timeouts, 408, 429,
// 5xx), so a 404 or a host without DNS fails at once and the client uploads instead.
export const REMOTE_HOST_FETCH_FUNCTION = `  goat_host_fetch() {
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --connect-timeout 10 --retry 2 --max-time "$3" "$1" -o "$2" && return 0
    elif command -v wget >/dev/null 2>&1; then
      if wget --help 2>&1 | grep -q -- --retry-on-http-error; then
        wget -q --timeout=30 --tries=3 --waitretry=2 --retry-on-http-error=408,429,500,502,503,504 "$1" -O "$2" && return 0
      else
        wget -q --timeout=30 --tries=3 --waitretry=2 "$1" -O "$2" && return 0
      fi
    else
      printf 'Remote host needs curl or wget to download %s.\\n' "$GOAT_ARCHIVE" >&2
      return 1
    fi
    printf 'Remote host could not download %s.\\n' "$1" >&2
    return 1
  }
`;

/**
 * The SSH invocation that runs the upload script with the archive on stdin. Windows OpenSSH
 * truncates a remote command near 8 KiB, so a Windows host reads the script from the front of
 * stdin, ahead of the archive. dd reads it a byte at a time: a buffered reader such as BSD head
 * would also consume the start of the archive.
 */
export function remoteUploadCommand(
  script: string,
  archive: Uint8Array,
  platform: "darwin" | "linux" | "win32",
): {
  readonly remoteCommandArgs: ReadonlyArray<string>;
  readonly stdin: Uint8Array;
  readonly archiveOffset: number;
  readonly archiveLength: number;
} {
  if (platform !== "win32") {
    return {
      remoteCommandArgs: ["sh", "-c", shellSingleQuote(script)],
      stdin: archive,
      archiveOffset: 0,
      archiveLength: archive.byteLength,
    };
  }
  const scriptBytes = new TextEncoder().encode(script);
  const stdin = new Uint8Array(scriptBytes.byteLength + archive.byteLength);
  stdin.set(scriptBytes);
  stdin.set(archive, scriptBytes.byteLength);
  const bootstrap = `upload_script="$(mktemp)" && dd bs=1 count=${scriptBytes.byteLength} of="$upload_script" 2>/dev/null && sh "$upload_script"; upload_status=$?; rm -f "$upload_script"; exit "$upload_status"`;
  return {
    remoteCommandArgs: ["sh", "-c", shellSingleQuote(bootstrap)],
    stdin,
    archiveOffset: scriptBytes.byteLength,
    archiveLength: archive.byteLength,
  };
}

/**
 * `fresh`: prints yes when the host has no GOAT database. `capable <version>`: prints yes
 * when that installed runtime's `auth session issue --help` succeeds and lists `memory:read`
 * (#285); partial output from a failing command is not evidence.
 * `hold <version>` / `reject <version>`: marks it held (`pending`) or refused for good. The
 * probe reports the mark, installed and retained recovery skip held runtimes, and launch
 * clears a `pending` mark once the server it started on a host without data is ready.
 * Marks change only under the launch's replacement lock and only while the host has no data,
 * so a setup that lost a race to another client can never hold or reject the runtime that
 * client started.
 */
const REMOTE_PUBLISHED_RUNTIME_GATE_SCRIPT = `set -u
DEFAULT_SERVER_HOME="$HOME/.goat"
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
has_data() {
  for db in "$DEFAULT_SERVER_HOME/userdata/statev2.sqlite" "$DEFAULT_SERVER_HOME/userdata/state.sqlite"; do
    if [ -e "$db" ] || [ -L "$db" ]; then return 0; fi
  done
  return 1
}
case "$1" in
  fresh)
    if has_data; then echo no; else echo yes; fi ;;
  capable)
    exe="$HOME/.goat/runtime/goat/versions/$2/goat"
    [ -x "$exe" ] || { echo no; exit 0; }
    scope_help="$("$exe" auth session issue --help 2>/dev/null)" || { echo no; exit 0; }
    case "$scope_help" in *memory:read*) echo yes ;; *) echo no ;; esac ;;
  hold | reject)
    case "$2" in '' | */* | . | ..) exit 2 ;; esac
    if [ "$1" = hold ]; then state=pending; else state=rejected; fi
    mkdir -p "$STATE_DIR"
@@GOAT_PROTOCOL_TOKENS@@
@@GOAT_REPLACEMENT_LOCK@@
    trap 'release_recovery_lock; release_replacement_lock' EXIT
    if ! acquire_replacement_lock; then
      if ! wait_for_replacement_lock || ! acquire_replacement_lock; then echo busy; exit 0; fi
    fi
    if has_data; then echo no; exit 0; fi
    held_dir="$HOME/.goat/runtime/goat/held"
    # Replace atomically: a torn write must never read as anything but held.
    mkdir -p "$held_dir" &&
      printf '%s\\n' "$state" > "$held_dir/.$2.$$" &&
      mv -f "$held_dir/.$2.$$" "$held_dir/$2" && echo yes ;;
  *) exit 2 ;;
esac
`;

export function buildPublishedRuntimeGateScript(stateKey: string): string {
  return applyScriptPlaceholders(REMOTE_PUBLISHED_RUNTIME_GATE_SCRIPT, {
    GOAT_STATE_KEY: stateKey,
    GOAT_PROTOCOL_TOKENS: REMOTE_PROTOCOL_TOKEN_SCRIPT,
    GOAT_REPLACEMENT_LOCK: REMOTE_REPLACEMENT_LOCK_SCRIPT,
  });
}
