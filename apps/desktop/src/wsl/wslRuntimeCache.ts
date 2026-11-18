import {
  LEGACY_WSL_RUNTIME_PATH,
  LEGACY_WSL_RUNTIME_READY_MARKER,
  LEGACY_WSL_RUNTIME_SELECTED_MARKER,
} from "@goat/contracts/legacyT3Names";

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const WSL_RUNTIME_READY_MARKER = ".goat-wsl-runtime-ready";
const WSL_RUNTIME_SELECTED_MARKER = ".goat-wsl-runtime-selected";
const WSL_RUNTIME_SELECTION_GRACE_MINUTES = 5;

const sanitizeWslRuntimeId = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "_");

// Reuse the old parent in place so an upgrade does not install a second copy or
// move files out from under a running backend. A fresh distro uses the GOAT root.
const buildWslRuntimeParentScript = (safeRuntimeId: string) => [
  'runtime_parent="$HOME/.goat/wsl-runtime"',
  `if [ ! -d "$runtime_parent/${safeRuntimeId}" ] && [ -d "$HOME/${LEGACY_WSL_RUNTIME_PATH}" ]; then`,
  `  if [ ! -d "$runtime_parent" ] || [ -d "$HOME/${LEGACY_WSL_RUNTIME_PATH}/${safeRuntimeId}" ]; then`,
  `    runtime_parent="$HOME/${LEGACY_WSL_RUNTIME_PATH}"`,
  "  fi",
  "fi",
];

export const buildWslRuntimeInstallScript = (
  linuxArchivePath: string | null,
  runtimeId: string,
  archiveSha256: string,
): string => {
  const safeRuntimeId = sanitizeWslRuntimeId(runtimeId);
  const readyCheck = [
    "set -eu",
    ...buildWslRuntimeParentScript(safeRuntimeId),
    `runtime_root="$runtime_parent/${safeRuntimeId}"`,
    `ready_marker="$runtime_root/${WSL_RUNTIME_READY_MARKER}"`,
    "runtime_entry_runs() {",
    '  [ -x "$1/goat" ] && "$1/goat" --version >/dev/null',
    "}",
    // Hashing the entry is what tells a working cache from one whose `goat` was
    // swapped or half-written after install: the file is still there and may
    // even still run, and launch then picks an executable that is not what this
    // install verified.
    "runtime_server_entry_digest() {",
    `  sha256sum "$1/goat" 2>/dev/null | cut -d ' ' -f 1`,
    "}",
    "runtime_is_ready() {",
    // The usual ready-file check short-circuits legacy recognition on warm launches.
    '  if [ ! -f "$ready_marker" ]; then',
    `    ready_marker="$runtime_root/${LEGACY_WSL_RUNTIME_READY_MARKER}"`,
    '    [ -f "$ready_marker" ] || return 1',
    "  fi",
    '    runtime_entry_runs "$runtime_root" 2>/dev/null &&',
    `    recorded_entry_digest=$(tr -d '[:space:]' < "$ready_marker" 2>/dev/null) &&`,
    '    [ -n "$recorded_entry_digest" ] &&',
    '    [ "$recorded_entry_digest" = "$(runtime_server_entry_digest "$runtime_root")" ]',
    "}",
    'mkdir -p "$runtime_parent"',
    `runtime_lock="$runtime_parent/.${safeRuntimeId}.install.lock"`,
    "trap 'exit 1' HUP INT TERM",
    'exec 9> "$runtime_lock"',
    "flock -x 9",
    "if runtime_is_ready; then",
    // Promote a recognized legacy marker once. Warm launches read only GOAT.
    `  if [ "$ready_marker" != "$runtime_root/${WSL_RUNTIME_READY_MARKER}" ]; then`,
    `    cp "$ready_marker" "$runtime_root/${WSL_RUNTIME_READY_MARKER}.tmp" && mv -f "$runtime_root/${WSL_RUNTIME_READY_MARKER}.tmp" "$runtime_root/${WSL_RUNTIME_READY_MARKER}"`,
    "  fi",
    `  touch "$runtime_root/${WSL_RUNTIME_SELECTED_MARKER}"`,
    `  printf 'runtimeRoot:%s\\n' "$runtime_root"`,
    "  exit 0",
    "fi",
  ];
  if (linuxArchivePath === null) {
    return [
      ...readyCheck,
      `archive_stage=$(mktemp -d "$runtime_parent/.${safeRuntimeId}.tmp.XXXXXX")`,
      `printf 'archiveStage:%s\\n' "$archive_stage"`,
    ].join("\n");
  }
  return [
    ...readyCheck,
    `ready_marker="$runtime_root/${WSL_RUNTIME_READY_MARKER}"`,
    `archive_sha=$(sha256sum ${shellQuote(linuxArchivePath)} | cut -d ' ' -f 1)`,
    `if [ "$archive_sha" != ${shellQuote(archiveSha256)} ]; then`,
    `  printf 'WSL runtime archive does not match its recorded SHA-256 (expected %s, got %s)\\n' ${shellQuote(archiveSha256)} "$archive_sha" >&2`,
    "  exit 1",
    "fi",
    // Deletion can remove a live backend's lazy imports; check cmdline before rename preserves its old path.
    "runtime_in_use() {",
    // Without /proc, assume the runtime may still be in use.
    "  [ -d /proc/1 ] || return 0",
    '  grep -qF -- "$1/" /proc/[0-9]*/cmdline 2>/dev/null',
    "}",
    'if [ -e "$runtime_root" ]; then',
    '  if runtime_in_use "$runtime_root"; then',
    "    runtime_root_in_use=1",
    "  else",
    "    runtime_root_in_use=0",
    "  fi",
    `  runtime_stale=$(mktemp -d "$runtime_parent/.${safeRuntimeId}.stale.XXXXXX")`,
    '  rmdir "$runtime_stale"',
    '  if mv -T "$runtime_root" "$runtime_stale" 2>/dev/null; then',
    '    if [ "$runtime_root_in_use" = 1 ]; then',
    // Renaming keeps the directory's old mtime, so restart the cleanup clock.
    '      touch "$runtime_stale"',
    "    else",
    '      rm -rf "$runtime_stale"',
    "    fi",
    "  fi",
    "fi",
    `runtime_tmp=$(mktemp -d "$runtime_parent/.${safeRuntimeId}.tmp.XXXXXX")`,
    'cleanup_runtime_install() { rm -rf "$runtime_tmp"; }',
    "trap cleanup_runtime_install EXIT",
    `tar -xzf ${shellQuote(linuxArchivePath)} -C "$runtime_tmp" --strip-components=1`,
    'if ! runtime_entry_runs "$runtime_tmp"; then',
    "  printf 'WSL runtime archive does not contain a working goat executable\\n' >&2",
    "  exit 1",
    "fi",
    'installed_entry_digest=$(runtime_server_entry_digest "$runtime_tmp")',
    'if [ -z "$installed_entry_digest" ]; then',
    "  printf 'Could not hash the WSL runtime server entry\\n' >&2",
    "  exit 1",
    "fi",
    `printf '%s\\n' "$installed_entry_digest" > "$runtime_tmp/${WSL_RUNTIME_READY_MARKER}"`,
    'if mv -T "$runtime_tmp" "$runtime_root" 2>/dev/null; then',
    "  :",
    "elif runtime_is_ready; then",
    '  rm -rf "$runtime_tmp"',
    "else",
    `  printf 'Could not promote WSL runtime cache at %s\\n' "$runtime_root" >&2`,
    "  exit 1",
    "fi",
    `touch "$runtime_root/${WSL_RUNTIME_SELECTED_MARKER}"`,
    `printf 'runtimeRoot:%s\\n' "$runtime_root"`,
  ].join("\n");
};

// Two hours exceeds cold-install time while bounding orphan retention.
const ORPHANED_RUNTIME_SCRATCH_MAX_AGE_MINUTES = 120;

export const buildWslRuntimePruneScript = (runtimeId: string): string => {
  const safeRuntimeId = sanitizeWslRuntimeId(runtimeId);
  return [
    "set -eu",
    ...buildWslRuntimeParentScript(safeRuntimeId),
    `current_runtime="$runtime_parent/${safeRuntimeId}"`,
    '[ -d "$runtime_parent" ] || exit 0',
    // Serialize pruning so backends cannot select and delete different previous caches.
    'prune_lock="$runtime_parent/.prune.lock"',
    'exec 8> "$prune_lock"',
    "flock -x 8",
    // Without /proc, retention cannot distinguish caches used by live backends.
    "[ -d /proc/1 ] || exit 0",
    "runtime_in_use() {",
    '  grep -qF -- "$1/" /proc/[0-9]*/cmdline 2>/dev/null',
    "}",
    'previous_runtime=""',
    'for candidate in "$runtime_parent"/sha256-*; do',
    '  [ -d "$candidate" ] || continue',
    '  [ "$candidate" != "$current_runtime" ] || continue',
    `  [ -f "$candidate/${WSL_RUNTIME_READY_MARKER}" ] || [ -f "$candidate/${LEGACY_WSL_RUNTIME_READY_MARKER}" ] || continue`,
    '  if [ -z "$previous_runtime" ] || [ "$candidate" -nt "$previous_runtime" ]; then',
    '    previous_runtime="$candidate"',
    "  fi",
    "done",
    'for candidate in "$runtime_parent"/sha256-*; do',
    '  [ -d "$candidate" ] || continue',
    '  [ "$candidate" != "$current_runtime" ] || continue',
    '  [ "$candidate" != "$previous_runtime" ] || continue',
    '  ! runtime_in_use "$candidate" || continue',
    "  candidate_name=${candidate##*/}",
    '  candidate_lock="$runtime_parent/.${candidate_name}.install.lock"',
    '  exec 9> "$candidate_lock"',
    "  flock -n 9 || continue",
    `  selected_marker="$candidate/${WSL_RUNTIME_SELECTED_MARKER}"`,
    `  if [ "$candidate/${LEGACY_WSL_RUNTIME_SELECTED_MARKER}" -nt "$selected_marker" ]; then selected_marker="$candidate/${LEGACY_WSL_RUNTIME_SELECTED_MARKER}"; fi`,
    `  if [ -f "$selected_marker" ] && find "$selected_marker" -maxdepth 0 -mmin -${String(WSL_RUNTIME_SELECTION_GRACE_MINUTES)} -print -quit | grep -q .; then`,
    "    flock -u 9",
    "    continue",
    "  fi",
    '  rm -rf -- "$candidate"',
    "  flock -u 9",
    "done",
    'for scratch in "$runtime_parent"/.*.tmp.* "$runtime_parent"/.*.stale.*; do',
    '  [ -d "$scratch" ] || continue',
    `  find "$scratch" -maxdepth 0 -mmin +${String(ORPHANED_RUNTIME_SCRATCH_MAX_AGE_MINUTES)} -print -quit | grep -q . || continue`,
    '  rm -rf -- "$scratch"',
    "done",
  ].join("\n");
};

// Invalidate trees that pass install checks but fail launch probes, or each launch reuses the broken cache.
export const buildWslRuntimeInvalidateScript = (runtimeId: string): string => {
  const safeRuntimeId = sanitizeWslRuntimeId(runtimeId);
  return [
    "set -eu",
    ...buildWslRuntimeParentScript(safeRuntimeId),
    `runtime_root="$runtime_parent/${safeRuntimeId}"`,
    `rm -f "$runtime_root/${WSL_RUNTIME_READY_MARKER}" "$runtime_root/${LEGACY_WSL_RUNTIME_READY_MARKER}"`,
  ].join("\n");
};

export const parseAbsolutePathField = (stdout: string, field: string): string | null => {
  const prefix = `${field}:`;
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) return null;
  const value = line.slice(prefix.length).replace(/\r$/, "");
  return value.startsWith("/") ? value : null;
};

export const parseWslRuntimeRoot = (stdout: string): string | null =>
  parseAbsolutePathField(stdout, "runtimeRoot");
