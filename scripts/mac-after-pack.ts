// @effect-diagnostics nodeBuiltinImport:off - An electron-builder hook runs outside Effect.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import Plist from "plist";
import restoreComputerUseHelper from "./restore-computer-use-helper.ts";

interface PackContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}

/**
 * electron-builder afterPack hook for macOS, before GOAT.app is signed. Electron's template
 * Info.plist asks for the camera, which GOAT never uses and release verification rejects, and
 * extendInfo can only add keys; then the staged computer use helper goes back in.
 */
export default async function macAfterPack(context: PackContext): Promise<void> {
  if (context.electronPlatformName === "darwin") {
    const info = NodePath.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Info.plist",
    );
    const plist = Plist.parse(await NodeFSP.readFile(info, "utf8"));
    if (typeof plist === "object" && plist !== null && "NSCameraUsageDescription" in plist) {
      const { NSCameraUsageDescription: _camera, ...rest } = plist as Record<
        string,
        Plist.PlistValue
      >;
      await NodeFSP.writeFile(info, Plist.build(rest));
    }
  }
  await restoreComputerUseHelper(context);
}
