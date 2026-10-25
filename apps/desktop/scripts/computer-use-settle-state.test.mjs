import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// oxlint-disable-next-line goat/no-global-process-runtime -- The reducer fixture needs a macOS Swift toolchain.
const platform = process.platform;
const source = NodeURL.fileURLToPath(new URL("../native/computer-use-helper/", import.meta.url));

// quarantine: #1506 The pure reducer compiles with swiftc, which Linux and Windows runners lack.
describe.skipIf(platform !== "darwin")(
  "production window-settle reducer with a manual clock",
  () => {
    let directory;
    let executable;

    beforeAll(() => {
      directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-settle-state-"));
      executable = NodePath.join(directory, "settle-state");
      NodeChildProcess.execFileSync("swiftc", [
        "-warnings-as-errors",
        "-o",
        executable,
        NodePath.join(source, "WindowSettle.swift"),
        NodePath.join(source, "fixtures/WindowSettleFixture.swift"),
      ]);
    });

    afterAll(() => {
      if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
    });

    it.each([
      ["freshness", "settles only from a fresh sample started after subscription and quiet"],
      ["dirty-final", "waits for a fresh quiet interval after a change during the final read"],
      [
        "attribution",
        "holds a final sample while a received notification is unattributed, then releases or discards it",
      ],
      ["deadline", "bounds setup and in-flight reads without returning a stale baseline"],
      ["budget", "does not dispatch with less than 100ms or report pending early"],
      [
        "failures",
        "distinguishes baseline errors, final errors, degraded coverage and missing windows",
      ],
      ["destruction", "returns no reused snapshot after exact destruction"],
      ["cancellation", "cancels observation, timers and reads before any terminal output"],
      ["invalidations", "preserves opaque samples and aggregates withheld invalidations"],
    ])("%s: %s", (scenario) => {
      const output = NodeChildProcess.execFileSync(executable, [scenario], { encoding: "utf8" });
      expect(output.trim()).toBe(`PASS ${scenario}`);
    });
  },
);
