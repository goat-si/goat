// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

/**
 * Point the process temp directory at the path git and `realpath` report.
 *
 * GitHub's Windows runners hand out the temp directory by its 8.3 short name
 * (`C:\Users\RUNNER~1\...`). macOS hands out `/var/folders/...`, which is a
 * symlink to `/private/var/folders/...`. Equality checks between a temp path
 * and its canonical form fail on either host. Node reads `TEMP`/`TMP` on
 * Windows and `TMPDIR` on POSIX for every `os.tmpdir()` call.
 */
export const canonicalizeProcessTempDir = (): void => {
  let canonical: string;
  try {
    canonical = NodeFS.realpathSync.native(NodeOS.tmpdir());
  } catch {
    // Leave the host's value alone if it cannot be resolved.
    return;
  }
  // oxlint-disable-next-line goat/no-global-process-runtime -- Every test config loads this setup, and HostProcess imports node:sea, which mobile tests cannot bundle.
  if (NodeOS.platform() === "win32") {
    process.env.TEMP = canonical;
    process.env.TMP = canonical;
    return;
  }
  if (canonical !== NodeOS.tmpdir()) {
    process.env.TMPDIR = canonical;
  }
};

canonicalizeProcessTempDir();
