// @effect-diagnostics nodeBuiltinImport:off - An electron-builder hook runs outside Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

/** Where build-desktop-artifact.ts tells this hook which signed helper it staged. */
export const COMPUTER_USE_HELPER_ENV = "GOAT_DESKTOP_STAGED_COMPUTER_USE_HELPER";

interface PackContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}

/**
 * electron-builder afterPack hook: puts the helper back exactly as it was signed, before GOAT.app
 * is signed around it. @electron/universal re-serializes every nested Info.plist when it merges
 * the slices, which breaks the helper's seal (#1340); for a single-arch build this replaces an
 * identical copy.
 */
export default async function restoreComputerUseHelper(context: PackContext): Promise<void> {
  const staged = process.env[COMPUTER_USE_HELPER_ENV];
  if (!staged || context.electronPlatformName !== "darwin") return;
  const target = NodePath.join(
    context.appOutDir,
    context.packager.appInfo.productFilename + ".app",
    "Contents",
    "Helpers",
    NodePath.basename(staged),
  );
  await NodeFSP.rm(target, { recursive: true, force: true });
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  // ditto keeps the bundle's signature, layout and modes.
  await NodeUtil.promisify(NodeChildProcess.execFile)("ditto", [staged, target]);
}
