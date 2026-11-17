// @effect-diagnostics nodeBuiltinImport:off -- Runs before the CLI's Effect runtime loads.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";

export function enableCliCompileCache(): void {
  try {
    // SEA has no separate modules to cache.
    if (NodeSea.isSea()) return;
    const xdgCache = process.env.XDG_CACHE_HOME;
    // The XDG spec ignores a relative value; it would resolve against the launch folder.
    const cacheRoot =
      (xdgCache !== undefined && NodePath.isAbsolute(xdgCache) ? xdgCache : undefined) ||
      // oxlint-disable-next-line goat/no-global-process-runtime -- Runs before the CLI's Effect runtime loads.
      (process.platform === "linux" ? NodePath.join(NodeOS.homedir(), ".cache") : NodeOS.tmpdir());
    const directory = NodePath.join(cacheRoot, "goat", "compile-cache");
    if (process.env.APPIMAGE) {
      // A linked goat or compile-cache folder could lead the deletion anywhere.
      const real = (folder: string) => NodeFS.lstatSync(folder).isDirectory();
      if (!real(NodePath.dirname(directory)) || !real(directory)) return;
      // AppImage paths change each launch. Older shims cached anyway, filling Node's engine folders.
      for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && /^v\d/.test(entry.name)) {
          NodeFS.rmSync(NodePath.join(directory, entry.name), { recursive: true, force: true });
        }
      }
      return;
    }
    NodeModule.enableCompileCache(directory);
  } catch {}
}
