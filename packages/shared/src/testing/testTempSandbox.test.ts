// @effect-diagnostics nodeBuiltinImport:off - the sandbox is plain Node temp-directory handling.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { resolveDesktopAppControlAddresses } from "../desktopAppControl.ts";
import { enterTestTempSandbox, sandboxParentFor } from "./testTempSandbox.ts";

const DARWIN_DEFAULT_TMPDIR = "/private/var/folders/07/pv7qpvg55cq8nn8k_8lnqklc0000gn/T";
const DARWIN_SYMLINK_TMPDIR = "/var/folders/07/pv7qpvg55cq8nn8k_8lnqklc0000gn/T/";

it("falls back to /tmp on macOS only when the inherited temp path would push Unix sockets past sun_path", () => {
  const tmp = () => "/private/tmp";
  expect(sandboxParentFor("darwin", DARWIN_DEFAULT_TMPDIR, tmp)).toBe("/private/tmp");
  expect(sandboxParentFor("darwin", DARWIN_SYMLINK_TMPDIR, tmp)).toBe("/private/tmp");
  expect(sandboxParentFor("darwin", `${DARWIN_DEFAULT_TMPDIR}/goat-ci-12345678`, tmp)).toBe(
    "/private/tmp",
  );
  // A short TMPDIR the caller or CI job chose stays, so its cleanup and leak check see the sandbox.
  expect(sandboxParentFor("darwin", "/private/tmp/goat-ci-12345678", tmp)).toBe(
    "/private/tmp/goat-ci-12345678",
  );
  expect(sandboxParentFor("darwin", "/Users/runner/work/_temp/goat-ci-x", tmp)).toBe(
    "/Users/runner/work/_temp/goat-ci-x",
  );
  expect(sandboxParentFor("darwin", "/private/var/folders/ab/cd/T", tmp)).toBe(
    "/private/var/folders/ab/cd/T",
  );
  expect(sandboxParentFor("linux", DARWIN_DEFAULT_TMPDIR, tmp)).toBe(DARWIN_DEFAULT_TMPDIR);
  expect(sandboxParentFor("win32", "C:\\Users\\runneradmin\\AppData\\Local\\Temp", tmp)).toBe(
    "C:\\Users\\runneradmin\\AppData\\Local\\Temp",
  );
  const missing = () => {
    throw new Error("ENOENT");
  };
  expect(sandboxParentFor("darwin", DARWIN_DEFAULT_TMPDIR, missing)).toBe(DARWIN_DEFAULT_TMPDIR);
});

it("keeps a macOS TMPDIR only when every app-control socket inside the sandbox fits sun_path", () => {
  const tmp = () => "/private/tmp";
  // Longest user keys the resolver can produce: a 10-digit UID and the 12-hex hash fallback.
  for (const userId of [4_294_967_295, undefined]) {
    for (let length = 14; length <= 80; length++) {
      const inherited = `/private/tmp/${"x".repeat(length - "/private/tmp/".length)}`;
      const parent = sandboxParentFor("darwin", inherited, tmp);
      if (parent !== inherited) continue;
      const sandbox = NodePath.posix.join(parent, "goat-test-XXXXXX");
      for (const { address } of resolveDesktopAppControlAddresses({
        stateDir: "/Users/someone/.goat/userdata",
        platform: "darwin",
        tempDir: sandbox,
        userId,
        joinPath: NodePath.posix.join,
      })) {
        expect(Buffer.byteLength(address)).toBeLessThanOrEqual(103);
      }
    }
  }
});

it("reports goat-* leftovers, deletes the sandbox, and restores os.tmpdir()", () => {
  const beforeTmpDir = process.env.TMPDIR;
  const beforeOsTmpDir = NodeOS.tmpdir();
  const sandbox = enterTestTempSandbox();

  expect(NodeOS.tmpdir()).toBe(sandbox.directory);
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-leaky-"));
  NodeFS.writeFileSync(NodePath.join(NodeOS.tmpdir(), "goat-file"), "");
  NodeFS.mkdirSync(NodePath.join(NodeOS.tmpdir(), "third-party-cache"));

  const leaked = sandbox.close();

  expect(leaked).toHaveLength(2);
  expect(leaked[0]).toBe("goat-file");
  expect(leaked[1]).toMatch(/^goat-leaky-/);
  expect(NodeFS.existsSync(sandbox.directory)).toBe(false);
  expect(process.env.TMPDIR).toBe(beforeTmpDir);
  expect(NodeOS.tmpdir()).toBe(beforeOsTmpDir);
});

it("honors a caller-provided short TMPDIR", () => {
  // oxlint-disable-next-line goat/no-global-process-runtime -- Matches testTempSandbox's direct NodeOS usage.
  const platform = NodeOS.platform();
  const baseParent =
    process.env.GOAT_TEST_PARENT_TMPDIR ??
    sandboxParentFor(platform, NodeOS.tmpdir(), () => NodeFS.realpathSync.native("/tmp"));
  const customParent = NodeFS.mkdtempSync(NodePath.join(baseParent, "custom-tmp-"));
  const beforeTmpDir = process.env.TMPDIR;
  const beforeTemp = process.env.TEMP;
  const beforeTmp = process.env.TMP;
  try {
    process.env.TMPDIR = customParent;
    if (platform === "win32") {
      process.env.TEMP = customParent;
      process.env.TMP = customParent;
    }
    const sandbox = enterTestTempSandbox();
    expect(NodePath.dirname(sandbox.directory)).toBe(customParent);
    expect(sandbox.close()).toEqual([]);
  } finally {
    if (beforeTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = beforeTmpDir;
    if (beforeTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = beforeTemp;
    if (beforeTmp === undefined) delete process.env.TMP;
    else process.env.TMP = beforeTmp;
    NodeFS.rmSync(customParent, { recursive: true, force: true });
  }
});

it("sets and restores TEMP, TMP, and TMPDIR on Windows", () => {
  const beforeTmpDir = process.env.TMPDIR;
  const beforeTemp = process.env.TEMP;
  const beforeTmp = process.env.TMP;
  const sandbox = enterTestTempSandbox("win32");
  try {
    expect(process.env.TMPDIR).toBe(sandbox.directory);
    expect(process.env.TEMP).toBe(sandbox.directory);
    expect(process.env.TMP).toBe(sandbox.directory);
  } finally {
    const leaked = sandbox.close();
    expect(leaked).toEqual([]);
  }
  expect(process.env.TMPDIR).toBe(beforeTmpDir);
  expect(process.env.TEMP).toBe(beforeTemp);
  expect(process.env.TMP).toBe(beforeTmp);
});
