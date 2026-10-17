// @effect-diagnostics nodeBuiltinImport:off - Build configs read the commit time from git before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";

/**
 * Unix seconds of the commit a build comes from, as a string for a bundler `define`.
 * SSH runtime refresh orders builds whose versions cannot be ordered, such as two
 * `0.1.0-dev.<sha>` builds, by this stamp (see `compareRuntimeBuilds`). The server and the
 * desktop main bundle must stamp the same value, because the desktop asks a remote host for
 * the server archive packaged beside it. A build outside a git checkout can pass the value
 * in GOAT_BUILD_COMMIT_TIME; without either the build is unstamped ("").
 */
export const resolveBuildCommitTime = (cwd: string): string => {
  const explicit = process.env.GOAT_BUILD_COMMIT_TIME?.trim();
  if (explicit) return explicit;
  try {
    return NodeChildProcess.execFileSync("git", ["log", "-1", "--format=%ct", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};
