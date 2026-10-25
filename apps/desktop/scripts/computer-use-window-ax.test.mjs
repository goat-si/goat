import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// oxlint-disable-next-line goat/no-global-process-runtime -- These fixtures compile the macOS adapter.
const platform = process.platform;
const source = NodeURL.fileURLToPath(new URL("../native/computer-use-helper/", import.meta.url));

describe.skipIf(platform !== "darwin")("window observer with injected accessibility APIs", () => {
  let directory;
  let executable;

  beforeAll(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-window-ax-"));
    executable = NodePath.join(directory, "window-ax-fixture");
    const compiled = NodeChildProcess.spawnSync(
      "swiftc",
      [
        "-parse-as-library",
        NodePath.join(source, "NativeManifest.swift"),
        NodePath.join(source, "WindowAXObserver.swift"),
        NodePath.join(source, "fixtures/WindowAXFixture.swift"),
        "-o",
        executable,
      ],
      { encoding: "utf8" },
    );
    expect(compiled.stderr).toBe("");
    expect(compiled.status).toBe(0);
  });

  afterAll(() => {
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    "manifest",
    "filter",
    "attribution",
    "destruction",
    "coverage",
    "privacy",
    "no-focus",
    "calculator",
    "sample-gate",
    "admission",
    "lifetime",
  ])("enforces %s through production modules without OS accessibility calls", (scenario) => {
    const result = NodeChildProcess.spawnSync(executable, [scenario], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`PASS ${scenario}\n`);
  });
});
