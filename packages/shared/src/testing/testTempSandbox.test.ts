// @effect-diagnostics nodeBuiltinImport:off - the sandbox is plain Node temp-directory handling.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import * as HostProcess from "../HostProcess.ts";
import { enterTestTempSandbox } from "./testTempSandbox.ts";

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
