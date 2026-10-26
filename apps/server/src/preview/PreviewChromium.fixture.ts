// @effect-diagnostics nodeBuiltinImport:off - locating Playwright's browser binary is a Node filesystem check.
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Whether chromium-headless-shell is installed, so live preview tests run instead of failing.
 * Linux CI installs the shell; a Mac checkout often has not.
 */
export const chromiumInstalled = (() => {
  try {
    const require = NodeModule.createRequire(import.meta.url);
    const packageRoot = NodePath.dirname(require.resolve("playwright-core/package.json"));
    const manifest = require(NodePath.join(packageRoot, "browsers.json")) as {
      browsers: ReadonlyArray<{ name: string; revision: string }>;
    };
    const revision = manifest.browsers.find(
      (browser) => browser.name === "chromium-headless-shell",
    )?.revision;
    if (revision === undefined) return false;
    const platform = HostProcess.Platform.defaultValue();
    const arch = HostProcess.Architecture.defaultValue();
    const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const registry =
      browsersPath === "0"
        ? NodePath.join(packageRoot, ".local-browsers")
        : browsersPath
          ? NodePath.resolve(process.env.INIT_CWD || process.cwd(), browsersPath)
          : NodePath.join(
              platform === "linux"
                ? process.env.XDG_CACHE_HOME || NodePath.join(NodeOS.homedir(), ".cache")
                : platform === "darwin"
                  ? NodePath.join(NodeOS.homedir(), "Library", "Caches")
                  : process.env.LOCALAPPDATA || NodePath.join(NodeOS.homedir(), "AppData", "Local"),
              "ms-playwright",
            );
    const directory = NodePath.join(registry, `chromium_headless_shell-${revision}`);
    const executable =
      platform === "win32"
        ? ["chrome-headless-shell-win64", "chrome-headless-shell.exe"]
        : platform === "darwin"
          ? [
              arch === "arm64"
                ? "chrome-headless-shell-mac-arm64"
                : "chrome-headless-shell-mac-x64",
              "chrome-headless-shell",
            ]
          : arch === "arm64"
            ? ["chrome-linux", "headless_shell"]
            : ["chrome-headless-shell-linux64", "chrome-headless-shell"];
    return NodeFS.existsSync(NodePath.join(directory, ...executable));
  } catch {
    return false;
  }
})();
