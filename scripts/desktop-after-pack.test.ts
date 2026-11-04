// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import desktopAfterPack from "./desktop-after-pack.ts";

it("keeps the legacy Linux executable link when preparing the server cache (#28572)", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-after-pack-"));
  try {
    await desktopAfterPack({
      appOutDir: directory,
      electronPlatformName: "linux",
      arch: -1,
      packager: { appInfo: { productFilename: "GOAT" }, executableName: "goat-desktop" },
    });
    expect(NodeFS.readlinkSync(NodePath.join(directory, "t3code"))).toBe("goat-desktop");
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
