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

// CI's check job runs these on every pull request. The audit cites files and symbols across the
// repository, so any code change can make docs/internals/agent-surface-audit.md stale.
export function agentSurfaceCheckSteps(
  files: ReadonlyArray<string>,
): Array<{ name: string; args: Array<string> }> {
  if (
    !files.some((file) => isChangedCode(file) || file === "docs/internals/agent-surface-audit.md")
  )
    return [];
  return [
    { name: "agent surface audit", args: ["run", "agent-surface:check"] },
    { name: "agent context budget", args: ["run", "agent-surface:context-budget-check"] },
  ];
}
