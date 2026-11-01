// The remote shell is the behavior under test, so run it against a real filesystem.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { buildRemoteBrowseScript, parseRemoteBrowseOutput } from "./remoteBrowse.ts";

describe("remote folder browsing over POSIX sh", () => {
  let home: string;
  let repo: string;
  let worktree: string;
  let head: string;
  const quotedName = "owner's folder'; touch INJECTED; #";

  const environment = () => ({ HOME: home, PATH: process.env.PATH, LC_ALL: "C" });
  const git = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...args],
      {
        cwd,
        env: { ...environment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();

  const browse = (path: string | null, showHidden = false, maxEntries = 100) =>
    parseRemoteBrowseOutput(
      NodeChildProcess.execFileSync("/bin/sh", [], {
        input: buildRemoteBrowseScript({ path, showHidden, maxEntries }),
        cwd: home,
        env: environment(),
        encoding: "utf8",
        timeout: 10_000,
      }),
    );

  const listing = (path: string | null, showHidden = false, maxEntries = 100) => {
    const result = browse(path, showHidden, maxEntries);
    if (result?._tag !== "Listing") throw new Error(`Expected a listing for ${path}`);
    return result;
  };

  beforeAll(() => {
    // Canonicalize macOS's /var -> /private/var alias before making path assertions.
    home = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-browse-")),
    );
    repo = NodePath.join(home, "repo");
    worktree = NodePath.join(home, "linked worktree");
    for (const name of ["repo", "plain", "folder with spaces", ".hidden", "..hidden", quotedName]) {
      NodeFS.mkdirSync(NodePath.join(home, name));
    }
    NodeFS.mkdirSync(NodePath.join(repo, "sub"));
    NodeFS.writeFileSync(NodePath.join(repo, "tracked.txt"), "one commit\n");
    git(repo, "init", "-b", "main");
    git(repo, "add", "tracked.txt");
    git(
      repo,
      "-c",
      "user.name=Browse Test",
      "-c",
      "user.email=browse@example.invalid",
      "commit",
      "-m",
      "initial",
    );
    head = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "add", "-b", "feature/browse", worktree);
    NodeFS.symlinkSync(repo, NodePath.join(home, "repo-link"), "dir");
    NodeFS.symlinkSync(NodePath.join(home, "plain"), NodePath.join(home, "plain-link"), "dir");
    NodeFS.symlinkSync(
      NodePath.join(home, "missing-target"),
      NodePath.join(home, "broken-link"),
      "dir",
    );
    NodeFS.writeFileSync(NodePath.join(home, "regular-file"), "exclude me\n");
    NodeFS.symlinkSync(
      NodePath.join(home, "regular-file"),
      NodePath.join(home, "file-link"),
      "file",
    );
    NodeFS.mkdirSync(NodePath.join(home, "tab\tname"));
    NodeFS.mkdirSync(NodePath.join(home, "line\nname"));
  });

  afterAll(() => {
    if (home !== undefined) NodeFS.rmSync(home, { recursive: true, force: true });
  });

  it("lists directories and directory symlinks with their Git status and full paths", () => {
    const result = listing(home);
    expect(result.path).toBe(home);
    expect(result.realPath).toBe(home);
    expect(result.home).toBe(home);
    expect(result.entries).toEqual(
      [
        { name: "repo", kind: "directory", isGitRepository: true },
        { name: "linked worktree", kind: "directory", isGitRepository: true },
        { name: "plain", kind: "directory", isGitRepository: false },
        { name: "folder with spaces", kind: "directory", isGitRepository: false },
        { name: quotedName, kind: "directory", isGitRepository: false },
        { name: "repo-link", kind: "symlink", isGitRepository: true },
        { name: "plain-link", kind: "symlink", isGitRepository: false },
      ]
        .map((entry) => ({ ...entry, path: NodePath.join(home, entry.name) }))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    );
    expect(result.truncated).toBe(false);
  });

  it("includes hidden directories only when requested", () => {
    expect(listing(home).entries.map((entry) => entry.name)).not.toContain(".hidden");
    const shown = listing(home, true).entries.map((entry) => entry.name);
    expect(shown).toContain(".hidden");
    expect(shown).toContain("..hidden");
    expect(shown).not.toContain(".");
    expect(shown).not.toContain("..");
  });

  it("preserves the symlink path while reporting the real Git root and all worktrees", () => {
    const path = NodePath.join(home, "repo-link");
    const result = listing(path);
    expect(result.path).toBe(path);
    expect(result.realPath).toBe(repo);
    expect(result.gitRoot).toBe(repo);
    expect(result.branch).toBe("main");
    expect(result.worktrees).toEqual([
      { path: repo, branch: "main", head, bare: false, detached: false },
      { path: worktree, branch: "feature/browse", head, bare: false, detached: false },
    ]);
  });

  it("reports the linked worktree's own branch and root", () => {
    const result = listing(worktree);
    expect(result.path).toBe(worktree);
    expect(result.realPath).toBe(worktree);
    expect(result.gitRoot).toBe(worktree);
    expect(result.branch).toBe("feature/browse");
    expect(result.worktrees.map(({ path, branch }) => ({ path, branch }))).toEqual([
      { path: repo, branch: "main" },
      { path: worktree, branch: "feature/browse" },
    ]);
  });

  it("finds the Git root when browsing a repository subdirectory", () => {
    const result = listing(NodePath.join(repo, "sub"));
    expect(result.gitRoot).toBe(repo);
    expect(result.branch).toBe("main");
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("returns no Git metadata for a plain folder", () => {
    const result = listing(NodePath.join(home, "plain"));
    expect(result.gitRoot).toBeNull();
    expect(result.branch).toBeNull();
    expect(result.worktrees).toEqual([]);
  });

  it.each([null, "~", "~/folder with spaces"])("expands %s against the remote HOME", (path) => {
    const expected =
      path === "~/folder with spaces" ? NodePath.join(home, "folder with spaces") : home;
    const result = listing(path);
    expect(result.path).toBe(expected);
    expect(result.realPath).toBe(expected);
  });

  it.each([0, 2])("bounds the listing to %s directories and reports truncation", (maxEntries) => {
    const result = listing(home, false, maxEntries);
    expect(result.entries).toHaveLength(maxEntries);
    expect(result.truncated).toBe(true);
  });

  it("does not report truncation when the limit exactly fits the directory count", () => {
    const count = listing(home).entries.length;
    const result = listing(home, false, count);
    expect(result.entries).toHaveLength(count);
    expect(result.truncated).toBe(false);
  });

  it.each(["missing", "regular-file"])("returns NotADirectory for %s", (name) => {
    const path = NodePath.join(home, name);
    expect(browse(path)).toEqual({ _tag: "NotADirectory", home, path });
  });

  it("treats single quotes and shell syntax in a requested path as literal filename characters", () => {
    const path = NodePath.join(home, quotedName);
    const result = listing(path);
    expect(result.path).toBe(path);
    expect(result.realPath).toBe(path);
    expect(NodeFS.existsSync(NodePath.join(home, "INJECTED"))).toBe(false);
  });

  it.each(["dollars$&", "dollars$$", "dollars$`", "dollars$'"])(
    "keeps replacement patterns in a requested path literal (%s)",
    (name) => {
      const path = NodePath.join(home, name);
      expect(browse(path)).toEqual({ _tag: "NotADirectory", home, path });
    },
  );
});

describe("remote folder browsing on a Windows shell", () => {
  let home: string;
  let shims: string;

  beforeAll(() => {
    home = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-browse-win-")),
    );
    shims = NodePath.join(home, ".shims");
    NodeFS.mkdirSync(NodePath.join(home, "Developer", "goat", "apps"), { recursive: true });
    NodeFS.mkdirSync(shims);
    // Stand-ins for Git Bash's uname and cygpath: HOME is the user's folder on C:.
    NodeFS.writeFileSync(NodePath.join(shims, "uname"), "#!/bin/sh\necho MINGW64_NT-10.0-26200\n", {
      mode: 0o755,
    });
    NodeFS.writeFileSync(
      NodePath.join(shims, "cygpath"),
      `#!/bin/sh\n[ "$1" = -w ] && shift\nprintf '%s\\n' "$1" | sed "s|^${home}|C:/Users/super|" | tr / '\\\\'\n`,
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    if (home !== undefined) NodeFS.rmSync(home, { recursive: true, force: true });
  });

  it("reports the native Windows form of every folder path", () => {
    const result = parseRemoteBrowseOutput(
      NodeChildProcess.execFileSync("/bin/sh", [], {
        input: buildRemoteBrowseScript({
          path: "~/Developer/goat",
          showHidden: false,
          maxEntries: 10,
        }),
        cwd: home,
        env: { HOME: home, PATH: `${shims}:${process.env.PATH}`, LC_ALL: "C" },
        encoding: "utf8",
        timeout: 10_000,
      }),
    );
    expect(result).toMatchObject({
      _tag: "Listing",
      os: "MINGW64_NT-10.0-26200",
      home: "C:\\Users\\super",
      path: "C:\\Users\\super\\Developer\\goat",
      realPath: "C:\\Users\\super\\Developer\\goat",
      entries: [{ name: "apps", path: "C:\\Users\\super\\Developer\\goat\\apps" }],
    });
  });

  it("maps drive mounts itself when the host has no cygpath", () => {
    const result = parseRemoteBrowseOutput(
      [
        "T3B\t1",
        "HOME\t/c/Users/super",
        "OS\tMINGW64_NT-10.0-26200",
        "PATH\t/c/Users/super/Developer/goat",
        "REAL\t/c/Users/super/Developer/goat",
        "GITROOT\tC:/Users/super/Developer/goat",
        "BRANCH\tdev",
        "WT\tworktree C:/Users/super/Developer/goat",
        "WT\tbranch refs/heads/dev",
        "E\tD\t1\tapps",
      ].join("\n"),
    );
    expect(result).toMatchObject({
      home: "C:\\Users\\super",
      path: "C:\\Users\\super\\Developer\\goat",
      realPath: "C:\\Users\\super\\Developer\\goat",
      gitRoot: "C:\\Users\\super\\Developer\\goat",
      worktrees: [{ path: "C:\\Users\\super\\Developer\\goat", branch: "dev" }],
      entries: [{ name: "apps", path: "C:\\Users\\super\\Developer\\goat\\apps" }],
    });
  });

  it("leaves POSIX hosts' paths alone, even ones shaped like a drive mount", () => {
    const result = parseRemoteBrowseOutput(
      ["T3B\t1", "HOME\t/home/x", "OS\tLinux", "PATH\t/c/data", "REAL\t/c/data"].join("\n"),
    );
    expect(result).toMatchObject({ home: "/home/x", path: "/c/data", realPath: "/c/data" });
  });
});
