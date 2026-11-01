// @effect-diagnostics nodeBuiltinImport:off - An electron-builder hook runs outside Effect.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** The packaged Linux executable. `goat` is the CLI, so the desktop binary must not take that name. */
export const LINUX_EXECUTABLE_NAME = "goat-desktop";
/** The executable name of Linux builds before the deb package became `goat`. */
export const LEGACY_LINUX_EXECUTABLE_NAME = "t3code"; // goat-rename: legacy: installed launch path.

interface PackContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
}

/**
 * electron-builder afterPack hook: links the old Linux executable name to the current one.
 * The link stays for good. After `dpkg -i` the deb updater relaunches the running build's
 * execPath, which is the old name for a build from before the rename, and CLI shims and per-user
 * desktop entries written by older builds point at that path too.
 */
export default async function linkLegacyLinuxExecutable(context: PackContext): Promise<void> {
  if (context.electronPlatformName !== "linux") return;
  const link = NodePath.join(context.appOutDir, LEGACY_LINUX_EXECUTABLE_NAME);
  await NodeFSP.rm(link, { force: true });
  await NodeFSP.symlink(LINUX_EXECUTABLE_NAME, link);
}
