// @effect-diagnostics nodeBuiltinImport:off - Exercises an electron-builder hook on real files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import macAfterPack from "./mac-after-pack.ts";
import { macUsageDescriptionProblems } from "./verify-release-artifacts.ts";

// Electron's template Info.plist, as electron-builder leaves it after merging extendInfo.
const packedInfo = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>si.goat.desktop</string>
<key>NSCameraUsageDescription</key><string>This app needs access to the camera</string>
<key>NSMicrophoneUsageDescription</key><string>GOAT uses this Mac's microphone.</string>
</dict></plist>`;

it("a packed macOS app passes release verification's usage-description check after the hook", async () => {
  const appOutDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-mac-after-pack-"));
  const contents = NodePath.join(appOutDir, "GOAT.app", "Contents");
  NodeFS.mkdirSync(contents, { recursive: true });
  const info = NodePath.join(contents, "Info.plist");
  NodeFS.writeFileSync(info, packedInfo);
  expect(macUsageDescriptionProblems(packedInfo)).toEqual(["declares NSCameraUsageDescription"]);

  await macAfterPack({
    appOutDir,
    electronPlatformName: "darwin",
    packager: { appInfo: { productFilename: "GOAT" } },
  });

  const after = NodeFS.readFileSync(info, "utf8");
  expect(macUsageDescriptionProblems(after)).toEqual([]);
  expect(after).toContain("si.goat.desktop");
  NodeFS.rmSync(appOutDir, { recursive: true, force: true });
});
