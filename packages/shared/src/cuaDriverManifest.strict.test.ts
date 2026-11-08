// @effect-diagnostics nodeBuiltinImport:off -- The manifest is read from a real temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { prepareCuaDriverCapabilityManifest } from "./cuaDriverManifest.ts";

it("admits protected apps only when strict input guards are off", async ({ onTestFinished }) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cu-strict-manifest-"));
  onTestFinished(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  const listApplications = async () => [
    { bundle_id: "com.apple.TextEdit", name: "TextEdit" },
    { bundle_id: "com.1password.1password", name: "1Password" },
    { bundle_id: "si.goat.desktop", name: "GOAT" },
  ];
  const input = {
    binaryPath: "/nonexistent/cua-driver",
    platform: "darwin" as const,
    environment: {},
    hostBundleIds: ["si.goat.desktop"],
    path: NodePath.join(directory, "manifest.yaml"),
    listApplications,
  };
  const strict = await prepareCuaDriverCapabilityManifest(input);
  expect(NodeFS.readFileSync(strict, "utf8")).not.toContain("com.1password.1password");
  const allowed = await prepareCuaDriverCapabilityManifest({ ...input, includeProtected: true });
  const manifest = NodeFS.readFileSync(allowed, "utf8");
  expect(manifest).toContain("com.1password.1password");
  expect(manifest).toContain("com.apple.TextEdit");
  expect(manifest).not.toContain("si.goat.desktop");
});
