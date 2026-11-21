import {
  LEGACY_SSH_ARCHIVE_VERSION_KEY,
  LEGACY_SSH_NODE_SCRIPT_PATH_KEY,
} from "@goat/contracts/legacyT3Names";

import { REMOTE_ARCHIVE_EXTRACT, REMOTE_ARCHIVE_FETCH } from "./remoteArchiveScripts.ts";
import { REMOTE_RUNTIME_PUBLISH_SCRIPT } from "./runtimeInstallScripts.ts";

/** The remote `goat` runner: finds, fetches or publishes the runtime it execs. */
export const REMOTE_RUNNER_SCRIPT = `#!/bin/sh
set -eu
GOAT_NODE_SCRIPT_PATH=@@GOAT_NODE_SCRIPT_PATH@@
# Older clients inspect these literal declarations without evaluating the runner.
${LEGACY_SSH_NODE_SCRIPT_PATH_KEY}=@@GOAT_NODE_SCRIPT_PATH@@
GOAT_ARCHIVE_VERSION=@@GOAT_ARCHIVE_VERSION@@
${LEGACY_SSH_ARCHIVE_VERSION_KEY}=@@GOAT_ARCHIVE_VERSION@@
# End of the declarations GOAT reads without running this runner.
${REMOTE_RUNTIME_PUBLISH_SCRIPT}@@GOAT_NODE_ENV_SCRIPT@@
if [ -n "$GOAT_NODE_SCRIPT_PATH" ]; then
  # Dev mode: a source checkout on the remote. This is the only path that
  # needs Node, so Node discovery runs here and nowhere else.
  ensure_remote_node_path || true
  if ! command -v node >/dev/null 2>&1; then
    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
    exit 1
  fi
  exec node "$GOAT_NODE_SCRIPT_PATH" "$@"
fi
if [ -z "$GOAT_ARCHIVE_VERSION" ]; then
  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2
  exit 1
fi
# Self-contained release archive: no Node, npm, or compiler on the remote.
# Unpacked into the pinned-runtime layout so \`goat service install\` reuses it.
GOAT_RELEASE_BASE_URL=@@GOAT_RELEASE_BASE_URL@@
GOAT_RUNTIME_DIR="$HOME/.goat/runtime/goat/versions/$GOAT_ARCHIVE_VERSION"
goat_runtime_ready() {
  [ -x "$GOAT_RUNTIME_DIR/goat" ] && [ "$(cat "$GOAT_RUNTIME_DIR/.install-complete" 2>/dev/null)" = "$GOAT_ARCHIVE_VERSION" ]
}
if ! goat_runtime_ready; then
  mkdir -p "$HOME/.goat/runtime/goat/versions"
  # Cleanup takes this mutex exclusively; installs may still run concurrently.
  if [ "$(uname -s)" = Linux ] && command -v flock >/dev/null 2>&1; then
    GOAT_MAINTENANCE="$HOME/.goat/runtime/goat/versions/.maintenance.lock"
    [ ! -L "$GOAT_MAINTENANCE" ] || exit 1
    exec 9>"$GOAT_MAINTENANCE"
    flock -w @@GOAT_ARCHIVE_LOCK_WAIT_SECONDS@@ -s 9
  fi
  GOAT_LOCK="$HOME/.goat/runtime/goat/versions/.$GOAT_ARCHIVE_VERSION.install.lock"
  # Publish a nonempty directory with an immutable pid and unique token by
  # same-filesystem rename. mv can nest it in an existing lock: only a token
  # at the lock root proves acquisition; losers clean their candidate and
  # retry. There is no mkdir-to-pid window at the shared lock path.
  # Reclaimers cd into the generation BEFORE reading its pid, and delete
  # only relative contents of that directory. The final rmdir cannot remove
  # a newer generation because every published lock is already nonempty.
  # A reclaim counts only once the lock is gone; a lock that cannot be
  # entered or emptied waits like a live one, so the timeout still applies.
  # Legacy pid-less locks retain their short grace period.
  GOAT_LOCK_CANDIDATE=""
  GOAT_LOCK_TOKEN=""
  GOAT_STAGING=""
  goat_remove_lock_contents() {
    find . ! -name . -prune -exec rm -rf {} \\; 2>/dev/null || true
    rmdir "$GOAT_LOCK" 2>/dev/null || [ ! -e "$GOAT_LOCK" ]
  }
  goat_lock_cleanup() {
    (
      cd "$GOAT_LOCK" 2>/dev/null || exit 0
      [ -n "$GOAT_LOCK_TOKEN" ] && [ -f "./$GOAT_LOCK_TOKEN" ] || exit 0
      goat_remove_lock_contents || true
    ) || true
    if [ -n "$GOAT_LOCK_CANDIDATE" ]; then
      rm -rf "$GOAT_LOCK_CANDIDATE" "$GOAT_LOCK/\${GOAT_LOCK_CANDIDATE##*/}"
    fi
    if [ -n "$GOAT_STAGING" ]; then goat_runtime_fs rm -rf "$GOAT_STAGING" || :; fi
  }
  trap 'goat_exit=$?; goat_lock_cleanup || true; exit "$goat_exit"' 0
  trap 'exit 1' 1 2 3 15
  goat_reclaim_lock() (
    if ! cd "$GOAT_LOCK" 2>/dev/null; then
      if [ -e "$GOAT_LOCK" ]; then exit 3; fi
      exit 0
    fi
    GOAT_LOCK_OWNER="$(cat pid 2>/dev/null || true)"
    if [ -n "$GOAT_LOCK_OWNER" ]; then
      if kill -0 "$GOAT_LOCK_OWNER" 2>/dev/null; then exit 2; fi
    elif [ "$GOAT_LOCK_UNOWNED" -lt 4 ]; then
      exit 1
    fi
    goat_remove_lock_contents || exit 3
  )
  GOAT_LOCK_WAITED=0
  GOAT_LOCK_UNOWNED=0
  while :; do
    GOAT_LOCK_CANDIDATE="$(mktemp -d "$GOAT_LOCK.candidate-$$-XXXXXX")"
    GOAT_LOCK_TOKEN="\${GOAT_LOCK_CANDIDATE##*/}"
    if { printf '%s\\n' "$$" > "$GOAT_LOCK_CANDIDATE/pid" &&
         : > "$GOAT_LOCK_CANDIDATE/$GOAT_LOCK_TOKEN"; } 2>/dev/null; then
      mv "$GOAT_LOCK_CANDIDATE" "$GOAT_LOCK" 2>/dev/null || true
      if [ -f "$GOAT_LOCK/$GOAT_LOCK_TOKEN" ]; then break; fi
    fi
    rm -rf "$GOAT_LOCK_CANDIDATE" "$GOAT_LOCK/$GOAT_LOCK_TOKEN"
    GOAT_LOCK_CANDIDATE=""
    if [ ! -e "$GOAT_LOCK" ]; then
      # Publication failed with no competing lock; wait so a persistent
      # failure reaches the timeout.
      :
    elif goat_reclaim_lock; then continue
    else
      GOAT_LOCK_STATUS=$?
      case "$GOAT_LOCK_STATUS" in
        1) GOAT_LOCK_UNOWNED=$((GOAT_LOCK_UNOWNED + 1)) ;;
        2) GOAT_LOCK_UNOWNED=0 ;;
      esac
    fi
    if [ "$GOAT_LOCK_WAITED" -ge @@GOAT_ARCHIVE_LOCK_WAIT_SECONDS@@ ]; then
      printf 'Another GOAT %s installation has held %s for too long.\\n' "$GOAT_ARCHIVE_VERSION" "$GOAT_LOCK" >&2
      exit 1
    fi
    sleep 1
    GOAT_LOCK_WAITED=$((GOAT_LOCK_WAITED + 1))
  done
fi
if ! goat_runtime_ready; then
  # Keep aligned with CLI_ARCHIVE_PLATFORM_KEYS in packages/shared/src/cliRelease.ts.
  case "$(uname -s) $(uname -m)" in
    "Darwin arm64") GOAT_PLATFORM_KEY="darwin-arm64" ;;
    "Linux arm64" | "Linux aarch64") GOAT_PLATFORM_KEY="linux-arm64" ;;
    "Linux x86_64" | "Linux amd64") GOAT_PLATFORM_KEY="linux-x64" ;;
    MINGW*" arm64" | MSYS*" arm64" | CYGWIN*" arm64" | MINGW*" aarch64" | MSYS*" aarch64" | CYGWIN*" aarch64") GOAT_PLATFORM_KEY="win32-arm64" ;;
    MINGW*" x86_64" | MSYS*" x86_64" | CYGWIN*" x86_64") GOAT_PLATFORM_KEY="win32-x64" ;;
    MINGW*" amd64" | MSYS*" amd64" | CYGWIN*" amd64") GOAT_PLATFORM_KEY="win32-x64" ;;
    *) printf 'Remote host %s %s has no GOAT release archive.\n' "$(uname -s)" "$(uname -m)" >&2; exit 1 ;;
  esac
  GOAT_ARCHIVE="goat-$GOAT_ARCHIVE_VERSION-$GOAT_PLATFORM_KEY.tar.gz"
  case "$GOAT_PLATFORM_KEY" in win32-*) GOAT_ARCHIVE="goat-$GOAT_ARCHIVE_VERSION-$GOAT_PLATFORM_KEY.zip" ;; esac
  GOAT_STAGING="$(mktemp -d "$HOME/.goat/runtime/goat/versions/.staging-XXXXXX")"
${REMOTE_ARCHIVE_FETCH}
  goat_fetch "$GOAT_RELEASE_BASE_URL/v$GOAT_ARCHIVE_VERSION/SHA256SUMS" "$GOAT_STAGING/SHA256SUMS" @@GOAT_ARCHIVE_CHECKSUMS_SECONDS@@
  goat_fetch "$GOAT_RELEASE_BASE_URL/v$GOAT_ARCHIVE_VERSION/$GOAT_ARCHIVE" "$GOAT_STAGING/$GOAT_ARCHIVE" @@GOAT_ARCHIVE_DOWNLOAD_SECONDS@@
  GOAT_EXPECTED="$(grep " \\*\\{0,1\\}$GOAT_ARCHIVE$" "$GOAT_STAGING/SHA256SUMS" | cut -d' ' -f1)"
  if command -v sha256sum >/dev/null 2>&1; then
    GOAT_ACTUAL="$(sha256sum < "$GOAT_STAGING/$GOAT_ARCHIVE" | cut -d' ' -f1)"
  else
    GOAT_ACTUAL="$(shasum -a 256 < "$GOAT_STAGING/$GOAT_ARCHIVE" | cut -d' ' -f1)"
  fi
  if [ -z "$GOAT_EXPECTED" ] || [ "$GOAT_ACTUAL" != "$GOAT_EXPECTED" ]; then
    printf 'Checksum mismatch for %s.\\n' "$GOAT_ARCHIVE" >&2; exit 1
  fi
${REMOTE_ARCHIVE_EXTRACT}
  rm -f "$GOAT_STAGING/$GOAT_ARCHIVE" "$GOAT_STAGING/SHA256SUMS"
  # Verify the executable and exact version before replacing a runtime,
  # including a same-version directory whose completion marker is broken.
  if ! GOAT_STAGED_VERSION_OUTPUT="$("$GOAT_STAGING/goat" --version)"; then
    printf 'The goat %s executable does not run on this host.\\n' "$GOAT_ARCHIVE_VERSION" >&2; exit 1
  fi
  if [ "$GOAT_STAGED_VERSION_OUTPUT" != "goat v$GOAT_ARCHIVE_VERSION" ]; then
    printf 'Cannot install goat %s: expected goat v%s, but the archive executable reported "%s". The existing runtime directory and completion marker have been left unchanged. Supply the correct requested archive in the local SSH runtime archive directory or release mirror, then retry.\\n' "$GOAT_ARCHIVE_VERSION" "$GOAT_ARCHIVE_VERSION" "$GOAT_STAGED_VERSION_OUTPUT" >&2
    exit 1
  fi
  if command -v shasum >/dev/null 2>&1; then
    GOAT_EXECUTABLE_SHA256="$(shasum -a 256 < "$GOAT_STAGING/goat" | cut -d' ' -f1)"
  else
    GOAT_EXECUTABLE_SHA256="$(sha256sum < "$GOAT_STAGING/goat" | cut -d' ' -f1)"
  fi
  case "$GOAT_EXECUTABLE_SHA256" in *[!0123456789abcdef]*|'') printf 'Could not verify the GOAT executable checksum.\\n' >&2; exit 1 ;; esac
  [ "\${#GOAT_EXECUTABLE_SHA256}" = 64 ] || { printf 'Could not verify the GOAT executable checksum.\\n' >&2; exit 1; }
  # Publish provenance with the verified executable, never backfill legacy directories.
  # The uploader names its source in the environment so run-t3.sh bytes stay source-free:
  # retained-runner identity compares those bytes across launches.
  case "\${GOAT_SSH_ARCHIVE_SOURCE:-}" in
    bundle|cache|gh) GOAT_RECORD_SOURCE="$GOAT_SSH_ARCHIVE_SOURCE" ;;
    *) GOAT_RECORD_SOURCE=@@GOAT_DOWNLOAD_SOURCE@@ ;;
  esac
  printf '%s %s %s %s\\n' "$GOAT_ARCHIVE_VERSION" "$GOAT_EXPECTED" "$GOAT_EXECUTABLE_SHA256" "$GOAT_RECORD_SOURCE" > "$GOAT_STAGING/.install-record"
  printf '%s\\n' "$GOAT_ARCHIVE_VERSION" > "$GOAT_STAGING/.install-complete"
  goat_runtime_publish "$GOAT_STAGING" "$GOAT_RUNTIME_DIR" "$GOAT_ARCHIVE_VERSION"
fi
if [ -n "\${GOAT_LOCK:-}" ]; then
  goat_lock_cleanup
  trap - 0 1 2 3 15
fi
exec 9>&-
exec "$GOAT_RUNTIME_DIR/goat" "$@"
`;
