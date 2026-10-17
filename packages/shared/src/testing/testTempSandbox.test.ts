// @effect-diagnostics nodeBuiltinImport:off - the sandbox is plain Node temp-directory handling.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import * as HostProcess from "../HostProcess.ts";
import { enterTestTempSandbox, sandboxParentFor } from "./testTempSandbox.ts";

it("moves only macOS's long per-user temp directory under /tmp", () => {
  const tmp = () => "/private/tmp";
  expect(sandboxParentFor("darwin", "/private/var/folders/ab/cd/T", tmp)).toBe("/private/tmp");
  expect(sandboxParentFor("darwin", "/var/folders/ab/cd/T/", tmp)).toBe("/private/tmp");
  // A directory a caller made inside the default is its choice too.
  expect(sandboxParentFor("darwin", "/private/var/folders/ab/cd/T/goat-ci-x", tmp)).toBe(
    "/private/var/folders/ab/cd/T/goat-ci-x",
  );
  // A TMPDIR the job chose stays, so its cleanup and leak check see the sandbox.
  expect(sandboxParentFor("darwin", "/Users/runner/work/_temp/goat-ci-x", tmp)).toBe(
    "/Users/runner/work/_temp/goat-ci-x",
  );
  expect(sandboxParentFor("linux", "/var/folders/ab/cd/T", tmp)).toBe("/var/folders/ab/cd/T");
  const missing = () => {
    throw new Error("ENOENT");
  };
  expect(sandboxParentFor("darwin", "/var/folders/ab/cd/T", missing)).toBe("/var/folders/ab/cd/T");
});

it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "reports goat-* leftovers, deletes the sandbox, and restores TMPDIR",
  () => {
    const before = process.env.TMPDIR;
    const sandbox = enterTestTempSandbox();
    if (sandbox === undefined) throw new Error("expected a sandbox on POSIX");

    expect(NodeOS.tmpdir()).toBe(sandbox.directory);
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-leaky-"));
    NodeFS.writeFileSync(NodePath.join(NodeOS.tmpdir(), "goat-file"), "");
    NodeFS.mkdirSync(NodePath.join(NodeOS.tmpdir(), "third-party-cache"));

    const leaked = sandbox.close();

    expect(leaked).toHaveLength(2);
    expect(leaked[0]).toBe("goat-file");
    expect(leaked[1]).toMatch(/^goat-leaky-/);
    expect(NodeFS.existsSync(sandbox.directory)).toBe(false);
    expect(process.env.TMPDIR).toBe(before);
  },
);
