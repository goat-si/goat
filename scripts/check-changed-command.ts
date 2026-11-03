// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

export function vitePlusCommand(
  args: ReadonlyArray<string>,
  // oxlint-disable-next-line goat/no-global-process-runtime -- Standalone Node tooling has no Effect runtime; tests pass the platform explicitly.
  platform: NodeJS.Platform = process.platform,
): [command: string, args: Array<string>] {
  // Windows cannot spawn the package manager's vp.cmd shim without a shell.
  // Use Vite+'s exported JS entry with this Node instead, keeping paths and
  // arguments literal. Resolve here, not from the patch check's temporary cwd.
  if (platform === "win32") {
    return [
      process.execPath,
      [NodeURL.fileURLToPath(import.meta.resolve("vite-plus/bin")), ...args],
    ];
  }
  return ["vp", [...args]];
}

export function lintChangedArgs(files: ReadonlyArray<string>): Array<string> {
  return ["lint", "--no-error-on-unmatched-pattern", ...files];
}

export function isChangedCode(file: string): boolean {
  return /\.(?:[cm]?[jt]sx?|astro)$/.test(file);
}
