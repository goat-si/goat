// @effect-diagnostics nodeBuiltinImport:off -- Compiles and runs the helper's Swift checks with the host toolchain.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@goat/shared/HostProcess";

export const helperDir = NodePath.join(import.meta.dirname, "../../native/computer-use-helper");

/** The helper is macOS-only and its checks need the host's Swift toolchain. */
export const macWithSwift =
  HostProcess.Platform.defaultValue() === "darwin" &&
  NodeChildProcess.spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" }).status === 0;

/**
 * Compiles helper sources with one check program from `tests/` and runs it. The program prints a
 * line per check and exits non-zero when any fails.
 */
export function runSwiftChecks(sources: ReadonlyArray<string>, checks: string) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-helper-checks-"));
  try {
    const binary = NodePath.join(dir, "checks");
    const build = NodeChildProcess.spawnSync(
      "xcrun",
      [
        "swiftc",
        "-parse-as-library",
        "-o",
        binary,
        ...sources.map((source) => NodePath.join(helperDir, source)),
        NodePath.join(helperDir, "tests", checks),
      ],
      { encoding: "utf8" },
    );
    if (build.status !== 0) return { ok: false, output: build.stderr };
    // A host that quarantines files its processes create (some agent sandboxes do) would have
    // Gatekeeper kill the fresh binary at exec; it is ours, so drop the mark first.
    NodeChildProcess.spawnSync("xattr", ["-d", "com.apple.quarantine", binary]);
    const result = NodeChildProcess.spawnSync(binary, { encoding: "utf8" });
    return { ok: result.status === 0, output: result.stdout + result.stderr };
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}
