/**
 * The remote half of SSH folder browsing: a POSIX sh script that needs no GOAT
 * on the remote, and the parser for its line-oriented output. Each line is a
 * tab-separated record so names never need quoting; names holding a tab or a
 * newline are skipped rather than misread.
 *
 * On a Windows host (Git Bash, MSYS2, Cygwin) the shell reports `/c/…` paths while the GOAT
 * server there is native, so the parsed listing carries the native `C:\…` form: the host's
 * `cygpath -w` when it has one, which knows its mount table, else the drive-mount mapping.
 */

import { isWindowsShellOs, toWindowsHostPath } from "@goat/shared/path";

export interface RemoteWorktree {
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
}

export interface RemoteDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "symlink";
  readonly isGitRepository: boolean;
}

export type RemoteBrowseOutput =
  | {
      readonly _tag: "Listing";
      readonly home: string | null;
      readonly os: string | null;
      /** The directory as reached (symlinks kept), which is what a project records. */
      readonly path: string;
      /** The same directory with symlinks resolved. */
      readonly realPath: string;
      readonly gitRoot: string | null;
      readonly branch: string | null;
      readonly worktrees: ReadonlyArray<RemoteWorktree>;
      readonly entries: ReadonlyArray<RemoteDirectoryEntry>;
      readonly truncated: boolean;
    }
  | { readonly _tag: "NotADirectory"; readonly home: string | null; readonly path: string };

const BROWSE_SCRIPT = String.raw`set -u
NL='
'
TAB="$(printf '\t')"
REQ=@@GOAT_PATH@@
case "$REQ" in
  ""|"~") REQ="$HOME" ;;
  "~/"*) REQ="$HOME/$(printf '%s' "$REQ" | cut -c3-)" ;;
esac
printf 'T3B\t1\n'
printf 'HOME\t%s\n' "$HOME"
printf 'OS\t%s\n' "$(uname -s 2>/dev/null || true)"
if ! cd -- "$REQ" 2>/dev/null; then
  printf 'ERR\tnot_a_directory\t%s\n' "$REQ"
  exit 0
fi
printf 'PATH\t%s\n' "$(pwd -L)"
printf 'REAL\t%s\n' "$(pwd -P)"
WIN=0
case "$(uname -s 2>/dev/null)" in
  MINGW* | MSYS* | CYGWIN*) command -v cygpath >/dev/null 2>&1 && WIN=1 ;;
esac
if [ "$WIN" = 1 ]; then
  printf 'WHOME\t%s\n' "$(cygpath -w "$HOME" 2>/dev/null)"
  printf 'WPATH\t%s\n' "$(cygpath -w "$(pwd -L)" 2>/dev/null)"
  printf 'WREAL\t%s\n' "$(cygpath -w "$(pwd -P)" 2>/dev/null)"
fi
if command -v git >/dev/null 2>&1 && TOP="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  printf 'GITROOT\t%s\n' "$TOP"
  # Git for Windows already prints C:/…; a Cygwin git prints a shell path.
  case "$WIN$TOP" in
    1/*) printf 'WGITROOT\t%s\n' "$(cygpath -w "$TOP" 2>/dev/null)" ;;
  esac
  printf 'BRANCH\t%s\n' "$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  git worktree list --porcelain 2>/dev/null | while IFS= read -r LINE; do
    printf 'WT\t%s\n' "$LINE"
  done
fi
COUNT=0
for E in * @@GOAT_HIDDEN_GLOBS@@; do
  case "$E" in
    *"$NL"*|*"$TAB"*|.|..) continue ;;
  esac
  [ -d "$E" ] || continue
  COUNT=$((COUNT + 1))
  if [ "$COUNT" -gt @@GOAT_MAX_ENTRIES@@ ]; then
    printf 'MORE\n'
    break
  fi
  KIND=D
  [ -L "$E" ] && KIND=L
  GIT=0
  [ -e "$E/.git" ] && GIT=1
  printf 'E\t%s\t%s\t%s\n' "$KIND" "$GIT" "$E"
done
`;

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildRemoteBrowseScript(input: {
  readonly path: string | null;
  readonly showHidden: boolean;
  readonly maxEntries: number;
}): string {
  // Replacer functions keep "$&", "$$" and friends in a path literal.
  const quotedPath = shellSingleQuote(input.path?.trim() ?? "");
  const hiddenGlobs = input.showHidden ? ".[!.]* ..?*" : "";
  const maxEntries = String(Math.max(0, Math.floor(input.maxEntries)));
  return BROWSE_SCRIPT.replaceAll("@@GOAT_PATH@@", () => quotedPath)
    .replaceAll("@@GOAT_HIDDEN_GLOBS@@", () => hiddenGlobs)
    .replaceAll("@@GOAT_MAX_ENTRIES@@", () => maxEntries);
}

const joinRemotePath = (directory: string, name: string, separator: "/" | "\\") =>
  directory.endsWith(separator) ? directory + name : directory + separator + name;

function parseWorktrees(lines: ReadonlyArray<string>): RemoteWorktree[] {
  const worktrees: RemoteWorktree[] = [];
  let current: {
    path: string;
    branch: string | null;
    head: string | null;
    bare: boolean;
    detached: boolean;
  } | null = null;
  const flush = () => {
    if (current !== null) worktrees.push(current);
    current = null;
  };
  for (const line of lines) {
    if (line.length === 0) {
      flush();
      continue;
    }
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    if (key === "worktree") {
      flush();
      current = { path: value, branch: null, head: null, bare: false, detached: false };
    } else if (current !== null) {
      if (key === "HEAD") current.head = value;
      else if (key === "branch") current.branch = value.replace(/^refs\/heads\//u, "");
      else if (key === "bare") current.bare = true;
      else if (key === "detached") current.detached = true;
    }
  }
  flush();
  return worktrees;
}

export function parseRemoteBrowseOutput(stdout: string): RemoteBrowseOutput | null {
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/u, ""));
  if (!lines.includes("T3B\t1")) return null;
  let home: string | null = null;
  let os: string | null = null;
  let path: string | null = null;
  let realPath: string | null = null;
  let gitRoot: string | null = null;
  let branch: string | null = null;
  let truncated = false;
  const native: { home?: string; path?: string; realPath?: string; gitRoot?: string } = {};
  const worktreeLines: string[] = [];
  const entryLines: Array<{ readonly kind: string; readonly git: string; readonly name: string }> =
    [];
  for (const line of lines) {
    const tab = line.indexOf("\t");
    const tag = tab < 0 ? line : line.slice(0, tab);
    const rest = tab < 0 ? "" : line.slice(tab + 1);
    switch (tag) {
      case "HOME":
        home = rest || null;
        break;
      case "OS":
        os = rest || null;
        break;
      case "ERR": {
        const [, requested = ""] = rest.split("\t");
        return { _tag: "NotADirectory", home, path: requested };
      }
      case "PATH":
        path = rest;
        break;
      case "REAL":
        realPath = rest;
        break;
      case "GITROOT":
        gitRoot = rest || null;
        break;
      case "WHOME":
        if (rest) native.home = rest;
        break;
      case "WPATH":
        if (rest) native.path = rest;
        break;
      case "WREAL":
        if (rest) native.realPath = rest;
        break;
      case "WGITROOT":
        if (rest) native.gitRoot = rest;
        break;
      case "BRANCH":
        branch = rest || null;
        break;
      case "WT":
        worktreeLines.push(rest);
        break;
      case "MORE":
        truncated = true;
        break;
      case "E": {
        const [kind, git, ...nameParts] = rest.split("\t");
        const name = nameParts.join("\t");
        if (path === null || name.length === 0) break;
        entryLines.push({ kind: kind ?? "", git: git ?? "", name });
        break;
      }
    }
  }
  if (path === null) return null;
  const windows = isWindowsShellOs(os);
  const host = (shell: string, cygpath: string | undefined) =>
    windows ? toWindowsHostPath(cygpath ?? shell) : shell;
  const listed = host(path, native.path);
  const entries = entryLines.map(({ kind, git, name }): RemoteDirectoryEntry => ({
    name,
    path: joinRemotePath(listed, name, windows ? "\\" : "/"),
    kind: kind === "L" ? "symlink" : "directory",
    isGitRepository: git === "1",
  }));
  const worktrees = parseWorktrees(worktreeLines);
  return {
    _tag: "Listing",
    home: home === null ? null : host(home, native.home),
    os,
    path: listed,
    realPath: realPath === null ? listed : host(realPath, native.realPath),
    gitRoot: gitRoot === null ? null : host(gitRoot, native.gitRoot),
    branch,
    worktrees: windows
      ? worktrees.map((worktree) => ({ ...worktree, path: toWindowsHostPath(worktree.path) }))
      : worktrees,
    entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
    truncated,
  };
}
