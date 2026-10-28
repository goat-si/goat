export { CHILD_MINIMUM_VERSION } from "@goat/shared/opencodexRelease";

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

/** Quotes the provisioned GOAT executable as shell data; only an absolute, one-line path. */
export const quoteGoatExecutable = (value: string): string => {
  if (!value.startsWith("/") || /[\0\r\n]/u.test(value))
    throw new TypeError("Unsafe provisioned GOAT executable path.");
  return `'${value.replaceAll("'", "'\\''")}'`;
};

/** An older GOAT reads `opencodex` as a folder to serve, so its help must name the command. */
export const GOAT_INSTALLS_OPENCODEX =
  '"$goat_cli" opencodex install --help </dev/null 2>/dev/null | grep -q "goat opencodex install"';
