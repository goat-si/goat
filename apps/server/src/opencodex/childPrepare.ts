const STABLE_VERSION = /^\d+\.\d+\.\d+$/u;
/** Remote Link's floor for a Child. */
export const CHILD_MINIMUM_VERSION = "2.66.0";
const PACKAGE = "@bitkyc08/opencodex";

/** `prepareDevice` exit codes; 0 means a supported OpenCodex answers healthy there. */
export const PREPARE_EXIT = {
  npmMissing: 10,
  installFailed: 11,
  ocxUnusable: 12,
  runtimeUnhealthy: 13,
} as const;

/** Where ocx may live, as shell words. Tests pass one under a temporary home. */
export interface OcxLayout {
  readonly candidates: ReadonlyArray<string>;
  readonly searchPath: string;
}

/** OpenCodex's remoteOcxArgv order: Desktop and system installs before PATH shims. */
const HOST_OCX_LAYOUT: OcxLayout = {
  candidates: [
    '"$HOME/.opencodex-desktop/bin/ocx"',
    "/Applications/OpenCodex.app/Contents/MacOS/ocx",
    "/usr/bin/ocx",
    '"/c/Program Files/OpenCodex/ocx"',
  ],
  searchPath: "$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin",
};

export const resolveOcx = (layout: OcxLayout = HOST_OCX_LAYOUT) => [
  "goat_ocx=",
  `for goat_candidate in ${layout.candidates.join(" ")}; do`,
  '  if [ -x "$goat_candidate" ]; then goat_ocx=$goat_candidate; break; fi',
  "done",
  'if [ -z "$goat_ocx" ]; then',
  `  PATH="$PATH:${layout.searchPath}"`,
  "  goat_ocx=$(command -v ocx 2>/dev/null) || goat_ocx=",
  "fi",
];

/**
 * Idempotent: a supported install that answers healthy is left alone. A user-prefix npm install
 * needs no sudo and lands in ~/.local/bin, which both GOAT and OpenCodex's link probe search.
 * `ocx service` installs a supervised background service; a host without a usable service
 * manager (a container without systemd) gets a detached `ocx start` instead.
 */
export const prepareScript = (version: string, layout: OcxLayout = HOST_OCX_LAYOUT) => {
  if (!STABLE_VERSION.test(version)) throw new TypeError("Unsafe OpenCodex version.");
  const exit = (code: number) => `printf '\\n__goat_ocx_exit=${code}\\n'; exit 0`;
  return [
    ...resolveOcx(layout),
    "goat_version() {",
    '  [ -n "$goat_ocx" ] || return 1',
    "  \"$goat_ocx\" --version </dev/null 2>/dev/null | sed -n 's/^[^0-9]*\\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\).*/\\1/p' | head -n 1",
    "}",
    "goat_supported() {",
    `  [ -n "$1" ] && [ "$(printf '%s\\n%s\\n' '${CHILD_MINIMUM_VERSION}' "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = '${CHILD_MINIMUM_VERSION}' ]`,
    "}",
    "goat_have=$(goat_version)",
    'if ! goat_supported "$goat_have"; then',
    `  command -v npm >/dev/null 2>&1 || { ${exit(PREPARE_EXIT.npmMissing)}; }`,
    `  npm install -g --prefix "$HOME/.local" '${PACKAGE}@${version}' </dev/null >/dev/null 2>&1 || { ${exit(PREPARE_EXIT.installFailed)}; }`,
    // Re-resolve in the same order: an older ocx earlier in that order would still win.
    ...resolveOcx(layout).map((line) => `  ${line}`),
    "  goat_have=$(goat_version)",
    `  goat_supported "$goat_have" || { ${exit(PREPARE_EXIT.ocxUnusable)}; }`,
    "fi",
    "goat_healthy() {",
    "  goat_try=0",
    '  while [ "$goat_try" -lt 20 ]; do',
    '    "$goat_ocx" health </dev/null >/dev/null 2>&1 && return 0',
    "    goat_try=$((goat_try + 1)); sleep 1",
    "  done",
    "  return 1",
    "}",
    'if ! "$goat_ocx" health </dev/null >/dev/null 2>&1; then',
    '  "$goat_ocx" service </dev/null >/dev/null 2>&1',
    "  if ! goat_healthy; then",
    '    goat_home="${OPENCODEX_HOME:-$HOME/.opencodex}"',
    '    mkdir -p "$goat_home"',
    '    nohup "$goat_ocx" start </dev/null >>"$goat_home/goat-start.log" 2>&1 &',
    `    goat_healthy || { ${exit(PREPARE_EXIT.runtimeUnhealthy)}; }`,
    "  fi",
    "fi",
    "printf '%s\\n__goat_ocx_exit=0\\n' \"$goat_have\"",
    "",
  ].join("\n");
};
