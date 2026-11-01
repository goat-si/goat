// @effect-diagnostics nodeBuiltinImport:off - the assertion is about Node's temp env, outside Effect.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, expect, it } from "vite-plus/test";

import * as HostProcess from "../HostProcess.ts";
import { canonicalizeProcessTempDir } from "./longTempDir.ts";
import { symlinksSupported } from "./symlinks.ts";

const previousTmpDir = process.env.TMPDIR;
const created: string[] = [];

afterEach(() => {
  if (previousTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpDir;
  for (const path of created.splice(0)) {
    NodeFS.rmSync(path, { recursive: true, force: true });
  }
});

it.skipIf(!symlinksSupported || HostProcess.Platform.defaultValue() === "win32")(
  "points TMPDIR at the real path when the temp directory is a symlink",
  () => {
    const real = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "canon-real-"));
    const linkParent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "canon-link-"));
    created.push(real, linkParent);
    const link = NodePath.join(linkParent, "tmp");
    NodeFS.symlinkSync(real, link, "dir");

    process.env.TMPDIR = link;
    canonicalizeProcessTempDir();

    expect(NodeOS.tmpdir()).toBe(NodeFS.realpathSync.native(link));
    expect(NodeOS.tmpdir()).toBe(NodeFS.realpathSync.native(real));
  },
);
